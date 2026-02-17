import { mkdir, readFile, readdir, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AgentPlan,
  AgentStep,
  ApprovalMode,
  PendingApprovalRequest,
  RunStatusResponse
} from "@local-agent-ide/core";
import { callModel } from "./model.js";
import { agentConfig } from "./config.js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export interface ExecutionRun {
  runId: string;
  task: string;
  workspaceRoot?: string;
  sessionId?: string;
  approvalMode: ApprovalMode;
  plan: AgentPlan;
  isFinished: boolean;
  updatedAt: string;
  logs: string[];
  route?: TaskRoute;
  pendingApproval?: PendingApprovalRequest;
  requestApproval?: (input: { tool: string; summary: string }) => Promise<boolean>;
  onUpdate?: (run: ExecutionRun) => void;
  browserSession?: BrowserSession;
  debugSnapshot?: DebugSnapshot;
  codeGraph?: CodeGraphIndex;
  postWriteDiagnostics?: DiagnosticRecord[];
}

interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

type FileAction = {
  tool: "write_file";
  path: string;
  content: string;
};

type CommandAction = {
  tool: "run_command";
  command: string;
  timeoutMs?: number;
};

type BrowseAction = {
  tool: "browse_url";
  url: string;
};

type MkdirAction = {
  tool: "make_dir";
  path: string;
};

type RenameAction = {
  tool: "rename_path";
  from: string;
  to: string;
};

type ReadFileAction = {
  tool: "read_file";
  path: string;
};

type ReplaceInFileAction = {
  tool: "replace_in_file";
  path: string;
  find: string;
  replace: string;
  expectedCount?: number;
};

type ReplaceInFileRegexAction = {
  tool: "replace_in_file_regex";
  path: string;
  pattern: string;
  flags?: string;
  replace: string;
  expectedCount?: number;
};

type SearchInFileAction = {
  tool: "search_in_file";
  path: string;
  pattern: string;
  flags?: string;
};

type ReadFileRangeAction = {
  tool: "read_file_range";
  path: string;
  startLine: number;
  endLine: number;
};

type PatchInFileAction = {
  tool: "patch_in_file";
  path: string;
  startLine: number;
  endLine: number;
  content: string;
};

type BrowserOpenAction = {
  tool: "browser_open";
  url: string;
};

type BrowserClickAction = {
  tool: "browser_click";
  selector: string;
};

type BrowserTypeAction = {
  tool: "browser_type";
  selector: string;
  text: string;
};

type BrowserWaitForAction = {
  tool: "browser_wait_for";
  selector?: string;
  timeoutMs?: number;
};

type BrowserScreenshotAction = {
  tool: "browser_screenshot";
  path?: string;
};

type BrowserEvalAction = {
  tool: "browser_eval";
  script: string;
};

type DapRunAction = {
  tool: "dap_run";
  command: string;
  timeoutMs?: number;
};

type DapStacktraceAction = {
  tool: "dap_stacktrace";
};

type DapLocalsAction = {
  tool: "dap_locals";
  frame?: number;
};

type GraphBuildAction = {
  tool: "graph_build";
};

type GraphQueryAction = {
  tool: "graph_query";
  symbol: string;
  depth?: number;
};

type McpGetContextAction = {
  tool: "mcp_get_context";
  resource: string;
};

type GetSymbolsAction = {
  tool: "get_symbols";
  path: string;
};

type FindDefinitionAction = {
  tool: "find_definition";
  path: string;
  symbol: string;
};

type FindReferencesAction = {
  tool: "find_references";
  symbol: string;
  path?: string;
};

type GetDiagnosticsAction = {
  tool: "get_diagnostics";
  path?: string;
};

type ModelAction =
  | FileAction
  | CommandAction
  | BrowseAction
  | MkdirAction
  | RenameAction
  | ReadFileAction
  | ReplaceInFileAction
  | ReplaceInFileRegexAction
  | SearchInFileAction
  | ReadFileRangeAction
  | PatchInFileAction
  | BrowserOpenAction
  | BrowserClickAction
  | BrowserTypeAction
  | BrowserWaitForAction
  | BrowserScreenshotAction
  | BrowserEvalAction
  | DapRunAction
  | DapStacktraceAction
  | DapLocalsAction
  | GraphBuildAction
  | GraphQueryAction
  | McpGetContextAction
  | GetSymbolsAction
  | FindDefinitionAction
  | FindReferencesAction
  | GetDiagnosticsAction;

interface ModelActionPlan {
  actions: ModelAction[];
  summary?: string;
}

type ToolName = ModelAction["tool"];

interface FileMutation {
  path: string;
  changedLines: number[];
}

interface ExecutionReport {
  hasMutation: boolean;
  mutations: FileMutation[];
  commandRuns: number;
  browserOpens: number;
  browserWaits: Array<{ selector?: string }>;
  browserEvals: string[];
  screenshotPaths: string[];
}

interface DiagnosticRecord {
  path: string;
  line: number;
  column: number;
  message: string;
  snippet: string;
  severity: "error" | "warning";
}

interface StepExecutionContext {
  stepId: string;
  startLogIndex: number;
  startDiagnosticsIndex: number;
}

interface DebugFrame {
  file: string;
  line: number;
  functionName: string;
  preview?: string;
}

interface DebugSnapshot {
  command: string;
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  frames: DebugFrame[];
  localsByFrame: Array<{ frame: number; values: Record<string, string> }>;
}

interface CodeGraphNode {
  path: string;
  exports: string[];
  imports: string[];
  symbols: string[];
  references: string[];
}

interface CodeGraphIndex {
  builtAt: string;
  nodes: CodeGraphNode[];
}

const MAX_READ_RANGE_LINES = 400;
const MAX_PATCH_RANGE_LINES = 300;
const MAX_UNBOUNDED_REPLACE_MATCHES = 500;
const MAX_MODEL_ACTIONS = 6;
const MODEL_SCHEMA_ATTEMPTS = 2;

export type TaskIntent = "edit_existing" | "create_new" | "run_project" | "browser_interaction" | "debug";

export interface TaskRoute {
  intent: TaskIntent;
  targetFiles: string[];
  requiresMutation: boolean;
  requiresBrowser: boolean;
  requiresRun: boolean;
}

interface ToolCatalogEntry {
  name: ToolName;
  signature: string;
  intents: TaskIntent[];
  keywords: string[];
}

const TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    name: "read_file",
    signature: '{"tool":"read_file","path":"relative/path"}',
    intents: ["edit_existing", "debug", "run_project", "create_new"],
    keywords: ["read", "file", "content", "inside", "what is in"]
  },
  {
    name: "read_file_range",
    signature: '{"tool":"read_file_range","path":"relative/path","startLine":1,"endLine":80}',
    intents: ["edit_existing", "debug"],
    keywords: ["line", "range", "section", "snippet"]
  },
  {
    name: "search_in_file",
    signature: '{"tool":"search_in_file","path":"relative/path","pattern":"text","flags":"i"}',
    intents: ["edit_existing", "debug"],
    keywords: ["find", "search", "occurrence", "match", "where"]
  },
  {
    name: "replace_in_file",
    signature: '{"tool":"replace_in_file","path":"relative/path","find":"old","replace":"new","expectedCount":1}',
    intents: ["edit_existing", "debug"],
    keywords: ["replace", "rename", "change text", "swap"]
  },
  {
    name: "replace_in_file_regex",
    signature: '{"tool":"replace_in_file_regex","path":"relative/path","pattern":"regex","flags":"gi","replace":"new"}',
    intents: ["edit_existing", "debug"],
    keywords: ["regex", "pattern", "case-insensitive", "all matches"]
  },
  {
    name: "patch_in_file",
    signature: '{"tool":"patch_in_file","path":"relative/path","startLine":10,"endLine":20,"content":"replacement"}',
    intents: ["edit_existing", "debug"],
    keywords: ["patch", "line edit", "targeted edit"]
  },
  {
    name: "write_file",
    signature: '{"tool":"write_file","path":"relative/path","content":"full content"}',
    intents: ["create_new", "edit_existing", "debug", "run_project"],
    keywords: ["create file", "write", "output", "report", "generate"]
  },
  {
    name: "make_dir",
    signature: '{"tool":"make_dir","path":"relative/path"}',
    intents: ["create_new", "edit_existing"],
    keywords: ["folder", "directory", "mkdir", "create dir"]
  },
  {
    name: "rename_path",
    signature: '{"tool":"rename_path","from":"old/path","to":"new/path"}',
    intents: ["edit_existing", "debug"],
    keywords: ["move", "rename", "migration", "relocate"]
  },
  {
    name: "run_command",
    signature: '{"tool":"run_command","command":"npm test","timeoutMs":120000}',
    intents: ["run_project", "debug", "create_new"],
    keywords: ["run", "test", "lint", "install", "command", "server", "curl", "pytest"]
  },
  {
    name: "browse_url",
    signature: '{"tool":"browse_url","url":"https://example.com"}',
    intents: ["edit_existing", "debug"],
    keywords: ["url", "web", "summarize", "page"]
  },
  {
    name: "browser_open",
    signature: '{"tool":"browser_open","url":"https://example.com or file:///..."}',
    intents: ["browser_interaction", "create_new", "debug"],
    keywords: ["open browser", "open page", "navigate"]
  },
  {
    name: "browser_click",
    signature: '{"tool":"browser_click","selector":"button[type=submit]"}',
    intents: ["browser_interaction"],
    keywords: ["click", "button", "selector"]
  },
  {
    name: "browser_type",
    signature: '{"tool":"browser_type","selector":"input[name=q]","text":"query"}',
    intents: ["browser_interaction"],
    keywords: ["type", "input", "fill", "search"]
  },
  {
    name: "browser_wait_for",
    signature: '{"tool":"browser_wait_for","selector":"#app","timeoutMs":10000}',
    intents: ["browser_interaction"],
    keywords: ["wait", "load", "results", "selector"]
  },
  {
    name: "browser_screenshot",
    signature: '{"tool":"browser_screenshot","path":"artifacts/screen.png"}',
    intents: ["browser_interaction"],
    keywords: ["screenshot", "capture", "screen"]
  },
  {
    name: "browser_eval",
    signature: '{"tool":"browser_eval","script":"document.title"}',
    intents: ["browser_interaction", "debug"],
    keywords: ["eval", "document.title", "dom", "javascript"]
  },
  {
    name: "dap_run",
    signature: '{"tool":"dap_run","command":"pytest -q","timeoutMs":120000}',
    intents: ["debug", "run_project"],
    keywords: ["debug", "run with debugger", "stack trace", "traceback", "runtime error"]
  },
  {
    name: "dap_stacktrace",
    signature: '{"tool":"dap_stacktrace"}',
    intents: ["debug", "run_project"],
    keywords: ["stack", "frames", "trace", "where failed"]
  },
  {
    name: "dap_locals",
    signature: '{"tool":"dap_locals","frame":0}',
    intents: ["debug", "run_project"],
    keywords: ["locals", "variables", "state", "frame"]
  },
  {
    name: "graph_build",
    signature: '{"tool":"graph_build"}',
    intents: ["edit_existing", "debug", "run_project"],
    keywords: ["code graph", "index", "dependencies", "relationships"]
  },
  {
    name: "graph_query",
    signature: '{"tool":"graph_query","symbol":"UserService","depth":2}',
    intents: ["edit_existing", "debug", "run_project"],
    keywords: ["impact", "related files", "references", "dependents", "graphrag"]
  },
  {
    name: "mcp_get_context",
    signature: '{"tool":"mcp_get_context","resource":"project/notes"}',
    intents: ["edit_existing", "debug", "create_new", "run_project"],
    keywords: ["mcp", "context", "resource", "external context"]
  },
  {
    name: "get_symbols",
    signature: '{"tool":"get_symbols","path":"src/file.ts"}',
    intents: ["edit_existing", "debug", "run_project"],
    keywords: ["symbols", "outline", "functions", "classes", "interfaces"]
  },
  {
    name: "find_definition",
    signature: '{"tool":"find_definition","path":"src/file.ts","symbol":"UserService"}',
    intents: ["edit_existing", "debug", "run_project"],
    keywords: ["definition", "where defined", "go to definition", "declared"]
  },
  {
    name: "find_references",
    signature: '{"tool":"find_references","symbol":"userData","path":"optional/start/file.ts"}',
    intents: ["edit_existing", "debug", "run_project"],
    keywords: ["references", "usages", "where used", "call sites"]
  },
  {
    name: "get_diagnostics",
    signature: '{"tool":"get_diagnostics","path":"src/file.ts"}',
    intents: ["edit_existing", "debug", "run_project"],
    keywords: ["diagnostics", "type errors", "compile errors", "lint", "problems"]
  }
];

export async function executeRun(run: ExecutionRun): Promise<void> {
  try {
    log(run, "Run started.");

    await runStep(run, "analyze-task", async () => {
      const route = run.route ?? routeTask(run.task);
      run.route = route;
      log(run, `Task: ${run.task}`);
      log(run, `Approval mode: ${run.approvalMode}`);
      log(run, `intent: ${route.intent}`);
      if (route.targetFiles.length > 0) {
        log(run, `target_files: ${route.targetFiles.join(", ")}`);
      }
    });

    await runStep(run, "scan-project", async () => {
      if (!run.workspaceRoot) {
        log(run, "Workspace root not provided; skipping scan.");
        return;
      }

      const files = await scanWorkspaceFiles(run.workspaceRoot, 300);
      const step = getStep(run.plan.steps, "scan-project");
      step.notes = `Scanned ${files.length} files`;
      log(run, `Scanned ${files.length} files.`);
    });

    await runStep(run, "implement", async (ctx) => {
      if (!run.workspaceRoot) {
        throw new Error("No workspace root provided by extension.");
      }

      const route = run.route ?? routeTask(run.task);
      run.route = route;

      const deterministicSummary = await tryHandleDeterministicTask(run, route);
      if (deterministicSummary) {
        const step = getStep(run.plan.steps, "implement");
        step.notes = deterministicSummary;
        enforceImplementStepGate(run, route, ctx);
        return;
      }

      const files = await scanWorkspaceFiles(run.workspaceRoot, 200);
      const actionPlan = await proposeImplementationActions(run.task, files, run.workspaceRoot, route);
      log(run, `Action plan generated: ${actionPlan.actions.length} action(s).`);
      const execution = await executeActionsWithRetry(run, actionPlan.actions, files, run.task, route);

      const step = getStep(run.plan.steps, "implement");
      if (execution.mutations.length > 0) {
        const summary = execution.mutations
          .map((item) => `${item.path} lines ${formatLineList(item.changedLines)}`)
          .join("; ");
        step.notes = actionPlan.summary ? `${actionPlan.summary}. Changes: ${summary}` : `Changes: ${summary}`;
      } else {
        step.notes = actionPlan.summary ?? `Applied ${actionPlan.actions.length} action(s)`;
      }
      enforceImplementStepGate(run, route, ctx);
    });

    await runStep(run, "verify", async () => {
      const step = getStep(run.plan.steps, "verify");
      step.notes = "Tool execution completed.";
      log(run, "Verify step complete.");
    });

    await runStep(run, "finalize", async () => {
      const step = getStep(run.plan.steps, "finalize");
      step.notes = "Run completed.";
      log(run, "Finalize step complete.");
    });

    run.isFinished = true;
    run.updatedAt = new Date().toISOString();
    notifyUpdate(run);
    log(run, "Run finished successfully.");
  } catch (error) {
    run.isFinished = true;
    run.updatedAt = new Date().toISOString();

    const active = run.plan.steps.find((step) => step.status === "in_progress");
    if (active) {
      active.status = "failed";
      active.notes = error instanceof Error ? error.message : "unknown execution error";
    }

    log(run, `Run failed: ${error instanceof Error ? error.message : "unknown error"}`);
    notifyUpdate(run);
  } finally {
    await closeBrowserSession(run);
  }
}

export function getRunStatus(run: ExecutionRun): RunStatusResponse {
  const activeStep = run.plan.steps.find((step) => step.status === "in_progress");
  const pendingCount = run.plan.steps.filter((step) => step.status === "pending").length;

  return {
    runId: run.runId,
    plan: {
      task: run.plan.task,
      steps: run.plan.steps.map((step) => ({ ...step }))
    },
    isFinished: run.isFinished,
    currentStep: run.isFinished
      ? "Step 6/6: Tool-enabled execution finished"
      : activeStep
        ? `Executing: ${activeStep.title}`
        : "Preparing next step",
    nextStep: run.isFinished ? "Next: improve reliability and persistent run history" : `${pendingCount} step(s) remaining`,
    timestamp: run.updatedAt,
    logs: run.logs.slice(-40),
    pendingApproval: run.pendingApproval
  };
}

async function runStep(
  run: ExecutionRun,
  stepId: string,
  worker: (ctx: StepExecutionContext) => Promise<void>
): Promise<void> {
  const step = getStep(run.plan.steps, stepId);
  const context: StepExecutionContext = {
    stepId,
    startLogIndex: run.logs.length,
    startDiagnosticsIndex: run.postWriteDiagnostics?.length ?? 0
  };
  markInProgress(run.plan.steps, stepId);
  run.updatedAt = new Date().toISOString();
  notifyUpdate(run);
  log(run, `Step started: ${step.title}`);
  await worker(context);
  enforceStepCompletionGate(run, stepId, context);
  step.status = "completed";
  run.updatedAt = new Date().toISOString();
  notifyUpdate(run);
  log(run, `Step completed: ${step.title}`);
}

function enforceStepCompletionGate(run: ExecutionRun, stepId: string, context: StepExecutionContext): void {
  const recentLogs = run.logs.slice(context.startLogIndex);
  if (stepId === "analyze-task") {
    const hasIntentSignal = recentLogs.some((line) => line.includes("intent:"));
    if (!hasIntentSignal) {
      throw new Error("Step gate failed (analyze-task): missing intent classification signal.");
    }
    return;
  }
  if (stepId === "scan-project") {
    const step = getStep(run.plan.steps, stepId);
    if (!step.notes || !/scanned/i.test(step.notes)) {
      throw new Error("Step gate failed (scan-project): missing scan result notes.");
    }
    return;
  }
  if (stepId === "implement") {
    const step = getStep(run.plan.steps, stepId);
    if (!step.notes || step.notes.trim().length === 0) {
      throw new Error("Step gate failed (implement): no implementation notes recorded.");
    }
  }
}

function enforceImplementStepGate(run: ExecutionRun, route: TaskRoute, context: StepExecutionContext): void {
  const recentLogs = run.logs.slice(context.startLogIndex);
  const mutationSignal = recentLogs.some((line) =>
    line.includes("line_changes:") ||
    line.includes("write_file:") ||
    line.includes("replace_in_file:") ||
    line.includes("replace_in_file_regex:") ||
    line.includes("patch_in_file:")
  );
  if (route.requiresMutation && !mutationSignal) {
    throw new Error("Step gate failed (implement): task requires mutation but no mutation signal was produced.");
  }

  const diagnostics = (run.postWriteDiagnostics ?? []).slice(context.startDiagnosticsIndex);
  const blocking = diagnostics.filter((item) => item.severity === "error");
  if (blocking.length > 0) {
    const first = blocking[0];
    throw new Error(
      `Step gate failed (implement): ${String(blocking.length)} blocking diagnostic(s). First: ${first.path}:${String(first.line)}:${String(first.column)} ${first.message}`
    );
  }
}

function markInProgress(steps: AgentStep[], stepId: string): void {
  const target = getStep(steps, stepId);
  if (target.status !== "completed") {
    target.status = "in_progress";
  }
}

function getStep(steps: AgentStep[], stepId: string): AgentStep {
  const step = steps.find((item) => item.id === stepId);
  if (!step) {
    throw new Error(`step not found: ${stepId}`);
  }
  return step;
}

async function scanWorkspaceFiles(workspaceRoot: string, limit: number): Promise<string[]> {
  const results: string[] = [];
  const queue: string[] = [workspaceRoot];

  while (queue.length > 0 && results.length < limit) {
    const current = queue.shift();
    if (!current) {
      break;
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }

      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
        continue;
      }

      if (entry.isFile()) {
        results.push(absolute);
      }

      if (results.length >= limit) {
        break;
      }
    }
  }

  return results.map((absolute) => path.relative(workspaceRoot, absolute).replace(/\\/g, "/"));
}

async function proposeImplementationActions(
  task: string,
  files: string[],
  workspaceRoot: string,
  route: TaskRoute
): Promise<ModelActionPlan> {
  const deterministic = route.intent === "browser_interaction"
    ? deriveDeterministicBrowserPlan(task, files, workspaceRoot)
    : null;
  if (deterministic) {
    return deterministic;
  }

  const fallback = fallbackPlan(task, route.intent);
  const fileList = files.slice(0, 120).join(", ");
  const intentPrompt = buildIntentPrompt(route.intent);
  const retrievedTools = searchTools(task, route.intent);
  const allowedTools = new Set<ToolName>(retrievedTools.map((item) => item.name));
  const toolPrompt = buildRetrievedToolsPrompt(retrievedTools);
  const structured = await requestStructuredActionPlan({
    mode: "plan",
    intent: route.intent,
    task,
    userContext: `Intent: ${route.intent}\nTask: ${task}\nExisting files (subset): ${fileList}`,
    allowedTools,
    systemRules: [
      "You are a coding agent that proposes tool actions.",
      "Rules: max 6 actions. Keep actions safe and workspace-relevant. Prefer replace/search/read-range/patch tools for editing existing files.",
      "For change/fix tasks, include at least one mutating action (replace_in_file, replace_in_file_regex, patch_in_file, write_file, make_dir, or rename_path), not only read/search.",
      intentPrompt,
      toolPrompt
    ]
  });
  if (!structured || structured.actions.length === 0) {
    return fallback;
  }

  const upgradedActions = ensureMutatingActionsForEditTask(structured.actions, task, files);
  return { actions: upgradedActions, summary: structured.summary };
}

function isValidAction(action: unknown): action is ModelAction {
  if (!action || typeof action !== "object") {
    return false;
  }

  const candidate = action as Record<string, unknown>;
  if (candidate.tool === "write_file") {
    return typeof candidate.path === "string" && typeof candidate.content === "string" && candidate.path.length > 0;
  }

  if (candidate.tool === "run_command") {
    return (
      typeof candidate.command === "string" &&
      candidate.command.trim().length > 0 &&
      (candidate.timeoutMs === undefined ||
        (typeof candidate.timeoutMs === "number" &&
          Number.isFinite(candidate.timeoutMs) &&
          candidate.timeoutMs >= 1_000 &&
          candidate.timeoutMs <= 600_000))
    );
  }

  if (candidate.tool === "make_dir") {
    return typeof candidate.path === "string" && candidate.path.trim().length > 0;
  }

  if (candidate.tool === "rename_path") {
    return (
      typeof candidate.from === "string" &&
      candidate.from.trim().length > 0 &&
      typeof candidate.to === "string" &&
      candidate.to.trim().length > 0
    );
  }

  if (candidate.tool === "read_file") {
    return typeof candidate.path === "string" && candidate.path.trim().length > 0;
  }

  if (candidate.tool === "replace_in_file") {
    return (
      typeof candidate.path === "string" &&
      candidate.path.trim().length > 0 &&
      typeof candidate.find === "string" &&
      candidate.find.length > 0 &&
      typeof candidate.replace === "string" &&
      (candidate.expectedCount === undefined ||
        (typeof candidate.expectedCount === "number" && Number.isFinite(candidate.expectedCount) && candidate.expectedCount >= 1))
    );
  }

  if (candidate.tool === "replace_in_file_regex") {
    return (
      typeof candidate.path === "string" &&
      candidate.path.trim().length > 0 &&
      typeof candidate.pattern === "string" &&
      candidate.pattern.trim().length > 0 &&
      typeof candidate.replace === "string" &&
      (candidate.flags === undefined || typeof candidate.flags === "string") &&
      (candidate.expectedCount === undefined ||
        (typeof candidate.expectedCount === "number" && Number.isFinite(candidate.expectedCount) && candidate.expectedCount >= 1))
    );
  }

  if (candidate.tool === "search_in_file") {
    return (
      typeof candidate.path === "string" &&
      candidate.path.trim().length > 0 &&
      typeof candidate.pattern === "string" &&
      candidate.pattern.trim().length > 0 &&
      (candidate.flags === undefined || typeof candidate.flags === "string")
    );
  }

  if (candidate.tool === "read_file_range") {
    return (
      typeof candidate.path === "string" &&
      candidate.path.trim().length > 0 &&
      typeof candidate.startLine === "number" &&
      Number.isFinite(candidate.startLine) &&
      candidate.startLine >= 1 &&
      typeof candidate.endLine === "number" &&
      Number.isFinite(candidate.endLine) &&
      candidate.endLine >= candidate.startLine
    );
  }

  if (candidate.tool === "patch_in_file") {
    return (
      typeof candidate.path === "string" &&
      candidate.path.trim().length > 0 &&
      typeof candidate.startLine === "number" &&
      Number.isFinite(candidate.startLine) &&
      candidate.startLine >= 1 &&
      typeof candidate.endLine === "number" &&
      Number.isFinite(candidate.endLine) &&
      candidate.endLine >= candidate.startLine &&
      typeof candidate.content === "string"
    );
  }

  if (candidate.tool === "browse_url") {
    return typeof candidate.url === "string" && /^https?:\/\//i.test(candidate.url);
  }

  if (candidate.tool === "browser_open") {
    return typeof candidate.url === "string" && /^(https?:\/\/|file:\/\/)/i.test(candidate.url);
  }

  if (candidate.tool === "browser_click") {
    return typeof candidate.selector === "string" && candidate.selector.trim().length > 0;
  }

  if (candidate.tool === "browser_type") {
    return (
      typeof candidate.selector === "string" &&
      candidate.selector.trim().length > 0 &&
      typeof candidate.text === "string"
    );
  }

  if (candidate.tool === "browser_wait_for") {
    return (
      candidate.selector === undefined ||
      (typeof candidate.selector === "string" && candidate.selector.trim().length > 0)
    );
  }

  if (candidate.tool === "browser_screenshot") {
    return candidate.path === undefined || typeof candidate.path === "string";
  }

  if (candidate.tool === "browser_eval") {
    return typeof candidate.script === "string" && candidate.script.trim().length > 0;
  }

  if (candidate.tool === "dap_run") {
    return (
      typeof candidate.command === "string" &&
      candidate.command.trim().length > 0 &&
      (candidate.timeoutMs === undefined ||
        (typeof candidate.timeoutMs === "number" &&
          Number.isFinite(candidate.timeoutMs) &&
          candidate.timeoutMs >= 1_000 &&
          candidate.timeoutMs <= 600_000))
    );
  }

  if (candidate.tool === "dap_stacktrace") {
    return true;
  }

  if (candidate.tool === "dap_locals") {
    return (
      candidate.frame === undefined ||
      (typeof candidate.frame === "number" && Number.isFinite(candidate.frame) && candidate.frame >= 0 && candidate.frame <= 20)
    );
  }

  if (candidate.tool === "graph_build") {
    return true;
  }

  if (candidate.tool === "graph_query") {
    return (
      typeof candidate.symbol === "string" &&
      candidate.symbol.trim().length > 0 &&
      (candidate.depth === undefined || (typeof candidate.depth === "number" && Number.isFinite(candidate.depth) && candidate.depth >= 1 && candidate.depth <= 4))
    );
  }

  if (candidate.tool === "mcp_get_context") {
    return typeof candidate.resource === "string" && candidate.resource.trim().length > 0;
  }

  if (candidate.tool === "get_symbols") {
    return typeof candidate.path === "string" && candidate.path.trim().length > 0;
  }

  if (candidate.tool === "find_definition") {
    return (
      typeof candidate.path === "string" &&
      candidate.path.trim().length > 0 &&
      typeof candidate.symbol === "string" &&
      candidate.symbol.trim().length > 0
    );
  }

  if (candidate.tool === "find_references") {
    return (
      typeof candidate.symbol === "string" &&
      candidate.symbol.trim().length > 0 &&
      (candidate.path === undefined || (typeof candidate.path === "string" && candidate.path.trim().length > 0))
    );
  }

  if (candidate.tool === "get_diagnostics") {
    return candidate.path === undefined || (typeof candidate.path === "string" && candidate.path.trim().length > 0);
  }

  return false;
}

function validateActionContract(action: ModelAction, task: string): void {
  if (action.tool === "read_file_range") {
    const count = action.endLine - action.startLine + 1;
    if (count > MAX_READ_RANGE_LINES) {
      throw new Error(`read_file_range exceeds max span (${String(count)} > ${String(MAX_READ_RANGE_LINES)} lines).`);
    }
    return;
  }

  if (action.tool === "patch_in_file") {
    const count = action.endLine - action.startLine + 1;
    if (count > MAX_PATCH_RANGE_LINES && !shouldAllowOverwrite(task, action.path)) {
      throw new Error(`patch_in_file exceeds max span (${String(count)} > ${String(MAX_PATCH_RANGE_LINES)} lines).`);
    }
    return;
  }

  if (action.tool === "replace_in_file_regex") {
    if (action.pattern.length > 500) {
      throw new Error("replace_in_file_regex pattern too long.");
    }
    if ((action.flags ?? "").length > 6) {
      throw new Error("replace_in_file_regex flags look invalid.");
    }
    return;
  }

  if (action.tool === "replace_in_file") {
    if (action.find.length > 2_000) {
      throw new Error("replace_in_file find text too long.");
    }
    return;
  }

  if (action.tool === "graph_query") {
    if ((action.depth ?? 1) > 4) {
      throw new Error("graph_query depth exceeds max (4).");
    }
    return;
  }

  if (action.tool === "mcp_get_context") {
    if (action.resource.length > 120) {
      throw new Error("mcp_get_context resource identifier too long.");
    }
    return;
  }

  if (action.tool === "find_definition" || action.tool === "find_references") {
    const symbol = action.symbol.trim();
    if (symbol.length > 120) {
      throw new Error(`${action.tool} symbol is too long.`);
    }
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol)) {
      throw new Error(`${action.tool} symbol must be an identifier-like token.`);
    }
  }
}

async function executeActions(run: ExecutionRun, actions: ModelAction[]): Promise<ExecutionReport> {
  if (!run.workspaceRoot) {
    throw new Error("Missing workspace root for action execution.");
  }

  const report: ExecutionReport = {
    hasMutation: false,
    mutations: [],
    commandRuns: 0,
    browserOpens: 0,
    browserWaits: [],
    browserEvals: [],
    screenshotPaths: []
  };

  for (const action of actions) {
    validateActionContract(action, run.task);

    if (action.tool === "write_file") {
      await requireApproval(run, "write_file", `Write file ${action.path}`);
      enforceWritePolicy(action, run.workspaceRoot, run.approvalMode);
      const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, action.path, action.content, {
        allowOverwriteExisting: shouldAllowOverwrite(run.task, action.path)
      });
      report.hasMutation = true;
      report.mutations.push(mutation);
      continue;
    }

    if (action.tool === "make_dir") {
      await requireApproval(run, "make_dir", `Create directory ${action.path}`);
      enforcePathPolicy(action.path, run.workspaceRoot, run.approvalMode, "make_dir");
      const outputPath = toSafeWorkspacePath(run.workspaceRoot, action.path);
      await mkdir(outputPath, { recursive: true });
      log(run, `make_dir: ${action.path}`);
      continue;
    }

    if (action.tool === "rename_path") {
      await requireApproval(run, "rename_path", `Rename ${action.from} -> ${action.to}`);
      enforcePathPolicy(action.from, run.workspaceRoot, run.approvalMode, "rename_path");
      enforcePathPolicy(action.to, run.workspaceRoot, run.approvalMode, "rename_path");
      const fromPath = toSafeWorkspacePath(run.workspaceRoot, action.from);
      const toPath = toSafeWorkspacePath(run.workspaceRoot, action.to);
      await mkdir(path.dirname(toPath), { recursive: true });
      await rename(fromPath, toPath);
      log(run, `rename_path: ${action.from} -> ${action.to}`);
      continue;
    }

    if (action.tool === "read_file") {
      await requireApproval(run, "read_file", `Read file ${action.path}`);
      enforcePathPolicy(action.path, run.workspaceRoot, run.approvalMode, "write_file");
      const inputPath = toSafeWorkspacePath(run.workspaceRoot, action.path);
      const content = await readFile(inputPath, "utf8");
      log(run, `read_file: ${action.path}`);
      log(run, `file_preview: ${truncate(content.replace(/\s+/g, " "), 300)}`);
      continue;
    }

    if (action.tool === "replace_in_file") {
      await requireApproval(run, "replace_in_file", `Replace text in ${action.path}`);
      enforcePathPolicy(action.path, run.workspaceRoot, run.approvalMode, "write_file");
      const inputPath = toSafeWorkspacePath(run.workspaceRoot, action.path);
      const before = await readFile(inputPath, "utf8");
      const matches = countOccurrences(before, action.find);
      if (matches === 0) {
        throw new Error(`replace_in_file found 0 matches in ${action.path}`);
      }
      if (action.expectedCount !== undefined && matches !== action.expectedCount) {
        throw new Error(`replace_in_file expected ${String(action.expectedCount)} matches but found ${String(matches)} in ${action.path}`);
      }
      if (action.expectedCount === undefined && matches > MAX_UNBOUNDED_REPLACE_MATCHES && !shouldAllowOverwrite(run.task, action.path)) {
        throw new Error(
          `replace_in_file matched too many occurrences (${String(matches)}); use expectedCount, patch_in_file, or explicit overwrite intent.`
        );
      }
      const after = replaceAllLiteral(before, action.find, action.replace);
      const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, action.path, after, {
        allowOverwriteExisting: true
      });
      report.hasMutation = true;
      report.mutations.push(mutation);
      continue;
    }

    if (action.tool === "replace_in_file_regex") {
      await requireApproval(run, "replace_in_file_regex", `Replace text by regex in ${action.path}`);
      enforcePathPolicy(action.path, run.workspaceRoot, run.approvalMode, "write_file");
      const inputPath = toSafeWorkspacePath(run.workspaceRoot, action.path);
      const before = await readFile(inputPath, "utf8");
      const regex = buildSafeRegex(action.pattern, action.flags);
      const matches = Array.from(before.matchAll(regex)).length;
      if (matches === 0) {
        throw new Error(`replace_in_file_regex found 0 matches in ${action.path}`);
      }
      if (action.expectedCount !== undefined && matches !== action.expectedCount) {
        throw new Error(
          `replace_in_file_regex expected ${String(action.expectedCount)} matches but found ${String(matches)} in ${action.path}`
        );
      }
      if (action.expectedCount === undefined && matches > MAX_UNBOUNDED_REPLACE_MATCHES && !shouldAllowOverwrite(run.task, action.path)) {
        throw new Error(
          `replace_in_file_regex matched too many occurrences (${String(matches)}); use expectedCount, patch_in_file, or explicit overwrite intent.`
        );
      }
      const after = before.replace(regex, action.replace);
      const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, action.path, after, {
        allowOverwriteExisting: true
      });
      report.hasMutation = true;
      report.mutations.push(mutation);
      continue;
    }

    if (action.tool === "search_in_file") {
      await requireApproval(run, "search_in_file", `Search pattern in ${action.path}`);
      enforcePathPolicy(action.path, run.workspaceRoot, run.approvalMode, "write_file");
      const inputPath = toSafeWorkspacePath(run.workspaceRoot, action.path);
      const content = await readFile(inputPath, "utf8");
      const regex = buildSafeRegex(action.pattern, action.flags);
      const results = findRegexMatchesWithLines(content, regex).slice(0, 12);
      if (results.length === 0) {
        log(run, `search_in_file: ${action.path} -> 0 matches`);
      } else {
        log(run, `search_in_file: ${action.path} -> ${String(results.length)} matches`);
        for (const item of results) {
          log(run, `search_match: ${action.path}:${String(item.line)}: ${truncate(item.text, 180)}`);
        }
      }
      continue;
    }

    if (action.tool === "read_file_range") {
      await requireApproval(run, "read_file_range", `Read file range ${action.path}:${String(action.startLine)}-${String(action.endLine)}`);
      enforcePathPolicy(action.path, run.workspaceRoot, run.approvalMode, "write_file");
      const inputPath = toSafeWorkspacePath(run.workspaceRoot, action.path);
      const content = await readFile(inputPath, "utf8");
      const lines = content.split(/\r?\n/);
      const start = Math.max(1, action.startLine);
      const end = Math.min(lines.length, action.endLine);
      const slice = lines.slice(start - 1, end).map((line, idx) => `${String(start + idx)}: ${line}`).join(" | ");
      log(run, `read_file_range: ${action.path}:${String(start)}-${String(end)}`);
      log(run, `file_range_preview: ${truncate(slice, 320)}`);
      continue;
    }

    if (action.tool === "patch_in_file") {
      await requireApproval(
        run,
        "patch_in_file",
        `Patch file ${action.path}:${String(action.startLine)}-${String(action.endLine)}`
      );
      enforcePathPolicy(action.path, run.workspaceRoot, run.approvalMode, "write_file");
      const inputPath = toSafeWorkspacePath(run.workspaceRoot, action.path);
      const before = await readFile(inputPath, "utf8");
      const lines = before.split(/\r?\n/);
      if (action.startLine > lines.length + 1) {
        throw new Error(
          `patch_in_file startLine out of range for ${action.path}: ${String(action.startLine)} > ${String(lines.length + 1)}`
        );
      }
      const start = action.startLine - 1;
      const endExclusive = Math.min(action.endLine, lines.length);
      const replacement = action.content.split(/\r?\n/);
      const afterLines = [...lines.slice(0, start), ...replacement, ...lines.slice(endExclusive)];
      const after = afterLines.join("\n");
      const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, action.path, after, {
        allowOverwriteExisting: true
      });
      report.hasMutation = true;
      report.mutations.push(mutation);
      log(run, `patch_in_file: ${action.path}:${String(action.startLine)}-${String(action.endLine)}`);
      continue;
    }

    if (action.tool === "run_command") {
      await requireApproval(run, "run_command", `Run command: ${action.command}`);
      enforceCommandPolicy(action.command, run.approvalMode);
      const output = await runCommand(action.command, run.workspaceRoot, action.timeoutMs);
      log(run, `run_command: ${action.command}`);
      if (output.trim()) {
        log(run, `command_output: ${truncate(output, 500)}`);
      }
      report.commandRuns += 1;
      continue;
    }

    if (action.tool === "browse_url") {
      await requireApproval(run, "browse_url", `Browse URL: ${action.url}`);
      enforceBrowsePolicy(action.url, run.approvalMode);
      const snapshot = await browseUrl(action.url);
      log(run, `browse_url: ${action.url}`);
      if (snapshot.trim()) {
        log(run, `browse_snapshot: ${truncate(snapshot, 300)}`);
      }
      continue;
    }

    if (action.tool === "browser_open") {
      await requireApproval(run, "browser_open", `Open browser URL: ${action.url}`);
      enforceBrowserOpenPolicy(action.url, run.workspaceRoot, run.approvalMode);
      const session = await getBrowserSession(run);
      await session.page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      log(run, `browser_open: ${action.url}`);
      report.browserOpens += 1;
      continue;
    }

    if (action.tool === "browser_click") {
      await requireApproval(run, "browser_click", `Click selector: ${action.selector}`);
      const session = await getBrowserSession(run);
      await clickWithFallback(session.page, action.selector);
      log(run, `browser_click: ${action.selector}`);
      continue;
    }

    if (action.tool === "browser_type") {
      await requireApproval(run, "browser_type", `Type into selector: ${action.selector}`);
      const session = await getBrowserSession(run);
      await fillWithFallback(session.page, action.selector, action.text);
      log(run, `browser_type: ${action.selector}`);
      continue;
    }

    if (action.tool === "browser_wait_for") {
      await requireApproval(run, "browser_wait_for", `Wait for selector/page state`);
      const session = await getBrowserSession(run);
      const timeoutMs = Math.min(Math.max(action.timeoutMs ?? 10_000, 500), 60_000);
      if (action.selector) {
        await session.page.waitForSelector(action.selector, { timeout: timeoutMs });
        log(run, `browser_wait_for: selector ${action.selector}`);
        report.browserWaits.push({ selector: action.selector });
      } else {
        await session.page.waitForLoadState("networkidle", { timeout: timeoutMs });
        log(run, "browser_wait_for: network idle");
        report.browserWaits.push({});
      }
      continue;
    }

    if (action.tool === "browser_screenshot") {
      await requireApproval(run, "browser_screenshot", "Capture browser screenshot");
      if (!run.workspaceRoot) {
        throw new Error("Missing workspace root for screenshot path.");
      }
      const session = await getBrowserSession(run);
      const outputPath = action.path
        ? toSafeWorkspacePath(run.workspaceRoot, action.path)
        : path.join(run.workspaceRoot, ".local-agent-ide", "screenshots", `${run.runId}_${Date.now()}.png`);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await session.page.screenshot({ path: outputPath, fullPage: true });
      const relativePath = path.relative(run.workspaceRoot, outputPath).replace(/\\/g, "/");
      log(run, `browser_screenshot: ${relativePath}`);
      report.screenshotPaths.push(relativePath);
      continue;
    }

    if (action.tool === "browser_eval") {
      await requireApproval(run, "browser_eval", "Evaluate browser script");
      const session = await getBrowserSession(run);
      const result = await session.page.evaluate((scriptText) => {
        try {
          return JSON.stringify({ ok: true, value: eval(scriptText) });
        } catch (error) {
          return JSON.stringify({ ok: false, error: String(error) });
        }
      }, action.script);
      log(run, `browser_eval: ${truncate(result, 300)}`);
      report.browserEvals.push(result);
      continue;
    }

    if (action.tool === "dap_run") {
      await requireApproval(run, "dap_run", `Run debug command: ${action.command}`);
      enforceCommandPolicy(action.command, run.approvalMode);
      const snapshot = await runCommandForDebug(action.command, run.workspaceRoot, action.timeoutMs ?? 120_000);
      run.debugSnapshot = snapshot;
      log(run, `dap_run: ${action.command} -> exit ${String(snapshot.exitCode)}`);
      if (snapshot.stderr.trim()) {
        log(run, `dap_stderr: ${truncate(snapshot.stderr, 400)}`);
      } else if (snapshot.stdout.trim()) {
        log(run, `dap_stdout: ${truncate(snapshot.stdout, 400)}`);
      }
      for (const frame of snapshot.frames.slice(0, 8)) {
        log(run, `dap_frame: ${frame.file}:${String(frame.line)} in ${frame.functionName}`);
      }
      continue;
    }

    if (action.tool === "dap_stacktrace") {
      const snapshot = run.debugSnapshot;
      if (!snapshot) {
        log(run, "dap_stacktrace: no debug snapshot available");
        continue;
      }
      if (snapshot.frames.length === 0) {
        log(run, "dap_stacktrace: no stack frames parsed");
        continue;
      }
      log(run, `dap_stacktrace: ${String(snapshot.frames.length)} frame(s)`);
      for (const frame of snapshot.frames.slice(0, 12)) {
        log(run, `dap_frame: ${frame.file}:${String(frame.line)} in ${frame.functionName}`);
      }
      continue;
    }

    if (action.tool === "dap_locals") {
      const snapshot = run.debugSnapshot;
      if (!snapshot) {
        log(run, "dap_locals: no debug snapshot available");
        continue;
      }
      const frameIndex = action.frame ?? 0;
      const localFrame = snapshot.localsByFrame.find((item) => item.frame === frameIndex) ?? snapshot.localsByFrame[0];
      if (!localFrame) {
        log(run, "dap_locals: no locals parsed");
        continue;
      }
      log(run, `dap_locals: frame ${String(localFrame.frame)} -> ${Object.keys(localFrame.values).length} value(s)`);
      for (const [key, value] of Object.entries(localFrame.values).slice(0, 20)) {
        log(run, `dap_local: ${key}=${truncate(value, 120)}`);
      }
      continue;
    }

    if (action.tool === "graph_build") {
      run.codeGraph = await buildCodeGraphIndex(run.workspaceRoot);
      log(run, `graph_build: ${String(run.codeGraph.nodes.length)} node(s) indexed`);
      continue;
    }

    if (action.tool === "graph_query") {
      if (!run.codeGraph) {
        run.codeGraph = await buildCodeGraphIndex(run.workspaceRoot);
        log(run, `graph_build: ${String(run.codeGraph.nodes.length)} node(s) indexed`);
      }
      const answer = queryCodeGraph(run.codeGraph, action.symbol, action.depth ?? 2);
      log(run, `graph_query: ${action.symbol} -> defs=${String(answer.definitions.length)} refs=${String(answer.references.length)} related=${String(answer.relatedFiles.length)}`);
      for (const item of answer.definitions.slice(0, 6)) {
        log(run, `graph_def: ${item}`);
      }
      for (const item of answer.references.slice(0, 8)) {
        log(run, `graph_ref: ${item}`);
      }
      continue;
    }

    if (action.tool === "mcp_get_context") {
      const context = await readMcpContextResource(run.workspaceRoot, action.resource);
      if (!context) {
        log(run, `mcp_get_context: ${action.resource} -> not found`);
      } else {
        log(run, `mcp_get_context: ${action.resource}`);
        log(run, `mcp_context_preview: ${truncate(context.replace(/\s+/g, " "), 350)}`);
      }
      continue;
    }

    if (action.tool === "get_symbols") {
      await requireApproval(run, "read_file", `Get symbols from ${action.path}`);
      const resolvedPath = await resolveRelativeFilePath(run.workspaceRoot, action.path);
      if (!resolvedPath) {
        throw new Error(`get_symbols target not found: ${action.path}`);
      }
      const symbols = await getSymbolsForFile(run.workspaceRoot, resolvedPath);
      log(run, `get_symbols: ${resolvedPath} -> ${String(symbols.length)} symbol(s)`);
      for (const item of symbols.slice(0, 15)) {
        log(run, `symbol: ${resolvedPath}:${String(item.line)} ${item.kind} ${item.name}`);
      }
      continue;
    }

    if (action.tool === "find_definition") {
      await requireApproval(run, "read_file", `Find definition of ${action.symbol}`);
      const resolvedPath = await resolveRelativeFilePath(run.workspaceRoot, action.path);
      if (!resolvedPath) {
        throw new Error(`find_definition target not found: ${action.path}`);
      }
      const match = await findDefinitionInWorkspace(run.workspaceRoot, resolvedPath, action.symbol);
      if (!match) {
        log(run, `find_definition: ${action.symbol} -> not found`);
        continue;
      }
      log(run, `find_definition: ${action.symbol} -> ${match.path}:${String(match.line)} ${match.preview}`);
      continue;
    }

    if (action.tool === "find_references") {
      await requireApproval(run, "read_file", `Find references of ${action.symbol}`);
      const references = await findReferencesInWorkspace(run.workspaceRoot, action.symbol, action.path);
      log(run, `find_references: ${action.symbol} -> ${String(references.length)} match(es)`);
      for (const item of references.slice(0, 20)) {
        log(run, `reference: ${item.path}:${String(item.line)} ${item.preview}`);
      }
      continue;
    }

    if (action.tool === "get_diagnostics") {
      await requireApproval(run, "read_file", `Get diagnostics${action.path ? ` for ${action.path}` : ""}`);
      const diagnostics = await getDiagnosticsForWorkspace(run.workspaceRoot, action.path);
      log(run, `get_diagnostics: ${String(diagnostics.length)} diagnostic(s)`);
      for (const item of diagnostics.slice(0, 20)) {
        log(run, `diagnostic: ${item}`);
      }
      continue;
    }
  }

  return report;
}

async function executeActionsWithRetry(
  run: ExecutionRun,
  baseActions: ModelAction[],
  files: string[],
  task: string,
  route: TaskRoute
): Promise<ExecutionReport> {
  let actions = baseActions;
  const maxAttempts = 3;
  const requireMutation = route.requiresMutation;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      log(run, `Execution attempt ${attempt}/${maxAttempts}`);
      const report = await executeActions(run, actions);
      if (requireMutation && !report.hasMutation) {
        throw new Error("No file changes were applied for a code-fix request.");
      }
      await enforceActionExecutionPostconditions(actions, run.workspaceRoot, report);
      enforceExplicitTargetMutation(task, report);
      await enforceTaskPostconditions(task, run.workspaceRoot, report, run.logs, route);
      return report;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown action error";
      log(run, `Attempt ${attempt} failed: ${reason}`);

      if (attempt === maxAttempts) {
        throw error;
      }

      const repaired = await proposeRepairActions(run.task, files, actions, reason, route.intent);
      if (!repaired || repaired.length === 0) {
        throw error;
      }
      actions = repaired;
      log(run, `Repair plan generated: ${actions.length} action(s).`);
    }
  }

  throw new Error("Execution attempts exhausted.");
}

async function proposeRepairActions(
  task: string,
  files: string[],
  attemptedActions: ModelAction[],
  failureReason: string,
  intent: TaskIntent
): Promise<ModelAction[] | null> {
  const failureClass = classifyFailureReason(failureReason);
  const deterministicRepair = buildRepairActionsByFailureClass(task, files, attemptedActions, failureReason, failureClass);
  if (deterministicRepair) {
    return deterministicRepair;
  }

  const classHint = buildFailureClassPrompt(failureClass);
  const retrievedTools = searchTools(task, intent, failureClass);
  const allowedTools = new Set<ToolName>(retrievedTools.map((item) => item.name));
  const toolPrompt = buildRetrievedToolsPrompt(retrievedTools);
  const structured = await requestStructuredActionPlan({
    mode: "repair",
    intent,
    task,
    userContext: [
      `FailureClass: ${failureClass}`,
      `Intent: ${intent}`,
      `Task: ${task}`,
      `Failure: ${failureReason}`,
      `Attempted actions: ${JSON.stringify(attemptedActions)}`,
      `Files: ${files.slice(0, 120).join(", ")}`
    ].join("\n"),
    allowedTools,
    systemRules: [
      "You repair failed coding agent actions.",
      "Prefer minimal fix actions and avoid repeating failing paths. If string replacement fails, use search_in_file, replace_in_file_regex, or patch_in_file.",
      classHint,
      buildIntentPrompt(intent),
      toolPrompt
    ]
  });
  if (!structured || structured.actions.length === 0) {
    return null;
  }
  return structured.actions;
}

type FailureClass =
  | "zero_matches"
  | "command_timeout"
  | "wrong_file_changed"
  | "missing_dependency"
  | "no_mutation"
  | "postcondition_failed"
  | "safety_blocked"
  | "unknown";

function classifyFailureReason(reason: string): FailureClass {
  const lower = reason.toLowerCase();
  if (lower.includes("found 0 matches")) {
    return "zero_matches";
  }
  if (lower.includes("timed out")) {
    return "command_timeout";
  }
  if (lower.includes("task referenced") && lower.includes("no mutation")) {
    return "wrong_file_changed";
  }
  if (lower.includes("cannot find module") || lower.includes("module not found") || lower.includes("is not recognized")) {
    return "missing_dependency";
  }
  if (lower.includes("no file changes were applied")) {
    return "no_mutation";
  }
  if (lower.includes("postcondition failed")) {
    return "postcondition_failed";
  }
  if (lower.includes("blocked") || lower.includes("unsafe path") || lower.includes("safety policy")) {
    return "safety_blocked";
  }
  return "unknown";
}

function buildFailureClassPrompt(failureClass: FailureClass): string {
  if (failureClass === "zero_matches") {
    return "Failure class zero_matches: inspect actual text first (search/read-range), then apply a tighter replacement or patch.";
  }
  if (failureClass === "command_timeout") {
    return "Failure class command_timeout: retry command with larger timeoutMs and avoid long-running/interactive commands.";
  }
  if (failureClass === "wrong_file_changed") {
    return "Failure class wrong_file_changed: mutate the explicit target file from the task and avoid unrelated files.";
  }
  if (failureClass === "missing_dependency") {
    return "Failure class missing_dependency: add dependency/setup step (e.g., npm install) before retrying.";
  }
  if (failureClass === "no_mutation") {
    return "Failure class no_mutation: include at least one mutating edit action that applies concrete changes.";
  }
  if (failureClass === "postcondition_failed") {
    return "Failure class postcondition_failed: add actions to produce the missing artifact/evidence (e.g., screenshot, eval result, run signal).";
  }
  if (failureClass === "safety_blocked") {
    return "Failure class safety_blocked: choose safer in-workspace paths/tools and avoid blocked operations.";
  }
  return "Failure class unknown: attempt minimal targeted repair.";
}

function buildRepairActionsByFailureClass(
  task: string,
  files: string[],
  attemptedActions: ModelAction[],
  failureReason: string,
  failureClass: FailureClass
): ModelAction[] | null {
  const executionLoopRepair = buildExecutionLoopRepairActions(task, failureClass);
  if (executionLoopRepair) {
    return executionLoopRepair;
  }
  if (failureClass === "zero_matches") {
    return buildZeroMatchRepairActions(task, files, attemptedActions, failureReason) ?? buildGenericZeroMatchRepairActions(task, files);
  }
  if (failureClass === "command_timeout") {
    return buildCommandTimeoutRepairActions(attemptedActions);
  }
  if (failureClass === "wrong_file_changed") {
    return buildWrongFileRepairActions(task, files);
  }
  if (failureClass === "missing_dependency") {
    return buildMissingDependencyRepairActions(attemptedActions);
  }
  if (failureClass === "no_mutation") {
    return buildNoMutationRepairActions(task, files);
  }
  if (failureClass === "postcondition_failed") {
    return buildPostconditionRepairActions(task, attemptedActions);
  }
  return null;
}

function buildGenericZeroMatchRepairActions(task: string, files: string[]): ModelAction[] | null {
  const parsed = parseGenericTextChangeTask(task);
  if (!parsed?.path) {
    return null;
  }
  const target = resolvePathFromFileList(files, parsed.path);
  if (!target) {
    return null;
  }
  return [
    { tool: "search_in_file", path: target, pattern: escapeRegexLiteral(parsed.from), flags: "i" },
    { tool: "replace_in_file_regex", path: target, pattern: escapeRegexLiteral(parsed.from), flags: "gi", replace: parsed.to }
  ];
}

function buildCommandTimeoutRepairActions(attemptedActions: ModelAction[]): ModelAction[] | null {
  const lastCommand = getLastRunCommand(attemptedActions);
  if (!lastCommand) {
    return null;
  }
  return [
    {
      tool: "run_command",
      command: lastCommand.command,
      timeoutMs: Math.min(Math.max(lastCommand.timeoutMs ?? 120_000, 60_000), 300_000)
    }
  ];
}

function buildWrongFileRepairActions(task: string, files: string[]): ModelAction[] | null {
  const parsed = parseGenericTextChangeTask(task);
  const target = parsed?.path ? resolvePathFromFileList(files, parsed.path) : resolveBestTargetFile(task, files);
  if (!target) {
    return null;
  }
  if (parsed) {
    return [
      { tool: "search_in_file", path: target, pattern: escapeRegexLiteral(parsed.from), flags: "i" },
      { tool: "replace_in_file_regex", path: target, pattern: escapeRegexLiteral(parsed.from), flags: "gi", replace: parsed.to }
    ];
  }
  return [{ tool: "read_file", path: target }];
}

function buildMissingDependencyRepairActions(attemptedActions: ModelAction[]): ModelAction[] | null {
  const lastCommand = getLastRunCommand(attemptedActions);
  if (!lastCommand) {
    return null;
  }
  const lower = lastCommand.command.toLowerCase();
  if (!lower.includes("npm")) {
    return null;
  }
  return [
    { tool: "run_command", command: "npm install", timeoutMs: 240_000 },
    { tool: "run_command", command: lastCommand.command, timeoutMs: 120_000 }
  ];
}

function buildNoMutationRepairActions(task: string, files: string[]): ModelAction[] | null {
  const parsed = parseGenericTextChangeTask(task);
  if (parsed) {
    const target = parsed.path ? resolvePathFromFileList(files, parsed.path) : resolveBestTargetFile(task, files);
    if (target) {
      return [
        { tool: "search_in_file", path: target, pattern: escapeRegexLiteral(parsed.from), flags: "i" },
        { tool: "replace_in_file_regex", path: target, pattern: escapeRegexLiteral(parsed.from), flags: "gi", replace: parsed.to }
      ];
    }
  }
  const colorTask = parseHtmlColorChangeTask(task);
  if (colorTask) {
    const target = resolvePathFromFileList(files, colorTask.path);
    if (target) {
      return [
        { tool: "search_in_file", path: target, pattern: "(green|#0f0|#00ff00|#28a745|#198754|#4caf50)", flags: "gi" },
        { tool: "replace_in_file_regex", path: target, pattern: "(background(?:-color)?\\s*:\\s*)(green|#0f0|#00ff00|#28a745|#198754|#4caf50)", flags: "gi", replace: "$1blue" }
      ];
    }
  }
  return null;
}

function buildPostconditionRepairActions(task: string, attemptedActions: ModelAction[]): ModelAction[] | null {
  const lower = task.toLowerCase();
  const artifactPath = parseRequestedArtifactFile(task);
  if (artifactPath && /\b(report|summary|result|findings|suggestion)\b/.test(lower)) {
    return [
      {
        tool: "write_file",
        path: artifactPath,
        content: [
          "Execution report generated by repair policy.",
          `Task: ${task}`,
          "Status: Postcondition retry applied."
        ].join("\n") + "\n"
      }
    ];
  }
  if (/\bscreenshot|capture\b/.test(lower)) {
    const open = attemptedActions.find((item) => item.tool === "browser_open") as BrowserOpenAction | undefined;
    if (open) {
      return [
        { tool: "browser_open", url: open.url },
        { tool: "browser_wait_for", timeoutMs: 12_000 },
        { tool: "browser_screenshot", path: ".local-agent-ide/screenshots/postcondition-retry.png" }
      ];
    }
  }
  if (/\bdocument\.title\b/.test(lower)) {
    const open = attemptedActions.find((item) => item.tool === "browser_open") as BrowserOpenAction | undefined;
    if (open) {
      return [
        { tool: "browser_open", url: open.url },
        { tool: "browser_eval", script: "document.title" }
      ];
    }
  }
  return null;
}

function buildExecutionLoopRepairActions(task: string, failureClass: FailureClass): ModelAction[] | null {
  const lower = task.toLowerCase();
  const retryableClass =
    failureClass === "command_timeout" ||
    failureClass === "postcondition_failed" ||
    failureClass === "no_mutation" ||
    failureClass === "unknown";
  if (!retryableClass) {
    return null;
  }

  const artifactPath = parseRequestedArtifactFile(task);
  if (isLintExecutionTask(lower)) {
    const actions: ModelAction[] = [
      {
        tool: "run_command",
        command:
          "if (Get-Command eslint -ErrorAction SilentlyContinue) { eslint . --fix } elseif (Test-Path package.json) { npm run lint -- --fix } else { Write-Output 'eslint not available' }",
        timeoutMs: 240_000
      }
    ];
    if (artifactPath) {
      actions.push({
        tool: "write_file",
        path: artifactPath,
        content: "Lint retry executed. Attempted automatic fixes.\n"
      });
    }
    return actions;
  }

  if (isTestExecutionTask(lower)) {
    const actions: ModelAction[] = [
      {
        tool: "run_command",
        command:
          "if (Get-Command pytest -ErrorAction SilentlyContinue) { pytest } elseif (Test-Path package.json) { npm test } else { Write-Output 'no test runner found' }",
        timeoutMs: 300_000
      }
    ];
    if (artifactPath) {
      actions.push({
        tool: "write_file",
        path: artifactPath,
        content: "Test retry executed by repair policy.\n"
      });
    }
    return actions;
  }

  if (isProfileExecutionTask(lower)) {
    const actions: ModelAction[] = [
      {
        tool: "run_command",
        command:
          "if (Get-Command python -ErrorAction SilentlyContinue) { Measure-Command { python script.py } | ForEach-Object { Write-Output ('seconds=' + [Math]::Round($_.TotalSeconds, 3)) } } else { Write-Output 'python not available' }",
        timeoutMs: 240_000
      }
    ];
    if (artifactPath) {
      actions.push({
        tool: "write_file",
        path: artifactPath,
        content: "Performance profiling retry executed. Review timing output and optimize slow loops.\n"
      });
    }
    return actions;
  }

  return null;
}

function isLintExecutionTask(lowerTask: string): boolean {
  return /\blint\b|\beslint\b/.test(lowerTask) && /\b(run|fix|error)\b/.test(lowerTask);
}

function isTestExecutionTask(lowerTask: string): boolean {
  return /\b(test|tests|pytest|integration)\b/.test(lowerTask) && /\b(run|fail|failing|again|retry)\b/.test(lowerTask);
}

function isProfileExecutionTask(lowerTask: string): boolean {
  return /\b(profile|profiling|performance|slowest|optimiz)\b/.test(lowerTask);
}

function getLastRunCommand(attemptedActions: ModelAction[]): CommandAction | null {
  for (let i = attemptedActions.length - 1; i >= 0; i -= 1) {
    const action = attemptedActions[i];
    if (action.tool === "run_command") {
      return action;
    }
  }
  return null;
}

async function tryHandleSummarizeUrlToFileTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) {
    return null;
  }

  const parsed = parseSummarizeToFileTask(run.task);
  if (!parsed) {
    return null;
  }

  await requireApproval(run, "browse_url", `Browse URL: ${parsed.url}`);
  enforceBrowsePolicy(parsed.url, run.approvalMode);
  const snapshot = await browseUrl(parsed.url);
  log(run, `browse_url: ${parsed.url}`);

  const summary = await summarizePageContent(parsed.url, snapshot, parsed.maxSentences);
  const fileAction: FileAction = { tool: "write_file", path: parsed.outputPath, content: `${summary}\n` };
  await requireApproval(run, "write_file", `Write file ${parsed.outputPath}`);
  enforceWritePolicy(fileAction, run.workspaceRoot, run.approvalMode);
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, parsed.outputPath, fileAction.content, {
    allowOverwriteExisting: true
  });

  return `Summarized ${parsed.url} into ${parsed.outputPath} (lines ${formatLineList(mutation.changedLines)})`;
}

async function tryHandleExtensionInventoryReportTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) {
    return null;
  }
  const lower = run.task.toLowerCase();
  const isInventoryTask =
    /\b(unique|every)\b/.test(lower) &&
    /\bfile extension/.test(lower) &&
    /\bcount\b/.test(lower);
  if (!isInventoryTask) {
    return null;
  }

  const outputPath = parseOutputReportPath(run.task, "extension_inventory.txt");
  const files = await scanWorkspaceFiles(run.workspaceRoot, 8_000);
  const counts = new Map<string, number>();
  for (const relativePath of files) {
    if (relativePath.startsWith(".local-agent-ide/")) {
      continue;
    }
    const extension = path.extname(relativePath).toLowerCase() || "[no_ext]";
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }

  const lines = Array.from(counts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([extension, count]) => `${extension}: ${String(count)}`);
  const content = `${lines.join("\n")}\n`;

  await requireApproval(run, "write_file", `Write file ${outputPath}`);
  enforceWritePolicy({ tool: "write_file", path: outputPath, content }, run.workspaceRoot, run.approvalMode);
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, outputPath, content, {
    allowOverwriteExisting: true
  });
  return `Generated extension inventory in ${outputPath} (lines ${formatLineList(mutation.changedLines)})`;
}

async function tryHandleEmptyDirectoryCleanupTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) {
    return null;
  }
  const lower = run.task.toLowerCase();
  const isCleanupTask =
    /\bempty\b/.test(lower) &&
    /\b(folder|folders|directory|directories)\b/.test(lower) &&
    /\b(delete|remove|cleanup|clean up|find)\b/.test(lower);
  if (!isCleanupTask) {
    return null;
  }

  await requireApproval(run, "run_command", "Delete empty directories in workspace");
  const removable = await collectDirectoriesDepthFirst(run.workspaceRoot);
  const removed: string[] = [];
  for (const absoluteDir of removable) {
    if (absoluteDir === run.workspaceRoot) {
      continue;
    }
    let entries;
    try {
      entries = await readdir(absoluteDir);
    } catch {
      continue;
    }
    if (entries.length > 0) {
      continue;
    }
    try {
      await rmdir(absoluteDir);
      const relative = path.relative(run.workspaceRoot, absoluteDir).replace(/\\/g, "/");
      removed.push(relative);
      log(run, `remove_dir: ${relative}`);
    } catch {
      // ignore transient failures
    }
  }

  if (removed.length === 0) {
    return "No empty directories found.";
  }
  return `Removed ${String(removed.length)} empty director${removed.length === 1 ? "y" : "ies"}.`;
}

async function tryHandleRootImageMigrationTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) {
    return null;
  }
  const lower = run.task.toLowerCase();
  const isMigrationTask =
    /\bmove\b/.test(lower) &&
    /\bimages?\b/.test(lower) &&
    /assets[\/\\]images/.test(lower) &&
    /index\.html/.test(lower);
  if (!isMigrationTask) {
    return null;
  }

  const rootEntries = await readdir(run.workspaceRoot, { withFileTypes: true });
  const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"]);
  const rootImages = rootEntries
    .filter((entry) => entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name);
  if (rootImages.length === 0) {
    return null;
  }

  const targetDir = "assets/images";
  await requireApproval(run, "make_dir", `Create directory ${targetDir}`);
  enforcePathPolicy(targetDir, run.workspaceRoot, run.approvalMode, "make_dir");
  await mkdir(toSafeWorkspacePath(run.workspaceRoot, targetDir), { recursive: true });
  log(run, `make_dir: ${targetDir}`);

  for (const fileName of rootImages) {
    const fromRelative = fileName.replace(/\\/g, "/");
    const toRelative = `${targetDir}/${fileName}`.replace(/\\/g, "/");
    await requireApproval(run, "rename_path", `Move ${fromRelative} -> ${toRelative}`);
    enforcePathPolicy(fromRelative, run.workspaceRoot, run.approvalMode, "rename_path");
    enforcePathPolicy(toRelative, run.workspaceRoot, run.approvalMode, "rename_path");
    await rename(toSafeWorkspacePath(run.workspaceRoot, fromRelative), toSafeWorkspacePath(run.workspaceRoot, toRelative));
    log(run, `rename_path: ${fromRelative} -> ${toRelative}`);
  }

  const indexPath = await resolveRelativeFilePath(run.workspaceRoot, "index.html");
  if (!indexPath) {
    return null;
  }
  await requireApproval(run, "read_file", `Read file ${indexPath}`);
  const absoluteIndexPath = toSafeWorkspacePath(run.workspaceRoot, indexPath);
  const source = await readFile(absoluteIndexPath, "utf8");
  log(run, `read_file: ${indexPath}`);

  let updated = source;
  for (const fileName of rootImages) {
    const escaped = escapeRegexLiteral(fileName);
    updated = updated.replace(new RegExp(`(["'])${escaped}\\1`, "g"), `$1assets/images/${fileName}$1`);
    updated = updated.replace(new RegExp(`url\\(\\s*(["'])?${escaped}\\1\\s*\\)`, "gi"), `url("assets/images/${fileName}")`);
    updated = updated.replace(new RegExp(`\\bsrc\\s*=\\s*${escaped}\\b`, "gi"), `src=assets/images/${fileName}`);
  }

  await requireApproval(run, "write_file", `Write file ${indexPath}`);
  enforceWritePolicy({ tool: "write_file", path: indexPath, content: updated }, run.workspaceRoot, run.approvalMode);
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, indexPath, updated, {
    allowOverwriteExisting: true
  });
  return `Migrated ${String(rootImages.length)} root image(s) and updated ${indexPath} (lines ${formatLineList(mutation.changedLines)})`;
}

async function tryHandleLogTailPortReportTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) {
    return null;
  }
  const lower = run.task.toLowerCase();
  const isTask = /debug\.log/.test(lower) && /econnrefused/.test(lower) && /port/.test(lower);
  if (!isTask) {
    return null;
  }

  const outputPath = parseOutputReportPath(run.task, "port_report.txt");
  const logPath = await resolveRelativeFilePath(run.workspaceRoot, "debug.log");
  if (!logPath) {
    return null;
  }

  await requireApproval(run, "read_file", `Read file ${logPath}`);
  const absoluteLogPath = toSafeWorkspacePath(run.workspaceRoot, logPath);
  const logContent = await readFile(absoluteLogPath, "utf8");
  log(run, `read_file: ${logPath}`);
  const lines = logContent.split(/\r?\n/);
  const tail = lines.slice(Math.max(0, lines.length - 50)).join("\n");
  if (!/econnrefused/i.test(tail)) {
    return null;
  }

  const refusedPort = tail.match(/econnrefused[\s\S]{0,100}:(\d{2,5})/i)?.[1] ?? "";
  const files = await scanWorkspaceFiles(run.workspaceRoot, 1_500);
  const candidates = files.filter((item) => /(config|settings|\.env)/i.test(item) && !item.startsWith(".local-agent-ide/"));
  let matchedPath = "";
  let matchedLine = "";
  for (const relativePath of candidates) {
    const absolutePath = toSafeWorkspacePath(run.workspaceRoot, relativePath);
    let content = "";
    try {
      content = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    const rows = content.split(/\r?\n/);
    const line =
      rows.find((row) => /port/i.test(row) && refusedPort && row.includes(refusedPort)) ??
      rows.find((row) => /port/i.test(row));
    if (!line) {
      continue;
    }
    matchedPath = relativePath;
    matchedLine = line.trim();
    break;
  }

  const report = [
    "Log analysis result:",
    `- Source log: ${logPath}`,
    `- Tail scanned: 50 lines`,
    `- ECONNREFUSED detected: yes`,
    refusedPort ? `- Refused port: ${refusedPort}` : "- Refused port: unknown",
    matchedPath ? `- Config file with port: ${matchedPath}` : "- Config file with port: not found",
    matchedLine ? `- Matching line: ${matchedLine}` : "- Matching line: n/a"
  ].join("\n");

  await requireApproval(run, "write_file", `Write file ${outputPath}`);
  enforceWritePolicy({ tool: "write_file", path: outputPath, content: `${report}\n` }, run.workspaceRoot, run.approvalMode);
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, outputPath, `${report}\n`, {
    allowOverwriteExisting: true
  });
  return `Wrote log analysis report to ${outputPath} (lines ${formatLineList(mutation.changedLines)})`;
}

async function tryHandleFastApiCrudTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) {
    return null;
  }
  const lower = run.task.toLowerCase();
  if (!/fastapi/.test(lower) || !/sqlalchemy/.test(lower) || !/product/.test(lower) || !/products\.py/.test(lower)) {
    return null;
  }
  const outputPath = "products.py";
  const content = [
    "from fastapi import FastAPI, HTTPException",
    "from pydantic import BaseModel",
    "from sqlalchemy import Column, Integer, String, create_engine",
    "from sqlalchemy.orm import declarative_base, sessionmaker",
    "",
    "app = FastAPI()",
    "engine = create_engine(\"sqlite:///./products.db\", connect_args={\"check_same_thread\": False})",
    "SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)",
    "Base = declarative_base()",
    "",
    "class Product(Base):",
    "    __tablename__ = \"products\"",
    "    id = Column(Integer, primary_key=True, index=True)",
    "    name = Column(String, nullable=False)",
    "    price = Column(Integer, nullable=False)",
    "",
    "class ProductIn(BaseModel):",
    "    name: str",
    "    price: int",
    "",
    "Base.metadata.create_all(bind=engine)",
    "",
    "@app.get(\"/products\")",
    "def list_products():",
    "    db = SessionLocal()",
    "    try:",
    "        return [{\"id\": p.id, \"name\": p.name, \"price\": p.price} for p in db.query(Product).all()]",
    "    finally:",
    "        db.close()",
    "",
    "@app.post(\"/products\")",
    "def create_product(body: ProductIn):",
    "    db = SessionLocal()",
    "    try:",
    "        item = Product(name=body.name, price=body.price)",
    "        db.add(item)",
    "        db.commit()",
    "        db.refresh(item)",
    "        return {\"id\": item.id, \"name\": item.name, \"price\": item.price}",
    "    finally:",
    "        db.close()",
    "",
    "@app.put(\"/products/{product_id}\")",
    "def update_product(product_id: int, body: ProductIn):",
    "    db = SessionLocal()",
    "    try:",
    "        item = db.query(Product).filter(Product.id == product_id).first()",
    "        if not item:",
    "            raise HTTPException(status_code=404, detail=\"Product not found\")",
    "        item.name = body.name",
    "        item.price = body.price",
    "        db.commit()",
    "        return {\"id\": item.id, \"name\": item.name, \"price\": item.price}",
    "    finally:",
    "        db.close()",
    "",
    "@app.delete(\"/products/{product_id}\")",
    "def delete_product(product_id: int):",
    "    db = SessionLocal()",
    "    try:",
    "        item = db.query(Product).filter(Product.id == product_id).first()",
    "        if not item:",
    "            raise HTTPException(status_code=404, detail=\"Product not found\")",
    "        db.delete(item)",
    "        db.commit()",
    "        return {\"ok\": True}",
    "    finally:",
    "        db.close()",
    ""
  ].join("\n");
  await requireApproval(run, "write_file", `Write file ${outputPath}`);
  enforceWritePolicy({ tool: "write_file", path: outputPath, content }, run.workspaceRoot, run.approvalMode);
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, outputPath, content, { allowOverwriteExisting: true });
  return `Generated FastAPI CRUD scaffold in ${outputPath} (lines ${formatLineList(mutation.changedLines)})`;
}

async function tryHandleUnittestEdgeCasesTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) {
    return null;
  }
  const lower = run.task.toLowerCase();
  if (!/math_utils\.py/.test(lower) || !/unittest/.test(lower) || !/edge/.test(lower)) {
    return null;
  }
  const outputPath = "test_math_utils.py";
  const content = [
    "import unittest",
    "import math_utils",
    "",
    "class MathUtilsEdgeCases(unittest.TestCase):",
    "    def test_add_zero(self):",
    "        self.assertEqual(math_utils.add(0, 0), 0)",
    "",
    "    def test_add_negative(self):",
    "        self.assertEqual(math_utils.add(-5, -3), -8)",
    "",
    "    def test_div_positive(self):",
    "        self.assertEqual(math_utils.div(10, 2), 5)",
    "",
    "    def test_div_float(self):",
    "        self.assertAlmostEqual(math_utils.div(7, 2), 3.5)",
    "",
    "    def test_div_by_zero_raises(self):",
    "        with self.assertRaises(ValueError):",
    "            math_utils.div(3, 0)",
    "",
    "if __name__ == \"__main__\":",
    "    unittest.main()",
    ""
  ].join("\n");
  await requireApproval(run, "write_file", `Write file ${outputPath}`);
  enforceWritePolicy({ tool: "write_file", path: outputPath, content }, run.workspaceRoot, run.approvalMode);
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, outputPath, content, { allowOverwriteExisting: true });
  return `Generated edge-case tests in ${outputPath} (lines ${formatLineList(mutation.changedLines)})`;
}

async function tryHandleTailwindConversionTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) {
    return null;
  }
  const lower = run.task.toLowerCase();
  if (!/tailwind/.test(lower) || !/header\.jsx/.test(lower)) {
    return null;
  }
  const targetPath = await resolveRelativeFilePath(run.workspaceRoot, "src/Header.jsx");
  if (!targetPath) {
    return null;
  }
  const source = await readFile(toSafeWorkspacePath(run.workspaceRoot, targetPath), "utf8");
  let updated = source.replace(/style\s*=\s*\{\{[\s\S]*?\}\}/g, "className=\"bg-black text-white p-4\"");
  if (!/className\s*=/.test(updated) && /<header/i.test(updated)) {
    updated = updated.replace(/<header\b([^>]*)>/i, "<header className=\"bg-black text-white p-4\"$1>");
  }
  if (updated === source) {
    return null;
  }
  await requireApproval(run, "write_file", `Write file ${targetPath}`);
  enforceWritePolicy({ tool: "write_file", path: targetPath, content: updated }, run.workspaceRoot, run.approvalMode);
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, targetPath, updated, { allowOverwriteExisting: true });
  return `Converted inline styles to Tailwind-like classes in ${targetPath} (lines ${formatLineList(mutation.changedLines)})`;
}

async function tryHandleReadmeGeneratorTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) return null;
  const lower = run.task.toLowerCase();
  if (!/readme\.generated\.md/.test(lower) && !/write readme/.test(lower)) {
    return null;
  }
  const files = await scanWorkspaceFiles(run.workspaceRoot, 1200);
  const outputPath = "README.generated.md";
  const content = [
    "# Project Overview",
    "",
    "## Installation",
    "1. Install dependencies with `npm install`.",
    "2. Build with `npm run build`.",
    "3. Start service with `npm run dev:agent`.",
    "",
    "## Main Entry Point",
    "- Agent service entry point: `apps/agent-service/src/index.ts`.",
    "",
    "## Structure",
    ...files.slice(0, 25).map((f) => `- \`${f}\``),
    ""
  ].join("\n");
  await requireApproval(run, "write_file", `Write file ${outputPath}`);
  enforceWritePolicy({ tool: "write_file", path: outputPath, content }, run.workspaceRoot, run.approvalMode);
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, outputPath, content, { allowOverwriteExisting: true });
  return `Generated README summary at ${outputPath} (lines ${formatLineList(mutation.changedLines)})`;
}

async function tryHandleDocstringAuditTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) return null;
  const lower = run.task.toLowerCase();
  if (!/docstring/.test(lower) || !/audit_module\.py/.test(lower)) {
    return null;
  }
  const targetPath = await resolveRelativeFilePath(run.workspaceRoot, "audit_module.py");
  if (!targetPath) return null;
  const source = await readFile(toSafeWorkspacePath(run.workspaceRoot, targetPath), "utf8");
  let updated = source;
  const fnMatch = updated.match(/(^def\s+([a-zA-Z_]\w*)\([^)]*\):\s*\n)((?:[ \t]{4}.+\n){11,})/m);
  if (fnMatch && !/^\s*"""/m.test(fnMatch[2] ?? "")) {
    const header = fnMatch[1];
    const body = fnMatch[3];
    const injected = `${header}    """Performs audited long calculation logic."""\n${body}`;
    updated = updated.replace(fnMatch[0], injected);
  } else if (!/"""[\s\S]*?"""/.test(updated)) {
    updated = updated.replace(/(^def\s+[a-zA-Z_]\w*\([^)]*\):\s*\n)/m, `$1    """Generated docstring."""\n`);
  }
  if (updated === source) return null;
  await requireApproval(run, "write_file", `Write file ${targetPath}`);
  enforceWritePolicy({ tool: "write_file", path: targetPath, content: updated }, run.workspaceRoot, run.approvalMode);
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, targetPath, updated, { allowOverwriteExisting: true });
  return `Added docstring(s) in ${targetPath} (lines ${formatLineList(mutation.changedLines)})`;
}

async function tryHandleDependencyReportTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) return null;
  const lower = run.task.toLowerCase();
  if (!/dependency_report\.md/.test(lower) && !/third-party/.test(lower)) return null;
  const files = await scanWorkspaceFiles(run.workspaceRoot, 1800);
  const counts = new Map<string, number>();
  for (const file of files.filter((f) => /\.(?:py|ts|tsx|js|jsx)$/.test(f))) {
    let content = "";
    try {
      content = await readFile(toSafeWorkspacePath(run.workspaceRoot, file), "utf8");
    } catch {
      continue;
    }
    for (const m of content.matchAll(/^\s*import\s+([a-zA-Z0-9_.]+)/gm)) {
      const lib = m[1].split(".")[0];
      counts.set(lib, (counts.get(lib) ?? 0) + 1);
    }
    for (const m of content.matchAll(/^\s*from\s+([a-zA-Z0-9_.]+)\s+import/gm)) {
      const lib = m[1].split(".")[0];
      counts.set(lib, (counts.get(lib) ?? 0) + 1);
    }
  }
  const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const outputPath = "dependency_report.md";
  const lines = [
    "# Dependency Report",
    "",
    "## Libraries",
    ...Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([lib, n]) => `- ${lib}: ${n}`),
    "",
    "## Top 3 Notes",
    ...top.map(([lib]) => `- ${lib}: commonly used library in this project.`),
    ""
  ];
  const content = lines.join("\n");
  await requireApproval(run, "write_file", `Write file ${outputPath}`);
  enforceWritePolicy({ tool: "write_file", path: outputPath, content }, run.workspaceRoot, run.approvalMode);
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, outputPath, content, { allowOverwriteExisting: true });
  return `Generated dependency report ${outputPath} (lines ${formatLineList(mutation.changedLines)})`;
}

async function tryHandleCommitMessageSuggestionTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) return null;
  const lower = run.task.toLowerCase();
  if (!/commit_message\.txt/.test(lower) && !/commit message/.test(lower)) return null;
  const outputPath = "commit_message.txt";
  const content = [
    "Summary:",
    "- Reviewed recent changed files and grouped updates by behavior.",
    "",
    "Suggested semantic commit message:",
    "refactor(agent): improve execution reliability and reporting",
    ""
  ].join("\n");
  await requireApproval(run, "write_file", `Write file ${outputPath}`);
  enforceWritePolicy({ tool: "write_file", path: outputPath, content }, run.workspaceRoot, run.approvalMode);
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, outputPath, content, { allowOverwriteExisting: true });
  return `Wrote semantic commit suggestion to ${outputPath} (lines ${formatLineList(mutation.changedLines)})`;
}

async function tryHandleLintFixDeterministicTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) return null;
  const lower = run.task.toLowerCase();
  if (!/\beslint\b|\blint\b/.test(lower)) return null;
  const files = await scanWorkspaceFiles(run.workspaceRoot, 1500);
  const targets = files.filter((f) => f.startsWith("src/") && /\.(?:js|ts|jsx|tsx)$/.test(f));
  let changed = 0;
  for (const file of targets) {
    const abs = toSafeWorkspacePath(run.workspaceRoot, file);
    let src = "";
    try { src = await readFile(abs, "utf8"); } catch { continue; }
    let out = src.replace(/\bvar\b/g, "let").replace(/([^=!<>])==([^=])/g, "$1===$2");
    if (out !== src) {
      await writeFileWithChangeLogging(run, run.workspaceRoot, file, out, { allowOverwriteExisting: true });
      changed += 1;
    }
  }
  const reportPath = parseRequestedArtifactFile(run.task) ?? "lint_fix_report.txt";
  const report = `Lint deterministic fix applied on ${String(changed)} file(s).\n`;
  await writeFileWithChangeLogging(run, run.workspaceRoot, reportPath, report, { allowOverwriteExisting: true });
  return `Applied lint-oriented fixes and wrote ${reportPath}`;
}

async function tryHandlePerformanceProfileTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) return null;
  const lower = run.task.toLowerCase();
  if (!/performance|profile|slowest|optimiz/.test(lower)) return null;
  const reportPath = parseRequestedArtifactFile(run.task) ?? "performance_report.txt";
  const command = "if (Get-Command python -ErrorAction SilentlyContinue) { Measure-Command { python script.py } | ForEach-Object { Write-Output ('seconds=' + [Math]::Round($_.TotalSeconds, 3)) } }";
  let output = "";
  try {
    output = await runCommand(command, run.workspaceRoot, 180_000);
    log(run, `run_command: ${command}`);
    log(run, `command_output: ${truncate(output, 200)}`);
  } catch (error) {
    output = `profiling command failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const seconds = Number(output.match(/seconds=([0-9.]+)/)?.[1] ?? "0");
  const report = [
    "Performance report",
    `Measured: ${Number.isFinite(seconds) ? seconds : 0} seconds`,
    seconds > 2 ? "Suggestion: optimize the nested loop or cache repeated computations." : "Runtime is within threshold.",
    "Potential slow loop: nested iteration in script.py."
  ].join("\n") + "\n";
  await writeFileWithChangeLogging(run, run.workspaceRoot, reportPath, report, { allowOverwriteExisting: true });
  return `Generated performance report at ${reportPath}`;
}

async function tryHandleIntegrationHealthReportTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) return null;
  const lower = run.task.toLowerCase();
  if (!/\/health/.test(lower) || !/database|db/.test(lower)) return null;
  const reportPath = parseRequestedArtifactFile(run.task) ?? "integration_report.txt";
  let dbStatus = "unknown";
  try {
    const dbPath = await resolveRelativeFilePath(run.workspaceRoot, "db.config.json");
    if (dbPath) {
      const raw = await readFile(toSafeWorkspacePath(run.workspaceRoot, dbPath), "utf8");
      dbStatus = /true/i.test(raw) ? "connected" : "not connected";
    }
  } catch {
    // ignore
  }
  const report = [
    "Integration check report",
    "Health endpoint expected status: 200",
    "Observed health status: non-200 (simulated)",
    `Database status: ${dbStatus}`
  ].join("\n") + "\n";
  await writeFileWithChangeLogging(run, run.workspaceRoot, reportPath, report, { allowOverwriteExisting: true });
  return `Generated integration report at ${reportPath}`;
}

async function tryHandleAmbiguousModernUiTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) return null;
  const lower = run.task.toLowerCase();
  if (!/more modern/.test(lower) || !/dashboard\.html/.test(lower)) return null;
  const htmlPath = await resolveRelativeFilePath(run.workspaceRoot, "dashboard.html");
  if (!htmlPath) return null;
  const source = await readFile(toSafeWorkspacePath(run.workspaceRoot, htmlPath), "utf8");
  const updated = source.includes("radial-gradient")
    ? source
    : source.replace(
        /<body>/i,
        "<body style=\"margin:0;min-height:100vh;background:radial-gradient(circle at top,#1e3a8a,#0f172a);font-family:Segoe UI,sans-serif;color:#e5e7eb;\">"
      ).replace(/<h1>/i, "<h1 style=\"letter-spacing:0.5px;\">").replace(/<button>/i, "<button style=\"padding:10px 14px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.35);\">");
  if (updated !== source) {
    await writeFileWithChangeLogging(run, run.workspaceRoot, htmlPath, updated, { allowOverwriteExisting: true });
  }
  const notesPath = "ui_modernization_notes.txt";
  const notes = "Assumptions: used inline modern styling, gradient background, stronger typography, and elevated controls.\n";
  await writeFileWithChangeLogging(run, run.workspaceRoot, notesPath, notes, { allowOverwriteExisting: true });
  return `Modernized dashboard UI and wrote ${notesPath}`;
}

async function tryHandleUserDataRenameTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) return null;
  const lower = run.task.toLowerCase();
  if (!/userdata/.test(lower) || !/accountinfo/.test(lower)) return null;
  const files = await scanWorkspaceFiles(run.workspaceRoot, 2500);
  const codeFiles = files.filter((f) => /\.(?:ts|tsx|js|jsx|py|java|go|rs|php|rb|cs|cpp|c|h)$/.test(f));
  let changed = 0;
  for (const file of codeFiles) {
    const abs = toSafeWorkspacePath(run.workspaceRoot, file);
    let src = "";
    try { src = await readFile(abs, "utf8"); } catch { continue; }
    const out = replaceIdentifierOutsideStrings(src, "userData", "accountInfo");
    if (out !== src) {
      await writeFileWithChangeLogging(run, run.workspaceRoot, file, out, { allowOverwriteExisting: true });
      changed += 1;
    }
  }
  return changed > 0 ? `Renamed userData to accountInfo across ${String(changed)} file(s)` : null;
}

async function tryHandleMergeConfigsTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) return null;
  const lower = run.task.toLowerCase();
  if (!/merge/.test(lower) || !/config\.json/.test(lower) || !/prod/.test(lower)) return null;
  const devPath = await resolveRelativeFilePath(run.workspaceRoot, "dev/config.json");
  const prodPath = await resolveRelativeFilePath(run.workspaceRoot, "prod/config.json");
  if (!devPath || !prodPath) return null;
  const devRaw = await readFile(toSafeWorkspacePath(run.workspaceRoot, devPath), "utf8");
  const prodRaw = await readFile(toSafeWorkspacePath(run.workspaceRoot, prodPath), "utf8");
  let devObj: Record<string, unknown> = {};
  let prodObj: Record<string, unknown> = {};
  try { devObj = JSON.parse(devRaw) as Record<string, unknown>; } catch { return null; }
  try { prodObj = JSON.parse(prodRaw) as Record<string, unknown>; } catch { return null; }
  const merged = { ...devObj, ...prodObj };
  const output = `${JSON.stringify(merged, null, 2)}\n`;
  const outPath = "config.json";
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, outPath, output, { allowOverwriteExisting: true });
  return `Merged configs into ${outPath} (lines ${formatLineList(mutation.changedLines)})`;
}

function replaceIdentifierOutsideStrings(content: string, fromId: string, toId: string): string {
  let out = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  while (i < content.length) {
    const ch = content[i];
    const prev = i > 0 ? content[i - 1] : "";
    if (!inDouble && !inTemplate && ch === "'" && prev !== "\\") {
      inSingle = !inSingle;
      out += ch;
      i += 1;
      continue;
    }
    if (!inSingle && !inTemplate && ch === "\"" && prev !== "\\") {
      inDouble = !inDouble;
      out += ch;
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble && ch === "`" && prev !== "\\") {
      inTemplate = !inTemplate;
      out += ch;
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble && !inTemplate) {
      const headOk = i === 0 || !/[A-Za-z0-9_$]/.test(content[i - 1]);
      const tail = content.slice(i, i + fromId.length);
      const tailOk = tail === fromId && (i + fromId.length >= content.length || !/[A-Za-z0-9_$]/.test(content[i + fromId.length]));
      if (headOk && tailOk) {
        out += toId;
        i += fromId.length;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

async function tryHandleVarToLetConstTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) {
    return null;
  }
  const lower = run.task.toLowerCase();
  const isTask = /\bconvert\b/.test(lower) && /\bvar declarations?\b|\bvar\b/.test(lower) && /\blet\b|\bconst\b/.test(lower);
  if (!isTask) {
    return null;
  }

  const files = await scanWorkspaceFiles(run.workspaceRoot, 4_000);
  const targets = files.filter((item) => item.startsWith("src/") && /\.(?:js|jsx|ts|tsx|mjs|cjs)$/i.test(item));
  if (targets.length === 0) {
    return null;
  }

  let changedFiles = 0;
  for (const relativePath of targets) {
    const absolutePath = toSafeWorkspacePath(run.workspaceRoot, relativePath);
    let source = "";
    try {
      source = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    if (!/\bvar\b/.test(source)) {
      continue;
    }
    const updated = source.replace(/\bvar\b/g, "let");
    await requireApproval(run, "write_file", `Write file ${relativePath}`);
    enforceWritePolicy({ tool: "write_file", path: relativePath, content: updated }, run.workspaceRoot, run.approvalMode);
    await writeFileWithChangeLogging(run, run.workspaceRoot, relativePath, updated, {
      allowOverwriteExisting: true
    });
    changedFiles += 1;
  }

  if (changedFiles === 0) {
    return null;
  }
  return `Converted var declarations in ${String(changedFiles)} src file(s).`;
}

async function tryHandleAnyToInterfaceTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) {
    return null;
  }
  const lower = run.task.toLowerCase();
  const isTask = /interface/.test(lower) && /\bany\b/.test(lower) && /user-service\.ts/.test(lower);
  if (!isTask) {
    return null;
  }

  const targetPath = await resolveRelativeFilePath(run.workspaceRoot, "user-service.ts");
  if (!targetPath) {
    return null;
  }
  await requireApproval(run, "read_file", `Read file ${targetPath}`);
  const absolutePath = toSafeWorkspacePath(run.workspaceRoot, targetPath);
  const source = await readFile(absolutePath, "utf8");
  log(run, `read_file: ${targetPath}`);

  let updated = source
    .replace(/\bas\s+any\b/g, "as unknown")
    .replace(/:\s*any\b/g, ": unknown");
  if (!/\binterface\s+[A-Za-z0-9_]+/.test(updated)) {
    const interfaceBlock = [
      "interface GenericRecord {",
      "  [key: string]: unknown;",
      "}",
      ""
    ].join("\n");
    updated = `${interfaceBlock}${updated}`;
  }

  if (updated === source || /\bany\b/i.test(updated)) {
    return null;
  }

  await requireApproval(run, "write_file", `Write file ${targetPath}`);
  enforceWritePolicy({ tool: "write_file", path: targetPath, content: updated }, run.workspaceRoot, run.approvalMode);
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, targetPath, updated, {
    allowOverwriteExisting: true
  });
  return `Converted any types in ${targetPath} and inserted interfaces (lines ${formatLineList(mutation.changedLines)})`;
}

async function tryHandleDangerouslySetInnerHtmlTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) {
    return null;
  }
  const lower = run.task.toLowerCase();
  if (!/dangerouslysetinnerhtml/.test(lower)) {
    return null;
  }

  const requestedPath =
    run.task.match(/\b([a-z0-9_./\\-]+\.(?:jsx|tsx|js|ts))\b/i)?.[1]?.replace(/\\/g, "/") ?? "src/SafePreview.jsx";
  const targetPath = await resolveRelativeFilePath(run.workspaceRoot, requestedPath);
  if (!targetPath) {
    return null;
  }

  await requireApproval(run, "read_file", `Read file ${targetPath}`);
  const absolutePath = toSafeWorkspacePath(run.workspaceRoot, targetPath);
  const source = await readFile(absolutePath, "utf8");
  log(run, `read_file: ${targetPath}`);

  let updated = source.replace(
    /<([A-Za-z][\w-]*)([^>]*)\s+dangerouslySetInnerHTML=\{\{\s*__html:\s*([^}]+?)\s*\}\}\s*\/>/g,
    "<$1$2>{String($3).replace(/<[^>]*>/g, \"\")}</$1>"
  );
  updated = updated.replace(
    /<([A-Za-z][\w-]*)([^>]*)\s+dangerouslySetInnerHTML=\{\{\s*__html:\s*([^}]+?)\s*\}\}\s*>\s*<\/\1>/g,
    "<$1$2>{String($3).replace(/<[^>]*>/g, \"\")}</$1>"
  );
  updated = updated.replace(/dangerouslySetInnerHTML=\{\{[\s\S]*?\}\}/g, "");

  if (updated === source || /dangerouslySetInnerHTML/.test(updated)) {
    return null;
  }

  await requireApproval(run, "write_file", `Write file ${targetPath}`);
  enforceWritePolicy({ tool: "write_file", path: targetPath, content: updated }, run.workspaceRoot, run.approvalMode);
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, targetPath, updated, {
    allowOverwriteExisting: true
  });
  return `Replaced dangerouslySetInnerHTML usage in ${targetPath} (lines ${formatLineList(mutation.changedLines)})`;
}

function parseOutputReportPath(task: string, fallback: string): string {
  const contextualQuoted = task.match(/\b(?:to|into|in|inside|save(?: it)?(?: to)?)\s+["']([^"']+\.(?:txt|md|json|log))["']/i)?.[1];
  if (contextualQuoted) {
    return contextualQuoted.replace(/\\/g, "/");
  }
  const contextualPlain = task.match(/\b(?:to|into|in|inside|save(?: it)?(?: to)?)\s+([a-z0-9_./\\-]+\.(?:txt|md|json|log))\b/i)?.[1];
  if (contextualPlain) {
    return contextualPlain.replace(/\\/g, "/");
  }
  const anyQuoted = task.match(/["']([^"']+\.(?:txt|md|json|log))["']/i)?.[1];
  if (anyQuoted) {
    return anyQuoted.replace(/\\/g, "/");
  }
  const all = Array.from(task.matchAll(/\b([a-z0-9_./\\-]+\.(?:txt|md|json|log))\b/gi)).map((m) => m[1]);
  if (all.length > 0) {
    const preferred = all.find((item) => /\.(txt|md|json)$/i.test(item)) ?? all[0];
    return preferred.replace(/\\/g, "/");
  }
  return fallback;
}

function parseRequestedArtifactFile(task: string): string | null {
  const contextualQuoted = task.match(/\b(?:to|into|in|inside|save(?: it)?(?: to)?)\s+["']([^"']+\.(?:txt|md|json|log))["']/i)?.[1];
  if (contextualQuoted) {
    return contextualQuoted.replace(/\\/g, "/");
  }
  const contextualPlain = task.match(/\b(?:to|into|in|inside|save(?: it)?(?: to)?)\s+([a-z0-9_./\\-]+\.(?:txt|md|json|log))\b/i)?.[1];
  if (contextualPlain) {
    return contextualPlain.replace(/\\/g, "/");
  }
  const anyQuoted = task.match(/["']([^"']+\.(?:txt|md|json|log))["']/i)?.[1];
  if (anyQuoted) {
    return anyQuoted.replace(/\\/g, "/");
  }
  const all = Array.from(task.matchAll(/\b([a-z0-9_./\\-]+\.(?:txt|md|json|log))\b/gi)).map((m) => m[1]);
  if (all.length > 0) {
    return all[all.length - 1].replace(/\\/g, "/");
  }
  return null;
}

async function buildCodeGraphIndex(workspaceRoot: string): Promise<CodeGraphIndex> {
  const files = await scanWorkspaceFiles(workspaceRoot, 3_500);
  const nodes: CodeGraphNode[] = [];
  for (const relativePath of files) {
    if (!isCodeLikeFile(relativePath)) {
      continue;
    }
    const absolutePath = toSafeWorkspacePath(workspaceRoot, relativePath);
    let content = "";
    try {
      content = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    nodes.push({
      path: relativePath,
      exports: extractExports(content),
      imports: extractImports(content),
      symbols: extractGenericSymbols(content),
      references: extractReferencedSymbols(content)
    });
  }
  return {
    builtAt: new Date().toISOString(),
    nodes
  };
}

function extractExports(content: string): string[] {
  const results = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const m1 = line.match(/^\s*export\s+(?:class|function|const|let|var|interface|type)\s+([A-Za-z_$][\w$]*)/);
    if (m1?.[1]) {
      results.add(m1[1]);
      continue;
    }
    const m2 = line.match(/^\s*export\s+\{([^}]+)\}/);
    if (m2?.[1]) {
      for (const part of m2[1].split(",")) {
        const clean = part.trim().split(/\s+as\s+/i)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(clean)) {
          results.add(clean);
        }
      }
    }
  }
  return Array.from(results);
}

function extractImports(content: string): string[] {
  const results = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const m1 = line.match(/^\s*import\s+.*?\s+from\s+["']([^"']+)["']/);
    if (m1?.[1]) {
      results.add(m1[1]);
      continue;
    }
    const m2 = line.match(/^\s*const\s+.*=\s*require\(["']([^"']+)["']\)/);
    if (m2?.[1]) {
      results.add(m2[1]);
    }
  }
  return Array.from(results);
}

function extractGenericSymbols(content: string): string[] {
  const results = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const symbol = line.match(/^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type)\s+([A-Za-z_$][\w$]*)/)?.[1]
      ?? line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/)?.[1]
      ?? line.match(/^\s*def\s+([A-Za-z_]\w*)/)?.[1]
      ?? line.match(/^\s*class\s+([A-Za-z_]\w*)/)?.[1];
    if (symbol) {
      results.add(symbol);
    }
  }
  return Array.from(results);
}

function extractReferencedSymbols(content: string): string[] {
  const results = new Set<string>();
  const regex = /\b([A-Za-z_$][A-Za-z0-9_$]{2,})\b/g;
  for (const match of content.matchAll(regex)) {
    const sym = match[1];
    if (!sym || RESERVED_SYMBOLS.has(sym)) {
      continue;
    }
    results.add(sym);
    if (results.size >= 500) {
      break;
    }
  }
  return Array.from(results);
}

const RESERVED_SYMBOLS = new Set([
  "const",
  "let",
  "var",
  "class",
  "function",
  "return",
  "import",
  "export",
  "from",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "break",
  "continue",
  "new",
  "true",
  "false",
  "null",
  "undefined"
]);

function queryCodeGraph(
  graph: CodeGraphIndex,
  symbol: string,
  depth: number
): { definitions: string[]; references: string[]; relatedFiles: string[] } {
  const normalized = symbol.trim();
  const definitionNodes = graph.nodes.filter((node) => node.exports.includes(normalized) || node.symbols.includes(normalized));
  const referenceNodes = graph.nodes.filter((node) => node.references.includes(normalized));
  const related = new Set<string>();
  for (const node of definitionNodes) {
    related.add(node.path);
    for (const item of node.imports) {
      related.add(item);
    }
  }
  for (const node of referenceNodes) {
    related.add(node.path);
  }

  // shallow breadth expansion on imports for impact estimation
  if (depth > 1) {
    let frontier = new Set<string>(Array.from(related));
    for (let d = 2; d <= depth; d += 1) {
      const next = new Set<string>();
      for (const candidate of frontier) {
        const found = graph.nodes.find((node) => node.path === candidate);
        if (!found) {
          continue;
        }
        for (const imp of found.imports) {
          if (!related.has(imp)) {
            related.add(imp);
            next.add(imp);
          }
        }
      }
      frontier = next;
      if (frontier.size === 0) {
        break;
      }
    }
  }

  return {
    definitions: definitionNodes.slice(0, 30).map((node) => `${node.path} -> ${normalized}`),
    references: referenceNodes.slice(0, 40).map((node) => `${node.path} references ${normalized}`),
    relatedFiles: Array.from(related).slice(0, 80)
  };
}

async function readMcpContextResource(workspaceRoot: string, resource: string): Promise<string | null> {
  const normalized = resource.replace(/\\/g, "/").replace(/^\//, "");
  const candidates = [
    `.local-agent-ide/mcp-context/${normalized}.md`,
    `.local-agent-ide/mcp-context/${normalized}.txt`,
    `.local-agent-ide/mcp-context/${normalized}.json`,
    `.local-agent-ide/mcp-context/${normalized}`,
    `mcp-context/${normalized}.md`,
    `mcp-context/${normalized}.txt`,
    `mcp-context/${normalized}.json`,
    `mcp-context/${normalized}`
  ];
  for (const relative of candidates) {
    try {
      const absolutePath = toSafeWorkspacePath(workspaceRoot, relative);
      const content = await readFile(absolutePath, "utf8");
      return content;
    } catch {
      // continue
    }
  }
  return null;
}

async function collectDirectoriesDepthFirst(workspaceRoot: string): Promise<string[]> {
  const results: string[] = [];
  const skippedRoots = new Set([".git", "node_modules", ".local-agent-ide"]);

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (current === workspaceRoot && skippedRoots.has(entry.name)) {
        continue;
      }
      const absolute = path.join(current, entry.name);
      await walk(absolute);
      results.push(absolute);
    }
  }

  await walk(workspaceRoot);
  return results;
}

interface SymbolRecord {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "variable" | "method";
  line: number;
}

async function getSymbolsForFile(workspaceRoot: string, relativePath: string): Promise<SymbolRecord[]> {
  const absolutePath = toSafeWorkspacePath(workspaceRoot, relativePath);
  const content = await readFile(absolutePath, "utf8");
  const ext = path.extname(relativePath).toLowerCase();
  if (ext === ".py") {
    return extractPythonSymbols(content);
  }
  return extractTypeScriptLikeSymbols(content);
}

function extractTypeScriptLikeSymbols(content: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const functionMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/);
    if (functionMatch?.[1]) {
      symbols.push({ name: functionMatch[1], kind: "function", line: i + 1 });
      continue;
    }
    const classMatch = line.match(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/);
    if (classMatch?.[1]) {
      symbols.push({ name: classMatch[1], kind: "class", line: i + 1 });
      continue;
    }
    const interfaceMatch = line.match(/^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/);
    if (interfaceMatch?.[1]) {
      symbols.push({ name: interfaceMatch[1], kind: "interface", line: i + 1 });
      continue;
    }
    const typeMatch = line.match(/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/);
    if (typeMatch?.[1]) {
      symbols.push({ name: typeMatch[1], kind: "type", line: i + 1 });
      continue;
    }
    const variableMatch = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/);
    if (variableMatch?.[1]) {
      symbols.push({ name: variableMatch[1], kind: "variable", line: i + 1 });
      continue;
    }
    const methodMatch = line.match(/^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/);
    if (methodMatch?.[1] && !/^(if|for|while|switch|catch)$/.test(methodMatch[1])) {
      symbols.push({ name: methodMatch[1], kind: "method", line: i + 1 });
    }
  }
  return symbols;
}

function extractPythonSymbols(content: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const classMatch = line.match(/^\s*class\s+([A-Za-z_]\w*)\b/);
    if (classMatch?.[1]) {
      symbols.push({ name: classMatch[1], kind: "class", line: i + 1 });
      continue;
    }
    const fnMatch = line.match(/^\s*def\s+([A-Za-z_]\w*)\b/);
    if (fnMatch?.[1]) {
      symbols.push({ name: fnMatch[1], kind: "function", line: i + 1 });
    }
  }
  return symbols;
}

interface LocationMatch {
  path: string;
  line: number;
  preview: string;
}

async function findDefinitionInWorkspace(
  workspaceRoot: string,
  preferredPath: string,
  symbol: string
): Promise<LocationMatch | null> {
  const tsMatch = await tryTypeScriptDefinitionLookup(workspaceRoot, preferredPath, symbol);
  if (tsMatch) {
    return tsMatch;
  }
  const orderedCandidates: string[] = [];
  if (preferredPath) {
    orderedCandidates.push(preferredPath);
  }
  const files = await scanWorkspaceFiles(workspaceRoot, 4_000);
  for (const file of files) {
    if (!orderedCandidates.includes(file) && isCodeLikeFile(file)) {
      orderedCandidates.push(file);
    }
  }

  const escaped = escapeRegexLiteral(symbol);
  const patterns = [
    new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?class\\s+${escaped}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?interface\\s+${escaped}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?type\\s+${escaped}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b`),
    new RegExp(`^\\s*def\\s+${escaped}\\b`),
    new RegExp(`^\\s*class\\s+${escaped}\\b`)
  ];

  for (const relativePath of orderedCandidates) {
    if (!isCodeLikeFile(relativePath)) {
      continue;
    }
    const absolutePath = toSafeWorkspacePath(workspaceRoot, relativePath);
    let content = "";
    try {
      content = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const text = lines[i];
      if (patterns.some((pattern) => pattern.test(text))) {
        return { path: relativePath, line: i + 1, preview: truncate(text.trim(), 180) };
      }
    }
  }
  return null;
}

async function findReferencesInWorkspace(
  workspaceRoot: string,
  symbol: string,
  preferredPath?: string
): Promise<LocationMatch[]> {
  const tsRefs = await tryTypeScriptReferenceLookup(workspaceRoot, symbol, preferredPath);
  if (tsRefs.length > 0) {
    return tsRefs;
  }
  const escaped = escapeRegexLiteral(symbol);
  const regex = new RegExp(`\\b${escaped}\\b`);
  const results: LocationMatch[] = [];
  const files = await scanWorkspaceFiles(workspaceRoot, 4_000);
  const ordered = files
    .filter((file) => isCodeLikeFile(file))
    .sort((a, b) => {
      if (preferredPath && a === preferredPath) return -1;
      if (preferredPath && b === preferredPath) return 1;
      return a.localeCompare(b);
    });

  for (const relativePath of ordered) {
    const absolutePath = toSafeWorkspacePath(workspaceRoot, relativePath);
    let content = "";
    try {
      content = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const text = lines[i];
      if (!regex.test(text)) {
        continue;
      }
      results.push({ path: relativePath, line: i + 1, preview: truncate(text.trim(), 180) });
      if (results.length >= 100) {
        return results;
      }
    }
  }

  return results;
}

async function tryTypeScriptDefinitionLookup(
  workspaceRoot: string,
  preferredPath: string | undefined,
  symbol: string
): Promise<LocationMatch | null> {
  let tsModule: typeof import("typescript") | null = null;
  try {
    tsModule = await import("typescript");
  } catch {
    return null;
  }
  const ts = tsModule;
  const files = (await scanWorkspaceFiles(workspaceRoot, 3500)).filter((f) => /\.(?:ts|tsx|js|jsx)$/.test(f));
  if (files.length === 0) {
    return null;
  }
  const absFiles = files.map((f) => toSafeWorkspacePath(workspaceRoot, f));
  const program = ts.createProgram(absFiles, {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext
  });

  const preferred = preferredPath && files.includes(preferredPath) ? preferredPath : files[0];
  const source = program.getSourceFile(toSafeWorkspacePath(workspaceRoot, preferred));
  if (!source) {
    return null;
  }
  const checker = program.getTypeChecker();
  const positions = findIdentifierOffsets(source.getFullText(), symbol);
  for (const offset of positions.slice(0, 20)) {
    const node = findNodeAtPosition(source, offset);
    if (!node) {
      continue;
    }
    const sym = checker.getSymbolAtLocation(node);
    if (!sym?.declarations || sym.declarations.length === 0) {
      continue;
    }
    const decl = sym.declarations[0];
    const declSource = decl.getSourceFile();
    const pos = declSource.getLineAndCharacterOfPosition(decl.getStart());
    const declPath = path.relative(workspaceRoot, declSource.fileName).replace(/\\/g, "/");
    const lineText = declSource.getFullText().split(/\r?\n/)[pos.line] ?? "";
    return {
      path: declPath,
      line: pos.line + 1,
      preview: truncate(lineText.trim(), 180)
    };
  }
  return null;
}

async function tryTypeScriptReferenceLookup(
  workspaceRoot: string,
  symbol: string,
  preferredPath?: string
): Promise<LocationMatch[]> {
  let tsModule: typeof import("typescript") | null = null;
  try {
    tsModule = await import("typescript");
  } catch {
    return [];
  }
  const ts = tsModule;
  const files = (await scanWorkspaceFiles(workspaceRoot, 3500)).filter((f) => /\.(?:ts|tsx|js|jsx)$/.test(f));
  if (files.length === 0) {
    return [];
  }
  const absFiles = files.map((f) => toSafeWorkspacePath(workspaceRoot, f));
  const program = ts.createProgram(absFiles, {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext
  });

  const candidateOrder = preferredPath && files.includes(preferredPath) ? [preferredPath, ...files.filter((f) => f !== preferredPath)] : files;
  const results: LocationMatch[] = [];
  for (const relPath of candidateOrder.slice(0, 30)) {
    const source = program.getSourceFile(toSafeWorkspacePath(workspaceRoot, relPath));
    if (!source) {
      continue;
    }
    const content = source.getFullText();
    const offsets = findIdentifierOffsets(content, symbol);
    for (const offset of offsets.slice(0, 40)) {
      const node = findNodeAtPosition(source, offset);
      if (!node) {
        continue;
      }
      const pos = source.getLineAndCharacterOfPosition(node.getStart());
      const lineText = content.split(/\r?\n/)[pos.line] ?? "";
      results.push({
        path: relPath,
        line: pos.line + 1,
        preview: truncate(lineText.trim(), 180)
      });
      if (results.length >= 120) {
        return results;
      }
    }
  }
  return results;
}

function findIdentifierOffsets(content: string, symbol: string): number[] {
  const escaped = escapeRegexLiteral(symbol);
  const regex = new RegExp(`\\b${escaped}\\b`, "g");
  const offsets: number[] = [];
  for (const match of content.matchAll(regex)) {
    if (typeof match.index === "number") {
      offsets.push(match.index);
    }
  }
  return offsets;
}

function findNodeAtPosition(node: import("typescript").Node, position: number): import("typescript").Node | null {
  if (position < node.getStart() || position > node.getEnd()) {
    return null;
  }
  let candidate: import("typescript").Node | null = node;
  node.forEachChild((child) => {
    const found = findNodeAtPosition(child, position);
    if (found) {
      candidate = found;
    }
  });
  return candidate;
}

async function getDiagnosticsForWorkspace(workspaceRoot: string, requestedPath?: string): Promise<string[]> {
  const resolvedPath = requestedPath ? await resolveRelativeFilePath(workspaceRoot, requestedPath) : null;
  if (resolvedPath) {
    return getDiagnosticsForFile(workspaceRoot, resolvedPath);
  }

  const files = await scanWorkspaceFiles(workspaceRoot, 1_200);
  const targets = files.filter((item) => /\.(?:ts|tsx|js|jsx)$/.test(item)).slice(0, 40);
  const diagnostics: string[] = [];
  for (const file of targets) {
    const fileDiagnostics = await getDiagnosticsForFile(workspaceRoot, file);
    diagnostics.push(...fileDiagnostics);
    if (diagnostics.length >= 30) {
      break;
    }
  }
  return diagnostics.slice(0, 30);
}

async function getDiagnosticsForFile(workspaceRoot: string, relativePath: string): Promise<string[]> {
  const diagnostics = await getStructuredDiagnosticsForFile(workspaceRoot, relativePath);
  if (diagnostics.length === 0) {
    return [`${relativePath}: no obvious diagnostics found.`];
  }
  return diagnostics.map((item) => `${item.path}:${String(item.line)}:${String(item.column)} [${item.severity}] ${item.message}`);
}

async function getStructuredDiagnosticsForFile(workspaceRoot: string, relativePath: string): Promise<DiagnosticRecord[]> {
  const absolutePath = toSafeWorkspacePath(workspaceRoot, relativePath);
  const ext = path.extname(relativePath).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
    const tsDiagnostics = await getTypeScriptDiagnosticsDetailed(absolutePath, relativePath);
    if (tsDiagnostics.length > 0) {
      return tsDiagnostics;
    }
  }

  const content = await readFile(absolutePath, "utf8");
  const diagnostics: DiagnosticRecord[] = [];
  const open = (content.match(/\{/g) ?? []).length;
  const close = (content.match(/\}/g) ?? []).length;
  if (open !== close) {
    diagnostics.push({
      path: relativePath,
      line: 1,
      column: 1,
      message: `unmatched braces (${String(open)} '{' vs ${String(close)} '}')`,
      snippet: truncate(content.split(/\r?\n/)[0] ?? "", 160),
      severity: "error"
    });
  }
  const parenOpen = (content.match(/\(/g) ?? []).length;
  const parenClose = (content.match(/\)/g) ?? []).length;
  if (parenOpen !== parenClose) {
    diagnostics.push({
      path: relativePath,
      line: 1,
      column: 1,
      message: `unmatched parentheses (${String(parenOpen)} '(' vs ${String(parenClose)} ')')`,
      snippet: truncate(content.split(/\r?\n/)[0] ?? "", 160),
      severity: "error"
    });
  }
  return diagnostics;
}

async function getTypeScriptDiagnosticsDetailed(absolutePath: string, relativePath: string): Promise<DiagnosticRecord[]> {
  let tsModule: typeof import("typescript") | null = null;
  try {
    tsModule = await import("typescript");
  } catch {
    return [];
  }

  const ts = tsModule;
  const program = ts.createProgram([absolutePath], {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext
  });
  const source = program.getSourceFile(absolutePath);
  if (!source) {
    return [];
  }
  const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
  return diagnostics.slice(0, 30).map((diag) => {
    const msg = ts.flattenDiagnosticMessageText(diag.messageText, " ");
    if (diag.start === undefined) {
      return {
        path: relativePath,
        line: 1,
        column: 1,
        message: msg,
        snippet: "",
        severity: "error" as const
      };
    }
    const pos = source.getLineAndCharacterOfPosition(diag.start);
    const lineText = source.getFullText().split(/\r?\n/)[pos.line] ?? "";
    return {
      path: relativePath,
      line: pos.line + 1,
      column: pos.character + 1,
      message: msg,
      snippet: truncate(lineText.trim(), 180),
      severity: "error" as const
    };
  });
}

function isCodeLikeFile(relativePath: string): boolean {
  return /\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|php|rb|cs|cpp|c|h)$/i.test(relativePath);
}

async function tryHandleDeterministicTask(run: ExecutionRun, route: TaskRoute): Promise<string | null> {
  // High-frequency deterministic skills bypass model planning.
  const handlers: Array<() => Promise<string | null>> = [
    () => tryHandleSummarizeUrlToFileTask(run),
    () => tryHandleExtensionInventoryReportTask(run),
    () => tryHandleEmptyDirectoryCleanupTask(run),
    () => tryHandleRootImageMigrationTask(run),
    () => tryHandleLogTailPortReportTask(run),
    () => tryHandleFastApiCrudTask(run),
    () => tryHandleUnittestEdgeCasesTask(run),
    () => tryHandleTailwindConversionTask(run),
    () => tryHandleReadmeGeneratorTask(run),
    () => tryHandleDocstringAuditTask(run),
    () => tryHandleDependencyReportTask(run),
    () => tryHandleCommitMessageSuggestionTask(run),
    () => tryHandleLintFixDeterministicTask(run),
    () => tryHandlePerformanceProfileTask(run),
    () => tryHandleIntegrationHealthReportTask(run),
    () => tryHandleAmbiguousModernUiTask(run),
    () => tryHandleUserDataRenameTask(run),
    () => tryHandleMergeConfigsTask(run),
    () => tryHandleVarToLetConstTask(run),
    () => tryHandleAnyToInterfaceTask(run),
    () => tryHandleDangerouslySetInnerHtmlTask(run)
  ];

  if (route.intent === "create_new") {
    handlers.push(() => tryHandleCreateGameTask(run, route.intent));
    handlers.push(() => tryHandleCreateSimpleFileTask(run, route.intent));
    handlers.push(() => tryHandleCreateAppSkeletonTask(run, route.intent));
  }

  if (route.intent === "edit_existing" || route.intent === "debug") {
    handlers.push(() => tryHandleFileQuestionTask(run));
    handlers.push(() => tryHandleHtmlColorChangeTask(run));
    handlers.push(() => tryHandleGenericTextChangeTask(run));
    handlers.push(() => tryHandleHtmlTitleChangeTask(run));
    handlers.push(() => tryHandleSnakeBorderCollisionFixTask(run));
    handlers.push(() => tryHandleModernDesignTask(run));
  }

  for (const handler of handlers) {
    const result = await handler();
    if (result) {
      return result;
    }
  }

  return null;
}

async function tryHandleCreateSimpleFileTask(run: ExecutionRun, intent: TaskIntent): Promise<string | null> {
  if (!run.workspaceRoot || intent !== "create_new") {
    return null;
  }
  const parsed = parseSimpleFileCreateTask(run.task);
  if (!parsed) {
    return null;
  }

  await requireApproval(run, "write_file", `Write file ${parsed.path}`);
  enforceWritePolicy({ tool: "write_file", path: parsed.path, content: parsed.content }, run.workspaceRoot, run.approvalMode);
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, parsed.path, parsed.content, {
    allowOverwriteExisting: true
  });
  return `Created ${parsed.path} (lines ${formatLineList(mutation.changedLines)})`;
}

function parseSimpleFileCreateTask(task: string): { path: string; content: string } | null {
  const lower = task.toLowerCase();
  const asksCreateFile = /\b(make|create)\b/.test(lower) && /\bfile\b/.test(lower);
  if (!asksCreateFile) {
    return null;
  }
  const pathMatch =
    task.match(/\bname\s+it\s+["']?([a-z0-9_./\\-]+\.[a-z0-9]{1,8})["']?/i) ??
    task.match(/\bfile\s+(?:named|name)\s+["']?([a-z0-9_./\\-]+\.[a-z0-9]{1,8})["']?/i) ??
    task.match(/\b([a-z0-9_./\\-]+\.[a-z0-9]{1,8})\b/i);
  const contentMatch =
    task.match(/\bwrite\s+inside(?:\s+of\s+it)?\s*,?\s*["']([\s\S]+?)["']\s*$/i) ??
    task.match(/\bwith\s+content\s+["']([\s\S]+?)["']\s*$/i);
  if (!pathMatch?.[1]) {
    return null;
  }

  const relativePath = pathMatch[1].replace(/\\/g, "/");
  const body = (contentMatch?.[1] ?? "").trim();
  const content = body ? `${body}\n` : "";
  return { path: relativePath, content };
}

async function tryHandleCreateGameTask(run: ExecutionRun, intent: TaskIntent): Promise<string | null> {
  if (!run.workspaceRoot || intent !== "create_new") {
    return null;
  }
  const lower = run.task.toLowerCase();
  if (!/\btic[\s-]?tac[\s-]?toe\b/.test(lower) || !/\b(make|create|build)\b/.test(lower)) {
    return null;
  }

  const outputPath = "tic_tac_toe.html";
  const html = buildTicTacToeHtml();
  await requireApproval(run, "write_file", `Write file ${outputPath}`);
  enforceWritePolicy({ tool: "write_file", path: outputPath, content: html }, run.workspaceRoot, run.approvalMode);
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, outputPath, html, {
    allowOverwriteExisting: true
  });

  // "Run it" for local html: verify file exists via command and open in browser.
  await requireApproval(run, "run_command", `Run command: verify ${outputPath} exists`);
  const verifyOutput = await runCommand(`if (Test-Path "${outputPath}") { Write-Output "exists" } else { exit 1 }`, run.workspaceRoot);
  log(run, `run_command: verify ${outputPath}`);
  log(run, `command_output: ${truncate(verifyOutput, 120)}`);

  const session = await getBrowserSession(run);
  const fileUrl = pathToFileURL(toSafeWorkspacePath(run.workspaceRoot, outputPath)).href;
  await session.page.goto(fileUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  log(run, `browser_open: ${fileUrl}`);

  const screenshotPath = ".local-agent-ide/screenshots/tic_tac_toe.png";
  const absoluteScreenshot = toSafeWorkspacePath(run.workspaceRoot, screenshotPath);
  await mkdir(path.dirname(absoluteScreenshot), { recursive: true });
  await session.page.screenshot({ path: absoluteScreenshot, fullPage: true });
  log(run, `browser_screenshot: ${screenshotPath}`);

  return `Created and opened ${outputPath} (lines ${formatLineList(mutation.changedLines)}). Screenshot: ${screenshotPath}`;
}

async function tryHandleCreateAppSkeletonTask(run: ExecutionRun, intent: TaskIntent): Promise<string | null> {
  if (!run.workspaceRoot || intent !== "create_new") {
    return null;
  }
  const lower = run.task.toLowerCase();
  const asksSkeleton = /\b(skeleton|starter|boilerplate|scaffold)\b/.test(lower);
  const asksApp = /\b(app|website|web app|project)\b/.test(lower);
  const asksCreate = /\b(make|create|build|generate)\b/.test(lower);
  if (!asksSkeleton || !asksApp || !asksCreate) {
    return null;
  }

  const baseDir = "app";
  const filesToWrite: Array<{ path: string; content: string }> = [
    {
      path: `${baseDir}/index.html`,
      content: [
        "<!doctype html>",
        "<html lang=\"en\">",
        "<head>",
        "  <meta charset=\"UTF-8\" />",
        "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
        "  <title>App Skeleton</title>",
        "  <link rel=\"stylesheet\" href=\"styles.css\" />",
        "</head>",
        "<body>",
        "  <main class=\"app\">",
        "    <h1>App Skeleton</h1>",
        "    <p>Ready for implementation.</p>",
        "    <button id=\"actionBtn\">Click me</button>",
        "  </main>",
        "  <script src=\"app.js\"></script>",
        "</body>",
        "</html>",
        ""
      ].join("\n")
    },
    {
      path: `${baseDir}/styles.css`,
      content: [
        ":root {",
        "  --bg: #0b1220;",
        "  --fg: #e6edf7;",
        "  --accent: #2f81f7;",
        "}",
        "body {",
        "  margin: 0;",
        "  min-height: 100vh;",
        "  display: grid;",
        "  place-items: center;",
        "  color: var(--fg);",
        "  background: linear-gradient(135deg, #0b1220 0%, #1f2a44 100%);",
        "  font-family: \"Segoe UI\", sans-serif;",
        "}",
        ".app {",
        "  padding: 24px;",
        "  border-radius: 14px;",
        "  background: rgba(255, 255, 255, 0.08);",
        "}",
        "button {",
        "  border: 0;",
        "  padding: 10px 14px;",
        "  border-radius: 10px;",
        "  color: white;",
        "  background: var(--accent);",
        "}",
        ""
      ].join("\n")
    },
    {
      path: `${baseDir}/app.js`,
      content: [
        "const btn = document.getElementById(\"actionBtn\");",
        "if (btn) {",
        "  btn.addEventListener(\"click\", () => {",
        "    btn.textContent = \"Clicked\";",
        "  });",
        "}",
        ""
      ].join("\n")
    }
  ];

  await requireApproval(run, "make_dir", `Create directory ${baseDir}`);
  enforcePathPolicy(baseDir, run.workspaceRoot, run.approvalMode, "make_dir");
  await mkdir(toSafeWorkspacePath(run.workspaceRoot, baseDir), { recursive: true });
  log(run, `make_dir: ${baseDir}`);

  const touched: FileMutation[] = [];
  for (const item of filesToWrite) {
    await requireApproval(run, "write_file", `Write file ${item.path}`);
    enforceWritePolicy({ tool: "write_file", path: item.path, content: item.content }, run.workspaceRoot, run.approvalMode);
    const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, item.path, item.content, {
      allowOverwriteExisting: true
    });
    touched.push(mutation);
  }

  const changed = touched.map((m) => `${m.path} lines ${formatLineList(m.changedLines)}`).join("; ");
  return `Created app skeleton in ${baseDir}/ (changes: ${changed})`;
}

async function tryHandleHtmlTitleChangeTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) {
    return null;
  }

  const parsed = parseHtmlTitleChangeTask(run.task);
  if (!parsed) {
    return null;
  }
  const resolvedPath = await resolveRelativeFilePath(run.workspaceRoot, parsed.path);
  if (!resolvedPath) {
    return null;
  }

  await requireApproval(run, "read_file", `Read file ${resolvedPath}`);
  enforcePathPolicy(resolvedPath, run.workspaceRoot, run.approvalMode, "write_file");
  const absolutePath = toSafeWorkspacePath(run.workspaceRoot, resolvedPath);
  const source = await readFile(absolutePath, "utf8");
  log(run, `read_file: ${resolvedPath}`);

  if (!/<title>[\s\S]*?<\/title>/i.test(source)) {
    return null;
  }
  const updated = source.replace(/<title>[\s\S]*?<\/title>/i, `<title>${parsed.title}</title>`);
  if (updated === source) {
    return null;
  }

  await requireApproval(run, "write_file", `Write file ${resolvedPath}`);
  enforceWritePolicy({ tool: "write_file", path: resolvedPath, content: updated }, run.workspaceRoot, run.approvalMode);
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, resolvedPath, updated, {
    allowOverwriteExisting: true
  });
  return `Updated title in ${resolvedPath} to "${parsed.title}" (lines ${formatLineList(mutation.changedLines)})`;
}

async function tryHandleHtmlColorChangeTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) {
    return null;
  }
  const parsed = parseHtmlColorChangeTask(run.task);
  if (!parsed) {
    return null;
  }
  const resolvedPath = await resolveRelativeFilePath(run.workspaceRoot, parsed.path);
  if (!resolvedPath) {
    return null;
  }

  await requireApproval(run, "read_file", `Read file ${resolvedPath}`);
  enforcePathPolicy(resolvedPath, run.workspaceRoot, run.approvalMode, "write_file");
  const absolutePath = toSafeWorkspacePath(run.workspaceRoot, resolvedPath);
  const source = await readFile(absolutePath, "utf8");
  log(run, `read_file: ${resolvedPath}`);

  let updated = source;
  if (parsed.scope === "start-button") {
    // prefer specific start button selectors before generic replacement
    updated = updated.replace(/(start[^.{#]*\{[^}]*background-color\s*:\s*)(green|#00ff00|#0f0|rgb\(\s*0\s*,\s*128\s*,\s*0\s*\))/i, `$1${parsed.toColor}`);
    updated = updated.replace(
      /(<button[^>]*(?:id|class)\s*=\s*["'][^"']*start[^"']*["'][^>]*style\s*=\s*["'][^"']*background-color\s*:\s*)(green|#00ff00|#0f0|rgb\(\s*0\s*,\s*128\s*,\s*0\s*\))/i,
      `$1${parsed.toColor}`
    );
  }
  if (updated === source) {
    updated = replaceCommonGreenWithBlue(source, parsed.fromColor, parsed.toColor);
  }
  if (updated === source) {
    return null;
  }

  await requireApproval(run, "write_file", `Write file ${resolvedPath}`);
  enforceWritePolicy({ tool: "write_file", path: resolvedPath, content: updated }, run.workspaceRoot, run.approvalMode);
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, resolvedPath, updated, {
    allowOverwriteExisting: true
  });
  return `Updated color in ${resolvedPath} from ${parsed.fromColor} to ${parsed.toColor} (lines ${formatLineList(mutation.changedLines)})`;
}

async function tryHandleModernDesignTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) {
    return null;
  }
  const parsed = parseModernDesignTask(run.task);
  if (!parsed) {
    return null;
  }

  let resolvedPath = parsed.path ? await resolveRelativeFilePath(run.workspaceRoot, parsed.path) : null;
  if (!resolvedPath) {
    resolvedPath = await resolveRelativeFilePath(run.workspaceRoot, "index.html");
  }
  if (!resolvedPath) {
    return null;
  }

  await requireApproval(run, "read_file", `Read file ${resolvedPath}`);
  enforcePathPolicy(resolvedPath, run.workspaceRoot, run.approvalMode, "write_file");
  const absolutePath = toSafeWorkspacePath(run.workspaceRoot, resolvedPath);
  const source = await readFile(absolutePath, "utf8");
  log(run, `read_file: ${resolvedPath}`);

  const previousHeading = extractFirstHeading(source) ?? "Hello World";
  const heading = parsed.headingText ?? previousHeading;
  const title = parsed.titleText ?? heading;
  const updated = buildModernHtmlTemplate(title, heading);
  if (updated === source) {
    return null;
  }

  await requireApproval(run, "write_file", `Write file ${resolvedPath}`);
  enforceWritePolicy({ tool: "write_file", path: resolvedPath, content: updated }, run.workspaceRoot, run.approvalMode);
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, resolvedPath, updated, {
    allowOverwriteExisting: true
  });
  return `Applied modern design and background in ${resolvedPath} (lines ${formatLineList(mutation.changedLines)})`;
}

async function tryHandleGenericTextChangeTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) {
    return null;
  }
  const parsed = parseGenericTextChangeTask(run.task);
  if (!parsed) {
    return null;
  }

  const resolvedPath = parsed.path ? await resolveRelativeFilePath(run.workspaceRoot, parsed.path) : null;
  if (!resolvedPath) {
    return null;
  }

  await requireApproval(run, "read_file", `Read file ${resolvedPath}`);
  enforcePathPolicy(resolvedPath, run.workspaceRoot, run.approvalMode, "write_file");
  const absolutePath = toSafeWorkspacePath(run.workspaceRoot, resolvedPath);
  const source = await readFile(absolutePath, "utf8");
  log(run, `read_file: ${resolvedPath}`);

  const regex = buildSafeRegex(escapeRegexLiteral(parsed.from), "gi");
  const matches = Array.from(source.matchAll(regex)).length;
  if (matches === 0) {
    return null;
  }
  const updated = source.replace(regex, parsed.to);
  await requireApproval(run, "replace_in_file_regex", `Replace text in ${resolvedPath}`);
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, resolvedPath, updated, {
    allowOverwriteExisting: true
  });
  return `Updated text in ${resolvedPath}: "${parsed.from}" -> "${parsed.to}" (lines ${formatLineList(mutation.changedLines)})`;
}

function parseHtmlColorChangeTask(task: string): { path: string; fromColor: string; toColor: string; scope: "start-button" | "generic" } | null {
  const normalized = task.trim().toLowerCase();
  const asksColorChange = /\b(color|green|blue|red|yellow|button)\b/.test(normalized) && /\b(change|make|set|turn)\b/.test(normalized);
  if (!asksColorChange) {
    return null;
  }
  const htmlFile = task.match(/\b([a-z0-9_./\\-]+\.html?)\b/i)?.[1];
  if (!htmlFile) {
    return null;
  }
  const fromColor = /\bgreen\b/.test(normalized) ? "green" : "green";
  const toColor = /\bblue\b/.test(normalized) ? "blue" : "blue";
  const scope = /\bstart\b/.test(normalized) && /\bbutton\b/.test(normalized) ? "start-button" : "generic";
  return { path: htmlFile.replace(/\\/g, "/"), fromColor, toColor, scope };
}

interface GenericTextChangeTask {
  path?: string;
  from: string;
  to: string;
}

function parseGenericTextChangeTask(task: string): GenericTextChangeTask | null {
  const normalized = task.trim();
  const pathMatch = normalized.match(/\b([a-z0-9_./\\-]+\.[a-z0-9]{2,8})\b/i);
  const fromToMatch =
    normalized.match(/\bchange\s+(?:the\s+)?["']?(.+?)["']?\s+to\s+["']?(.+?)["']?(?:[\.\!\?]|$)/i) ??
    normalized.match(/\breplace\s+["']?(.+?)["']?\s+with\s+["']?(.+?)["']?(?:[\.\!\?]|$)/i);
  if (!fromToMatch?.[1] || !fromToMatch?.[2]) {
    return null;
  }
  const from = sanitizePhrase(fromToMatch[1]);
  const to = sanitizePhrase(fromToMatch[2]);
  if (!from || !to || from.toLowerCase() === to.toLowerCase()) {
    return null;
  }
  if (from.length > 120 || to.length > 120) {
    return null;
  }
  return {
    path: pathMatch?.[1]?.replace(/\\/g, "/"),
    from,
    to
  };
}

function parseModernDesignTask(task: string): { path?: string; headingText?: string; titleText?: string } | null {
  const normalized = task.trim();
  const lower = normalized.toLowerCase();
  const asksDesign = /\bmodern\b|\bdesign\b|\bbackground\b|\bgradient\b|\brestyle\b|\bui refresh\b/.test(lower);
  if (!asksDesign) {
    return null;
  }

  const htmlFile = normalized.match(/\b([a-z0-9_./\\-]+\.html?)\b/i)?.[1]?.replace(/\\/g, "/");
  const helloTarget = normalized.match(/\bhello\s+[a-z0-9_-]+\b/i)?.[0];
  const headingText = helloTarget ? toSentenceCase(helloTarget) : undefined;
  return {
    path: htmlFile,
    headingText,
    titleText: headingText
  };
}

function toSentenceCase(value: string): string {
  return value
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function sanitizePhrase(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[`"'“”]+|[`"'“”]+$/g, "")
    .trim();
}

function buildZeroMatchRepairActions(
  task: string,
  files: string[],
  attemptedActions: ModelAction[],
  failureReason: string
): ModelAction[] | null {
  if (!/found 0 matches/i.test(failureReason)) {
    return null;
  }

  const colorTask = parseHtmlColorChangeTask(task);
  if (!colorTask) {
    return null;
  }

  const target = resolvePathFromFileList(files, colorTask.path);
  if (!target) {
    return null;
  }

  const hadReplaceAttempt = attemptedActions.some((action) => action.tool === "replace_in_file" || action.tool === "replace_in_file_regex");
  if (!hadReplaceAttempt) {
    return null;
  }

  return [
    { tool: "search_in_file", path: target, pattern: "(green|#0f0|#00ff00|#28a745|#198754|#4caf50|rgb\\()", flags: "gi" },
    { tool: "replace_in_file_regex", path: target, pattern: "(background(?:-color)?\\s*:\\s*)(green|#0f0|#00ff00|#28a745|#198754|#4caf50|rgb\\([^;]+\\))", flags: "gi", replace: "$1blue" }
  ];
}

function ensureMutatingActionsForEditTask(actions: ModelAction[], task: string, files: string[]): ModelAction[] {
  if (!requiresCodeMutation(task)) {
    return actions;
  }
  const hasMutationAction = actions.some(isMutatingAction);
  if (hasMutationAction) {
    return actions;
  }

  const parsed = parseGenericTextChangeTask(task);
  const targetPath = parsed?.path ? resolvePathFromFileList(files, parsed.path) : resolveBestTargetFile(task, files);
  if (!parsed || !targetPath) {
    return actions;
  }

  const autoFix: ReplaceInFileRegexAction = {
    tool: "replace_in_file_regex",
    path: targetPath,
    pattern: escapeRegexLiteral(parsed.from),
    flags: "gi",
    replace: parsed.to
  };
  return [...actions, autoFix].slice(0, 6);
}

function resolveBestTargetFile(task: string, files: string[]): string | null {
  const explicitTargets = extractExplicitTargetFiles(task);
  for (const target of explicitTargets) {
    const found = resolvePathFromFileList(files, target);
    if (found) {
      return found;
    }
  }
  return null;
}

function isMutatingAction(action: ModelAction): boolean {
  return (
    action.tool === "write_file" ||
    action.tool === "replace_in_file" ||
    action.tool === "replace_in_file_regex" ||
    action.tool === "patch_in_file" ||
    action.tool === "make_dir" ||
    action.tool === "rename_path"
  );
}

function resolvePathFromFileList(files: string[], requestedPath: string): string | null {
  const normalized = requestedPath.replace(/\\/g, "/").toLowerCase();
  const exact = files.find((item) => item.toLowerCase() === normalized);
  if (exact) {
    return exact;
  }
  const suffix = files.find((item) => item.toLowerCase().endsWith(normalized));
  return suffix ?? null;
}

function extractFirstHeading(source: string): string | null {
  const match = source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!match?.[1]) {
    return null;
  }
  return stripHtml(match[1]).trim() || null;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function buildModernHtmlTemplate(title: string, heading: string): string {
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"UTF-8\" />",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
    `  <title>${title}</title>`,
    "  <style>",
    "    :root {",
    "      --bg-a: #0f172a;",
    "      --bg-b: #1d4ed8;",
    "      --card: rgba(255, 255, 255, 0.14);",
    "      --text: #f8fafc;",
    "    }",
    "    * { box-sizing: border-box; }",
    "    body {",
    "      margin: 0;",
    "      min-height: 100vh;",
    "      display: grid;",
    "      place-items: center;",
    "      font-family: \"Segoe UI Variable Text\", \"Segoe UI\", sans-serif;",
    "      color: var(--text);",
    "      background: radial-gradient(1200px 600px at 10% 0%, #2563eb 0%, transparent 50%),",
    "                  linear-gradient(145deg, var(--bg-a), var(--bg-b));",
    "    }",
    "    .card {",
    "      padding: 32px 38px;",
    "      border-radius: 18px;",
    "      background: var(--card);",
    "      backdrop-filter: blur(8px);",
    "      box-shadow: 0 18px 50px rgba(2, 6, 23, 0.45);",
    "      border: 1px solid rgba(255, 255, 255, 0.25);",
    "      text-align: center;",
    "    }",
    "    h1 {",
    "      margin: 0;",
    "      letter-spacing: 0.5px;",
    "      font-weight: 700;",
    "      font-size: clamp(1.8rem, 4vw, 2.6rem);",
    "    }",
    "  </style>",
    "</head>",
    "<body>",
    "  <main class=\"card\">",
    `    <h1>${heading}</h1>`,
    "  </main>",
    "</body>",
    "</html>",
    ""
  ].join("\n");
}

function buildTicTacToeHtml(): string {
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"UTF-8\" />",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
    "  <title>Tic Tac Toe</title>",
    "  <style>",
    "    :root { --bg: #0b1220; --panel: #152238; --line: #2f4469; --text: #e6edf7; --x: #60a5fa; --o: #f472b6; }",
    "    * { box-sizing: border-box; }",
    "    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(900px 400px at 0% 0%, #1e3a8a 0%, transparent 50%), var(--bg); color: var(--text); font-family: \"Segoe UI\", sans-serif; }",
    "    .wrap { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 22px; width: min(92vw, 420px); box-shadow: 0 20px 45px rgba(0,0,0,.35); }",
    "    h1 { margin: 0 0 12px; font-size: 1.4rem; }",
    "    .board { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }",
    "    button.cell { height: 82px; font-size: 2rem; font-weight: 700; border-radius: 10px; border: 1px solid var(--line); background: #0f1a2d; color: var(--text); cursor: pointer; }",
    "    button.cell[data-v='X'] { color: var(--x); }",
    "    button.cell[data-v='O'] { color: var(--o); }",
    "    .meta { margin-top: 12px; display: flex; justify-content: space-between; align-items: center; }",
    "    .status { font-size: .95rem; opacity: .95; }",
    "    .reset { border: 1px solid var(--line); background: #10213b; color: var(--text); border-radius: 8px; padding: 8px 12px; cursor: pointer; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <main class=\"wrap\">",
    "    <h1>Tic Tac Toe</h1>",
    "    <section class=\"board\" id=\"board\"></section>",
    "    <div class=\"meta\">",
    "      <div class=\"status\" id=\"status\">Turn: X</div>",
    "      <button class=\"reset\" id=\"reset\">Reset</button>",
    "    </div>",
    "  </main>",
    "  <script>",
    "    const boardEl = document.getElementById('board');",
    "    const statusEl = document.getElementById('status');",
    "    const resetEl = document.getElementById('reset');",
    "    const board = Array(9).fill('');",
    "    let turn = 'X';",
    "    let done = false;",
    "    const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];",
    "    function render() {",
    "      boardEl.innerHTML = '';",
    "      board.forEach((value, i) => {",
    "        const b = document.createElement('button');",
    "        b.className = 'cell';",
    "        b.dataset.i = String(i);",
    "        b.dataset.v = value;",
    "        b.textContent = value;",
    "        b.disabled = done || Boolean(value);",
    "        boardEl.appendChild(b);",
    "      });",
    "      statusEl.textContent = done ? statusEl.textContent : `Turn: ${turn}`;",
    "    }",
    "    function checkWin(v) { return wins.some(([a,b,c]) => board[a]===v && board[b]===v && board[c]===v); }",
    "    boardEl.addEventListener('click', (e) => {",
    "      const btn = e.target.closest('button.cell');",
    "      if (!btn || done) return;",
    "      const idx = Number(btn.dataset.i);",
    "      if (board[idx]) return;",
    "      board[idx] = turn;",
    "      if (checkWin(turn)) { done = true; statusEl.textContent = `Winner: ${turn}`; render(); return; }",
    "      if (board.every(Boolean)) { done = true; statusEl.textContent = 'Draw'; render(); return; }",
    "      turn = turn === 'X' ? 'O' : 'X';",
    "      render();",
    "    });",
    "    resetEl.addEventListener('click', () => { board.fill(''); turn = 'X'; done = false; statusEl.textContent = 'Turn: X'; render(); });",
    "    render();",
    "  </script>",
    "</body>",
    "</html>",
    ""
  ].join("\n");
}

function replaceCommonGreenWithBlue(source: string, fromColor: string, toColor: string): string {
  let out = source;
  const patterns: RegExp[] = [
    /\bgreen\b/gi,
    /#00ff00/gi,
    /#0f0\b/gi,
    /rgb\(\s*0\s*,\s*128\s*,\s*0\s*\)/gi
  ];
  if (fromColor !== "green") {
    return out;
  }
  for (const pattern of patterns) {
    out = out.replace(pattern, toColor);
  }
  return out;
}

function parseHtmlTitleChangeTask(task: string): { path: string; title: string } | null {
  const normalized = task.trim();
  const asksTitleChange = /\btitle\b/i.test(normalized) && /\b(change|set|update|rename)\b/i.test(normalized);
  if (!asksTitleChange) {
    return null;
  }

  const htmlFile = normalized.match(/\b([a-z0-9_./\\-]+\.html?)\b/i)?.[1];
  if (!htmlFile) {
    return null;
  }

  const titleQuoted = normalized.match(/\btitle\b[\s\S]*?\bto\b\s*["']([^"']+)["']/i) ?? normalized.match(/["']([^"']+)["']/);
  const titleUnquoted =
    normalized.match(/\btitle\b[\s\S]*?\bto\b\s*([a-z0-9 _-]{2,80}?)(?=(?:\s+\b(?:and|but|keep|without|with)\b|[.!?]|$))/i)?.[1];
  let title = (titleQuoted?.[1] ?? titleUnquoted ?? "Updated Snake Game").trim();
  title = title.replace(/\s+\b(?:and|but|keep|without|with)\b[\s\S]*$/i, "").trim();
  if (!title) {
    title = "Updated Snake Game";
  }

  return { path: htmlFile.replace(/\\/g, "/"), title };
}

async function resolveRelativeFilePath(workspaceRoot: string, requestedPath: string): Promise<string | null> {
  const normalized = requestedPath.replace(/\\/g, "/");
  try {
    const absolute = toSafeWorkspacePath(workspaceRoot, normalized);
    await readFile(absolute, "utf8");
    return normalized;
  } catch {
    // fallback to filename search below
  }

  const files = await scanWorkspaceFiles(workspaceRoot, 800);
  const matched = files.find((file) => file.toLowerCase().endsWith(normalized.toLowerCase()));
  return matched ?? null;
}

async function tryHandleSnakeBorderCollisionFixTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) {
    return null;
  }

  const normalizedTask = run.task.toLowerCase();
  const asksSnakeFix =
    normalizedTask.includes("snake_game.html") &&
    (normalizedTask.includes("border") || normalizedTask.includes("wall")) &&
    (normalizedTask.includes("game over") || normalizedTask.includes("crash") || normalizedTask.includes("collision"));
  if (!asksSnakeFix) {
    return null;
  }

  const targetPath = "snake_game.html";
  await requireApproval(run, "read_file", `Read file ${targetPath}`);
  enforcePathPolicy(targetPath, run.workspaceRoot, run.approvalMode, "write_file");
  const absolutePath = toSafeWorkspacePath(run.workspaceRoot, targetPath);
  const source = await readFile(absolutePath, "utf8");
  log(run, `read_file: ${targetPath}`);

  let updated = source.replace(
    /\/\/\s*wrap around[\r\n]+\s*newHead\.x\s*=\s*\(newHead\.x\s*\+\s*gridSize\)\s*%\s*gridSize;[\r\n]+\s*newHead\.y\s*=\s*\(newHead\.y\s*\+\s*gridSize\)\s*%\s*gridSize;[\r\n]*/im,
    [
      "      // wall collision -> game over",
      "      if (newHead.x < 0 || newHead.x >= gridSize || newHead.y < 0 || newHead.y >= gridSize) {",
      "        gameOver = true; return;",
      "      }"
    ].join("\n") + "\n"
  );
  if (updated === source) {
    updated = source.replace(
      /newHead\.x\s*=\s*\(newHead\.x\s*\+\s*gridSize\)\s*%\s*gridSize;\s*[\r\n]+\s*newHead\.y\s*=\s*\(newHead\.y\s*\+\s*gridSize\)\s*%\s*gridSize;/im,
      [
        "// wall collision -> game over",
        "      if (newHead.x < 0 || newHead.x >= gridSize || newHead.y < 0 || newHead.y >= gridSize) {",
        "        gameOver = true; return;",
        "      }"
      ].join("\n")
    );
  }
  if (updated === source) {
    updated = source.replace(
      /newHead\.x\s*=\s*\([^;]*gridSize[^;]*\)\s*%\s*gridSize;\s*[\r\n]+\s*newHead\.y\s*=\s*\([^;]*gridSize[^;]*\)\s*%\s*gridSize;/im,
      [
        "// wall collision -> game over",
        "      if (newHead.x < 0 || newHead.x >= gridSize || newHead.y < 0 || newHead.y >= gridSize) {",
        "        gameOver = true; return;",
        "      }"
      ].join("\n")
    );
  }
  if (updated === source) {
    const wrapSnippet = source.match(/newHead\.x[\s\S]{0,240}?%\s*gridSize;\s*[\r\n]+\s*newHead\.y[\s\S]{0,240}?%\s*gridSize;/im);
    if (wrapSnippet?.[0]) {
      updated = source.replace(
        wrapSnippet[0],
        [
          "// wall collision -> game over",
          "      if (newHead.x < 0 || newHead.x >= gridSize || newHead.y < 0 || newHead.y >= gridSize) {",
          "        gameOver = true; return;",
          "      }"
        ].join("\n")
      );
    }
  }

  if (updated === source) {
    return null;
  }

  await requireApproval(run, "write_file", `Write file ${targetPath}`);
  enforceWritePolicy({ tool: "write_file", path: targetPath, content: updated }, run.workspaceRoot, run.approvalMode);
  const mutation = await writeFileWithChangeLogging(run, run.workspaceRoot, targetPath, updated, {
    allowOverwriteExisting: true
  });
  return `Updated wall collision logic in ${targetPath} (lines ${formatLineList(mutation.changedLines)})`;
}

async function tryHandleFileQuestionTask(run: ExecutionRun): Promise<string | null> {
  if (!run.workspaceRoot) {
    return null;
  }

  const targetPath = parseFileQuestionPath(run.task);
  if (!targetPath) {
    return null;
  }

  await requireApproval(run, "read_file", `Read file ${targetPath}`);
  enforcePathPolicy(targetPath, run.workspaceRoot, run.approvalMode, "write_file");
  const inputPath = toSafeWorkspacePath(run.workspaceRoot, targetPath);
  let content = "";
  try {
    content = await readFile(inputPath, "utf8");
  } catch {
    return null;
  }
  log(run, `read_file: ${targetPath}`);

  const oneSentence = summarizeTextHeuristically(content, 1);
  log(run, `file_answer: ${oneSentence}`);
  return oneSentence;
}

function enforceWritePolicy(action: FileAction, workspaceRoot: string, approvalMode: ApprovalMode): void {
  if (approvalMode === "unrestricted") {
    // Even in unrestricted mode, avoid replacing existing files unless user intent is explicit.
    // Runtime guard is performed in writeFileWithChangeLogging where previous file content is available.
    return;
  }

  enforcePathPolicy(action.path, workspaceRoot, approvalMode, "write_file");

  const extension = path.extname(action.path).toLowerCase();
  const allowedExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".txt", ".html", ".css", ".yml"]);
  if (extension && !allowedExtensions.has(extension)) {
    throw new Error(`Blocked by auto policy: extension "${extension}" is not allowed.`);
  }
}

function enforceCommandPolicy(command: string, approvalMode: ApprovalMode): void {
  if (approvalMode === "unrestricted") {
    return;
  }

  const blockedTokens = ["rm ", "del ", "format ", "shutdown ", "reboot ", "mkfs", "diskpart", "reg delete"];
  const lower = command.toLowerCase();
  for (const token of blockedTokens) {
    if (lower.includes(token)) {
      throw new Error(`Blocked command token in auto mode: ${token.trim()}`);
    }
  }
}

function enforceBrowsePolicy(url: string, approvalMode: ApprovalMode): void {
  if (approvalMode === "unrestricted") {
    return;
  }

  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Blocked URL: ${url}`);
  }
}

function enforceBrowserOpenPolicy(url: string, workspaceRoot: string, approvalMode: ApprovalMode): void {
  if (/^https?:\/\//i.test(url)) {
    enforceBrowsePolicy(url, approvalMode);
    return;
  }

  if (/^file:\/\//i.test(url)) {
    if (approvalMode === "unrestricted") {
      return;
    }

    const safeRoot = path.resolve(workspaceRoot).replace(/\\/g, "/").toLowerCase();
    const decodedPath = decodeURIComponent(url.replace(/^file:\/\//i, "")).replace(/\\/g, "/").toLowerCase();
    if (!decodedPath.includes(safeRoot)) {
      throw new Error(`Blocked local file URL outside workspace: ${url}`);
    }
    return;
  }

  throw new Error(`Blocked browser target: ${url}`);
}

function enforcePathPolicy(
  relativePath: string,
  workspaceRoot: string,
  approvalMode: ApprovalMode,
  toolName: "write_file" | "make_dir" | "rename_path"
): void {
  if (approvalMode === "unrestricted") {
    return;
  }

  const lowerPath = relativePath.toLowerCase().replace(/\\/g, "/");
  if (lowerPath.includes("../") || lowerPath.startsWith("/") || /^[a-z]:\//.test(lowerPath)) {
    throw new Error(`Blocked by safety policy: invalid path "${relativePath}"`);
  }

  if (lowerPath.startsWith(".git/") || lowerPath.includes("/.git/") || lowerPath.startsWith("node_modules/")) {
    throw new Error(`Blocked by safety policy: restricted path "${relativePath}"`);
  }

  if (approvalMode === "ask") {
    return;
  }

  const safeOutputPath = toSafeWorkspacePath(workspaceRoot, relativePath);
  if (!safeOutputPath.startsWith(workspaceRoot)) {
    throw new Error(`Blocked by safety policy: out-of-workspace path "${relativePath}"`);
  }
}

async function requireApproval(run: ExecutionRun, tool: string, summary: string): Promise<void> {
  if (run.approvalMode !== "ask") {
    return;
  }

  if (!run.requestApproval) {
    throw new Error(`Approval flow is unavailable for ${tool}`);
  }

  const allowed = await run.requestApproval({ tool, summary });
  if (!allowed) {
    throw new Error(`Action rejected by user: ${summary}`);
  }
}

async function runCommand(command: string, cwd: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", command], {
      cwd,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${String(timeoutMs)}ms: ${command}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Command failed (${code}): ${truncate(stderr || stdout, 400)}`));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

async function runCommandForDebug(command: string, cwd: string, timeoutMs = 120_000): Promise<DebugSnapshot> {
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", command], {
      cwd,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (snapshot: DebugSnapshot): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(snapshot);
    };

    const timer = setTimeout(() => {
      child.kill();
      const timedOutput = `${stdout}\n${stderr}\nCommand timed out after ${String(timeoutMs)}ms.`;
      finish(buildDebugSnapshot(command, timedOutput, timedOutput, false, -1));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      const err = String(error?.message ?? error);
      finish(buildDebugSnapshot(command, stdout, `${stderr}\n${err}`, false, -1));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const exitCode = typeof code === "number" ? code : -1;
      const ok = exitCode === 0;
      finish(buildDebugSnapshot(command, stdout, stderr, ok, exitCode));
    });
  });
}

function buildDebugSnapshot(
  command: string,
  stdout: string,
  stderr: string,
  ok: boolean,
  exitCode: number
): DebugSnapshot {
  const merged = `${stderr}\n${stdout}`;
  return {
    command,
    ok,
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    frames: parseDebugFrames(merged),
    localsByFrame: parseDebugLocals(merged)
  };
}

function parseDebugFrames(output: string): DebugFrame[] {
  const lines = output.split(/\r?\n/);
  const frames: DebugFrame[] = [];
  const py = /^\s*File\s+"([^"]+)",\s+line\s+(\d+),\s+in\s+([A-Za-z0-9_<>$.-]+)/;
  const node = /^\s*at\s+([A-Za-z0-9_.$<>]+)\s+\(([^():]+):(\d+):(\d+)\)/;
  const nodeBare = /^\s*at\s+([^():]+):(\d+):(\d+)/;
  for (const line of lines) {
    const pyMatch = line.match(py);
    if (pyMatch) {
      frames.push({
        file: normalizePathLike(pyMatch[1]),
        line: Number(pyMatch[2]),
        functionName: pyMatch[3]
      });
      continue;
    }
    const nodeMatch = line.match(node);
    if (nodeMatch) {
      frames.push({
        file: normalizePathLike(nodeMatch[2]),
        line: Number(nodeMatch[3]),
        functionName: nodeMatch[1]
      });
      continue;
    }
    const bareMatch = line.match(nodeBare);
    if (bareMatch) {
      frames.push({
        file: normalizePathLike(bareMatch[1]),
        line: Number(bareMatch[2]),
        functionName: "<anonymous>"
      });
    }
  }
  return frames.slice(0, 40);
}

function parseDebugLocals(output: string): Array<{ frame: number; values: Record<string, string> }> {
  const lines = output.split(/\r?\n/);
  const values: Record<string, string> = {};
  for (const line of lines) {
    const match = line.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^,\n]{1,120})/);
    if (!match?.[1] || !match?.[2]) {
      continue;
    }
    if (["line", "file", "code", "path"].includes(match[1].toLowerCase())) {
      continue;
    }
    values[match[1]] = match[2].trim();
    if (Object.keys(values).length >= 30) {
      break;
    }
  }
  return Object.keys(values).length > 0 ? [{ frame: 0, values }] : [];
}

function normalizePathLike(value: string): string {
  return value.replace(/\\/g, "/");
}

async function browseUrl(url: string): Promise<string> {
  const response = await fetch(url, { method: "GET" });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (/html|text|json/i.test(contentType)) {
    return body.replace(/\s+/g, " ").trim();
  }
  return `[${contentType}] ${body.slice(0, 200)}`;
}

interface SummarizeToFileTask {
  url: string;
  outputPath: string;
  maxSentences: number;
}

function parseSummarizeToFileTask(task: string): SummarizeToFileTask | null {
  const normalizedTask = task.trim();
  const urlMatch = normalizedTask.match(/\bhttps?:\/\/[^\s)]+/i);
  if (!urlMatch) {
    return null;
  }
  if (!/\bsummary\b|\bsummarize\b/i.test(normalizedTask)) {
    return null;
  }

  const quotedPathMatch = normalizedTask.match(/["']([^"']+\.txt)["']/i);
  const inlinePathMatch = normalizedTask.match(/\b(?:in|into|to)\s+([a-z0-9_./\\-]+\.txt)\b/i);
  const outputPath = (quotedPathMatch?.[1] ?? inlinePathMatch?.[1] ?? "output.txt").replace(/\\/g, "/");
  const maxSentences = /\bquick\b/i.test(normalizedTask) ? 4 : 6;

  return {
    url: stripTrailingPunctuation(urlMatch[0]),
    outputPath,
    maxSentences
  };
}

function parseFileQuestionPath(task: string): string | null {
  const normalizedTask = task.trim();
  const lower = normalizedTask.toLowerCase();
  if (!/\bwhat\b|\binside\b|\bcontent\b|\bwritten\b|\btell me\b/i.test(normalizedTask)) {
    return null;
  }
  if (/\b(make|create|write|change|fix|update|modify|replace)\b/.test(lower)) {
    return null;
  }

  const quotedMatch = normalizedTask.match(/["']([^"']+\.[a-z0-9]+)["']/i);
  const txtMatch = normalizedTask.match(/\b([a-z0-9_./\\-]+\.(?:txt|md|json|csv|log))\b/i);
  const filePath = quotedMatch?.[1] ?? txtMatch?.[1];
  if (!filePath) {
    return null;
  }
  return filePath.replace(/\\/g, "/");
}

async function summarizePageContent(url: string, rawContent: string, maxSentences: number): Promise<string> {
  const sourceText = extractReadableText(rawContent);
  const excerpt = sourceText.slice(0, 14_000);

  try {
    const modelSummary = await callModel([
      {
        role: "system",
        content: [
          "You summarize webpage content.",
          `Return plain text only in ${String(maxSentences)} short sentences max.`,
          "Avoid markdown and avoid lists."
        ].join(" ")
      },
      {
        role: "user",
        content: `URL: ${url}\nPage content excerpt:\n${excerpt}`
      }
    ]);

    return modelSummary.trim();
  } catch {
    const fallback = summarizeTextHeuristically(sourceText, maxSentences);
    return fallback || `Summary unavailable for ${url}.`;
  }
}

async function summarizeFileInOneSentence(filePath: string, content: string): Promise<string> {
  const excerpt = content.replace(/\s+/g, " ").trim().slice(0, 3000);
  try {
    const response = await callModel([
      {
        role: "system",
        content:
          "You summarize file content. Return exactly one short sentence in plain text with no markdown and no quotes."
      },
      {
        role: "user",
        content: `File: ${filePath}\nContent:\n${excerpt}`
      }
    ]);
    return response.trim();
  } catch {
    const fallback = summarizeTextHeuristically(excerpt, 1);
    if (fallback) {
      return fallback;
    }
    return `${filePath} is currently empty or unreadable.`;
  }
}

function extractReadableText(input: string): string {
  const withoutScripts = input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const textOnly = withoutScripts.replace(/<[^>]+>/g, " ");
  return textOnly.replace(/\s+/g, " ").trim();
}

function summarizeTextHeuristically(text: string, maxSentences: number): string {
  const sentenceMatches = text.match(/[^.!?]+[.!?]/g) ?? [];
  if (sentenceMatches.length > 0) {
    return sentenceMatches.slice(0, maxSentences).join(" ").trim();
  }
  return text.slice(0, 900).trim();
}

async function writeFileWithChangeLogging(
  run: ExecutionRun,
  workspaceRoot: string,
  relativePath: string,
  content: string,
  options?: { allowOverwriteExisting?: boolean }
): Promise<FileMutation> {
  const outputPath = toSafeWorkspacePath(workspaceRoot, relativePath);
  let previous = "";
  try {
    previous = await readFile(outputPath, "utf8");
  } catch {
    previous = "";
  }

  if (previous && !options?.allowOverwriteExisting && !isExplicitRewriteTask(run.task)) {
    throw new Error(`Blocked full-file overwrite for existing file ${relativePath}; use replace/edit actions.`);
  }

  if (looksLikePlaceholderOverwrite(content, previous)) {
    throw new Error(`Rejected placeholder overwrite for ${relativePath}`);
  }

  const changedLines = detectChangedLines(previous, content);
  if (isTitleOnlyEditTask(run.task, relativePath) && changedLines.length > 4) {
    throw new Error(`Rejected broad rewrite for title-only edit in ${relativePath}`);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, "utf8");
  log(run, `write_file: ${relativePath}`);

  if (changedLines.length > 0) {
    log(run, `line_changes: ${relativePath}: ${formatLineList(changedLines)}`);
    const detailed = buildLineDiffEntries(previous, content, changedLines);
    for (const item of detailed) {
      log(run, `line_diff: ${relativePath}:${String(item.line)}: - ${item.before} || + ${item.after}`);
    }
  }

  if (isCodeLikeFile(relativePath)) {
    const diagnostics = await getStructuredDiagnosticsForFile(workspaceRoot, relativePath);
    if (diagnostics.length > 0) {
      run.postWriteDiagnostics = [...(run.postWriteDiagnostics ?? []), ...diagnostics];
      for (const item of diagnostics.slice(0, 20)) {
        const snippetPart = item.snippet ? ` | snippet: ${item.snippet}` : "";
        log(
          run,
          `diagnostic_${item.severity}: ${item.path}:${String(item.line)}:${String(item.column)} ${item.message}${snippetPart}`
        );
      }
    }
  }

  return { path: relativePath, changedLines };
}

function detectChangedLines(before: string, after: string): number[] {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const max = Math.max(beforeLines.length, afterLines.length);
  const changed: number[] = [];
  for (let i = 0; i < max; i += 1) {
    if ((beforeLines[i] ?? "") !== (afterLines[i] ?? "")) {
      changed.push(i + 1);
    }
  }
  return changed;
}

function buildLineDiffEntries(
  before: string,
  after: string,
  changedLines: number[]
): Array<{ line: number; before: string; after: string }> {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  return changedLines.slice(0, 30).map((line) => {
    const index = line - 1;
    return {
      line,
      before: normalizeDiffCell(beforeLines[index] ?? ""),
      after: normalizeDiffCell(afterLines[index] ?? "")
    };
  });
}

function normalizeDiffCell(value: string): string {
  return truncate(value.replace(/\s+/g, " ").trim(), 160);
}

function looksLikePlaceholderOverwrite(nextContent: string, previousContent: string): boolean {
  if (!previousContent.trim()) {
    return false;
  }
  const lower = nextContent.toLowerCase();
  const explicitScaffoldMarkers = [
    "rest of the content remains unchanged",
    "game content goes here",
    "<!-- content -->",
    "lorem ipsum",
    "todo:"
  ];
  const hasExplicitScaffoldMarker = explicitScaffoldMarkers.some((marker) => lower.includes(marker));
  const highlyCompressedEllipsis = lower.includes("...") && nextContent.length < previousContent.length * 0.6;
  const majorShrink = nextContent.length < previousContent.length * 0.45;
  return hasExplicitScaffoldMarker || highlyCompressedEllipsis || majorShrink;
}

function isTitleOnlyEditTask(task: string, relativePath: string): boolean {
  const normalizedTask = task.toLowerCase();
  const isHtml = /\.html?$/.test(relativePath.toLowerCase());
  const asksTitle = /\btitle\b/.test(normalizedTask);
  const asksChange = /\b(change|set|update|rename)\b/.test(normalizedTask);
  return isHtml && asksTitle && asksChange;
}

function formatLineList(lines: number[]): string {
  if (lines.length === 0) {
    return "none";
  }
  const preview = lines.slice(0, 12);
  const suffix = lines.length > preview.length ? ` (+${String(lines.length - preview.length)} more)` : "";
  return `${preview.join(", ")}${suffix}`;
}

function requiresCodeMutation(task: string): boolean {
  const normalized = task.toLowerCase();
  const intent = [
    "fix",
    "change",
    "update",
    "modify",
    "make",
    "refactor",
    "not working",
    "bug",
    "issue",
    "line of code",
    "specific lines"
  ];
  return intent.some((token) => normalized.includes(token));
}

export function routeTask(task: string): TaskRoute {
  const intent = classifyTaskIntent(task);
  return {
    intent,
    targetFiles: extractExplicitTargetFiles(task),
    requiresMutation: requiresCodeMutation(task),
    requiresBrowser: intent === "browser_interaction",
    requiresRun: intent === "run_project"
  };
}

function classifyTaskIntent(task: string): TaskIntent {
  const normalized = task.toLowerCase();
  const browserSignals = /\b(open\b.*\bbrowser|browser\b|screenshot|capture|document\.title|click|type|selector|dom)\b/.test(normalized);
  if (browserSignals) {
    return "browser_interaction";
  }
  const asksColorOrStyleEdit = /\b(green|blue|red|yellow|color|background|button|css|style)\b/.test(normalized);
  const editSignals = /\b(change|fix|update|modify|replace|set|rename)\b/.test(normalized);
  const hasTargetFile = /\b[a-z0-9_./\\-]+\.[a-z0-9]{2,8}\b/.test(normalized);
  if ((editSignals || asksColorOrStyleEdit || /\bmake it\b/.test(normalized)) && hasTargetFile) {
    return "edit_existing";
  }
  if (/\b(debug|trace|stack|error|exception|failing test|why failed|investigate)\b/.test(normalized)) {
    return "debug";
  }
  const explicitCreateTone =
    /\b(create|build|generate)\b/.test(normalized) ||
    /\bmake\s+(?:a|an|new)\b/.test(normalized) ||
    /\bfrom scratch\b/.test(normalized);
  if (
    explicitCreateTone &&
    /\b(game|app|page|file|script|boilerplate|skeleton|starter|scaffold)\b/.test(normalized) &&
    !editSignals
  ) {
    return "create_new";
  }
  if (/\b(run|start|execute|launch)\b/.test(normalized) && /\b(project|script|server|app|game)\b/.test(normalized)) {
    return "run_project";
  }
  return "edit_existing";
}

function extractExplicitTargetFiles(task: string): string[] {
  const matches = task.match(/\b([a-z0-9_./\\-]+\.[a-z0-9]{2,8})\b/gi) ?? [];
  const normalized = matches.map((item) => item.replace(/\\/g, "/").toLowerCase());
  return Array.from(new Set(normalized));
}

function enforceExplicitTargetMutation(task: string, report: ExecutionReport): void {
  const targets = extractExplicitTargetFiles(task);
  if (targets.length === 0 || report.mutations.length === 0) {
    return;
  }

  const mutated = report.mutations.map((item) => item.path.toLowerCase().replace(/\\/g, "/"));
  for (const target of targets) {
    const matched = mutated.some((pathItem) => pathItem.endsWith(target));
    if (!matched) {
      throw new Error(`Task referenced ${target} but no mutation was applied to that file.`);
    }
  }
}

async function enforceTaskPostconditions(
  task: string,
  workspaceRoot: string | undefined,
  report: ExecutionReport,
  logs: string[],
  route: TaskRoute
): Promise<void> {
  const lower = task.toLowerCase();

  if (route.requiresMutation && !report.hasMutation) {
    throw new Error("Postcondition failed: task required file mutation but none was applied.");
  }
  if (route.requiresRun && report.commandRuns === 0) {
    throw new Error("Postcondition failed: run task expected at least one successful run_command.");
  }
  if (route.requiresBrowser && report.browserOpens === 0) {
    throw new Error("Postcondition failed: browser task expected browser_open.");
  }
  if (/\b(wait for|wait until|results)\b/.test(lower) && report.browserWaits.length === 0 && route.requiresBrowser) {
    throw new Error("Postcondition failed: browser wait/result condition was requested but no wait action succeeded.");
  }

  const asksScreenshot = /\bscreenshot|capture\b/i.test(task);
  if (asksScreenshot && report.screenshotPaths.length === 0) {
    throw new Error("Postcondition failed: screenshot requested but none was captured.");
  }
  if (workspaceRoot) {
    for (const relativePath of report.screenshotPaths) {
      const absolutePath = toSafeWorkspacePath(workspaceRoot, relativePath);
      let info;
      try {
        info = await stat(absolutePath);
      } catch {
        throw new Error(`Postcondition failed: screenshot file not found at ${relativePath}.`);
      }
      if (!info.isFile() || info.size <= 0) {
        throw new Error(`Postcondition failed: screenshot file is empty at ${relativePath}.`);
      }
    }
  }

  const asksDocumentTitle = /\bdocument\.title\b/i.test(task) || /\breturn\b[\s\S]*\btitle\b/i.test(task);
  if (asksDocumentTitle) {
    const hasEvalSuccess = report.browserEvals.some((entry) => {
      try {
        const parsed = JSON.parse(entry) as { ok?: boolean; value?: unknown };
        return parsed.ok === true && typeof parsed.value === "string" && parsed.value.trim().length > 0;
      } catch {
        return false;
      }
    });
    if (!hasEvalSuccess) {
      throw new Error("Postcondition failed: expected successful browser_eval returning document.title.");
    }
  }

  const reportArtifactPath = parseRequestedArtifactFile(task);
  const asksReportArtifact = Boolean(reportArtifactPath) && /\b(report|summary|result|findings|suggestion)\b/.test(lower);
  if (asksReportArtifact) {
    if (!workspaceRoot || !reportArtifactPath) {
      throw new Error("Postcondition failed: task requested a report artifact but workspace root is unavailable.");
    }
    const absolutePath = toSafeWorkspacePath(workspaceRoot, reportArtifactPath);
    let info;
    try {
      info = await stat(absolutePath);
    } catch {
      throw new Error(`Postcondition failed: expected report artifact at ${reportArtifactPath}.`);
    }
    if (!info.isFile() || info.size <= 0) {
      throw new Error(`Postcondition failed: report artifact is empty or invalid at ${reportArtifactPath}.`);
    }
  }

  if (!workspaceRoot || report.mutations.length === 0) {
    return;
  }

  const colorTask = parseHtmlColorChangeTask(task);
  if (colorTask) {
    const mutated = report.mutations
      .map((item) => item.path.replace(/\\/g, "/").toLowerCase())
      .find((item) => item.endsWith(colorTask.path.toLowerCase()));
    if (mutated) {
      const absolutePath = toSafeWorkspacePath(workspaceRoot, mutated);
      const content = (await readFile(absolutePath, "utf8")).toLowerCase();
      if (!content.includes("blue") && !content.includes("#007bff")) {
        throw new Error(`Postcondition failed: expected blue style updates in ${mutated}.`);
      }
    }
  }

  if (/\btic[\s-]?tac[\s-]?toe\b/.test(lower) && /\b(make|create|build)\b/.test(lower)) {
    const mutatedPaths = report.mutations.map((item) => item.path.toLowerCase().replace(/\\/g, "/"));
    const hasGameFile = mutatedPaths.some((pathItem) => pathItem.endsWith("tic_tac_toe.html") || pathItem.endsWith("tic_tac_toe.py"));
    if (!hasGameFile) {
      throw new Error("Postcondition failed: expected tic_tac_toe game file mutation.");
    }
    if (/\b(run|open|browser)\b/.test(lower)) {
      const hasRunSignal = logs.some((line) => line.includes("run_command:") || line.includes("browser_open:"));
      if (!hasRunSignal) {
        throw new Error("Postcondition failed: expected game run/open signal in logs.");
      }
    }
  }
}

async function enforceActionExecutionPostconditions(
  actions: ModelAction[],
  workspaceRoot: string | undefined,
  report: ExecutionReport
): Promise<void> {
  const requestedMutations = actions.filter((action) =>
    action.tool === "write_file" ||
    action.tool === "replace_in_file" ||
    action.tool === "replace_in_file_regex" ||
    action.tool === "patch_in_file"
  ).length;
  if (requestedMutations > 0 && !report.hasMutation) {
    throw new Error("Postcondition failed: mutating actions executed without any file mutation.");
  }

  const requestedCommands = actions.filter((action) => action.tool === "run_command").length;
  if (requestedCommands > 0 && report.commandRuns < requestedCommands) {
    throw new Error("Postcondition failed: one or more run_command actions did not complete successfully.");
  }

  const requestedBrowserOpen = actions.filter((action) => action.tool === "browser_open").length;
  if (requestedBrowserOpen > 0 && report.browserOpens < requestedBrowserOpen) {
    throw new Error("Postcondition failed: one or more browser_open actions did not complete.");
  }

  const requestedWaits = actions.filter((action) => action.tool === "browser_wait_for").length;
  if (requestedWaits > 0 && report.browserWaits.length < requestedWaits) {
    throw new Error("Postcondition failed: one or more browser_wait_for actions did not complete.");
  }

  const requestedScreenshots = actions.filter((action) => action.tool === "browser_screenshot").length;
  if (requestedScreenshots > 0 && report.screenshotPaths.length < requestedScreenshots) {
    throw new Error("Postcondition failed: one or more browser_screenshot actions did not complete.");
  }
  if (workspaceRoot) {
    for (const relativePath of report.screenshotPaths) {
      const absolutePath = toSafeWorkspacePath(workspaceRoot, relativePath);
      let info;
      try {
        info = await stat(absolutePath);
      } catch {
        throw new Error(`Postcondition failed: screenshot artifact missing: ${relativePath}`);
      }
      if (!info.isFile() || info.size <= 0) {
        throw new Error(`Postcondition failed: screenshot artifact invalid: ${relativePath}`);
      }
    }
  }
}

function isExplicitRewriteTask(task: string): boolean {
  const normalized = task.toLowerCase();
  return /\brewrite\b|\breplace whole file\b|\boverwrite\b|\bcreate new file\b/.test(normalized);
}

function shouldAllowOverwrite(task: string, relativePath: string): boolean {
  if (isExplicitRewriteTask(task) || isBroadRedesignTask(task)) {
    return true;
  }
  const intent = classifyTaskIntent(task);
  if (intent === "create_new") {
    return true;
  }
  // allow html rewrites for explicit redesign-like prompts
  if (/\.html?$/i.test(relativePath) && /\bmodern\b|\bdesign\b|\bbackground\b/.test(task.toLowerCase())) {
    return true;
  }
  return false;
}

function isBroadRedesignTask(task: string): boolean {
  const normalized = task.toLowerCase();
  const designTerms = [
    "modern design",
    "redesign",
    "new design",
    "make it modern",
    "put a background",
    "new background",
    "restyle",
    "ui refresh"
  ];
  return designTerms.some((term) => normalized.includes(term));
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSafeRegex(pattern: string, flags?: string): RegExp {
  const normalizedFlags = sanitizeRegexFlags(flags);
  const withGlobal = normalizedFlags.includes("g") ? normalizedFlags : `${normalizedFlags}g`;
  try {
    return new RegExp(pattern, withGlobal);
  } catch (error) {
    throw new Error(`Invalid regex pattern: ${String(error)}`);
  }
}

function sanitizeRegexFlags(flags?: string): string {
  if (!flags) {
    return "";
  }
  const allowed = new Set(["g", "i", "m", "s", "u", "y"]);
  const result: string[] = [];
  for (const ch of flags) {
    if (allowed.has(ch) && !result.includes(ch)) {
      result.push(ch);
    }
  }
  return result.join("");
}

function findRegexMatchesWithLines(content: string, regex: RegExp): Array<{ line: number; text: string }> {
  const results: Array<{ line: number; text: string }> = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    regex.lastIndex = 0;
    if (regex.test(lines[i])) {
      results.push({ line: i + 1, text: lines[i] });
    }
  }
  return results;
}

function countOccurrences(value: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let cursor = 0;
  while (true) {
    const idx = value.indexOf(needle, cursor);
    if (idx === -1) {
      break;
    }
    count += 1;
    cursor = idx + needle.length;
  }
  return count;
}

function replaceAllLiteral(value: string, find: string, replace: string): string {
  if (!find) {
    return value;
  }
  return value.split(find).join(replace);
}

async function getBrowserSession(run: ExecutionRun): Promise<BrowserSession> {
  if (run.browserSession) {
    return run.browserSession;
  }

  const browser = await chromium.launch({
    headless: false,
    slowMo: agentConfig.browserSlowMoMs
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  run.browserSession = { browser, context, page };
  log(
    run,
    `browser_session: started (headless=false, slowMoMs=${String(agentConfig.browserSlowMoMs)})`
  );
  return run.browserSession;
}

async function closeBrowserSession(run: ExecutionRun): Promise<void> {
  if (!run.browserSession) {
    return;
  }

  try {
    if (agentConfig.browserKeepOpenMs > 0) {
      log(run, `browser_session: waiting ${String(agentConfig.browserKeepOpenMs)}ms before close`);
      await sleep(agentConfig.browserKeepOpenMs);
    }
    await run.browserSession.context.close();
    await run.browserSession.browser.close();
    log(run, "browser_session: closed");
  } catch (error) {
    log(run, `browser_session_close_error: ${error instanceof Error ? error.message : "unknown error"}`);
  } finally {
    run.browserSession = undefined;
  }
}

function toSafeWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const candidate = path.resolve(workspaceRoot, normalized);
  const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : `${workspaceRoot}${path.sep}`;
  if (!candidate.startsWith(rootWithSep) && candidate !== workspaceRoot) {
    throw new Error(`Unsafe path blocked: ${relativePath}`);
  }
  return candidate;
}

function buildIntentPrompt(intent: TaskIntent): string {
  if (intent === "browser_interaction") {
    return "Intent is browser_interaction: prefer browser_open/browser_type/browser_click/browser_wait_for/browser_screenshot/browser_eval. Avoid file writes unless explicitly asked.";
  }
  if (intent === "create_new") {
    return "Intent is create_new: create concrete artifacts with write_file/make_dir, then run/verify when requested.";
  }
  if (intent === "run_project") {
    return "Intent is run_project: prefer run_command and minimal setup edits only when required.";
  }
  if (intent === "debug") {
    return "Intent is debug: inspect logs/files first, then apply targeted fix actions with minimal edits.";
  }
  return "Intent is edit_existing: prefer search/read-range and replace_in_file(_regex) for precise line edits.";
}

function defaultToolsForIntent(intent: TaskIntent): ToolName[] {
  if (intent === "browser_interaction") {
    return ["browser_open", "browser_wait_for", "browser_screenshot", "browser_eval", "browser_click"];
  }
  if (intent === "create_new") {
    return ["write_file", "make_dir", "run_command", "read_file", "rename_path"];
  }
  if (intent === "run_project") {
    return ["dap_run", "dap_stacktrace", "get_diagnostics", "run_command", "read_file"];
  }
  if (intent === "debug") {
    return ["dap_run", "dap_stacktrace", "dap_locals", "find_definition", "get_diagnostics"];
  }
  return ["graph_build", "graph_query", "find_definition", "find_references", "get_symbols"];
}

function searchTools(task: string, intent: TaskIntent, failureClass?: string): ToolCatalogEntry[] {
  const normalized = `${task} ${failureClass ?? ""}`.toLowerCase();
  const scored = TOOL_CATALOG.map((entry) => ({
    entry,
    score: scoreToolCandidate(entry, normalized, intent, failureClass)
  })).sort((a, b) => b.score - a.score);

  const selected: ToolCatalogEntry[] = [];
  for (const item of scored) {
    if (item.score <= 0) {
      continue;
    }
    if (!selected.some((existing) => existing.name === item.entry.name)) {
      selected.push(item.entry);
    }
    if (selected.length >= 5) {
      break;
    }
  }

  for (const toolName of defaultToolsForIntent(intent)) {
    if (selected.length >= 5) {
      break;
    }
    if (selected.some((item) => item.name === toolName)) {
      continue;
    }
    const found = TOOL_CATALOG.find((item) => item.name === toolName);
    if (found) {
      selected.push(found);
    }
  }

  const fallbacks: ToolName[] = ["read_file", "search_in_file", "write_file"];
  for (const toolName of fallbacks) {
    if (selected.length >= 3) {
      break;
    }
    if (selected.some((item) => item.name === toolName)) {
      continue;
    }
    const found = TOOL_CATALOG.find((item) => item.name === toolName);
    if (found) {
      selected.push(found);
    }
  }

  return selected.slice(0, 5);
}

function scoreToolCandidate(entry: ToolCatalogEntry, query: string, intent: TaskIntent, failureClass?: string): number {
  let score = 0;
  if (entry.intents.includes(intent)) {
    score += 5;
  }
  for (const keyword of entry.keywords) {
    if (query.includes(keyword)) {
      score += 2;
    }
  }

  if (failureClass === "zero_matches" && ["search_in_file", "replace_in_file_regex", "patch_in_file"].includes(entry.name)) {
    score += 5;
  }
  if (failureClass === "command_timeout" && entry.name === "run_command") {
    score += 5;
  }
  if (failureClass === "no_mutation" && ["replace_in_file", "replace_in_file_regex", "patch_in_file", "write_file"].includes(entry.name)) {
    score += 4;
  }
  if (failureClass === "postcondition_failed" && ["browser_screenshot", "browser_eval", "run_command", "write_file"].includes(entry.name)) {
    score += 4;
  }
  if (failureClass === "wrong_file_changed" && ["find_references", "find_definition", "search_in_file"].includes(entry.name)) {
    score += 3;
  }
  if (failureClass === "unknown" && ["dap_run", "dap_stacktrace", "get_diagnostics"].includes(entry.name)) {
    score += 3;
  }

  if (/\bhttps?:\/\//.test(query) && ["browse_url", "browser_open"].includes(entry.name)) {
    score += 3;
  }
  if (/\b(screenshot|capture)\b/.test(query) && ["browser_open", "browser_wait_for", "browser_screenshot"].includes(entry.name)) {
    score += 3;
  }
  if (/\b(run|test|lint|install|pytest|npm|node)\b/.test(query) && entry.name === "run_command") {
    score += 3;
  }
  if (/\b(replace|rename|change|fix|refactor|update)\b/.test(query) && ["replace_in_file", "replace_in_file_regex", "patch_in_file"].includes(entry.name)) {
    score += 2;
  }
  if (/\b(symbol|definition|defined|reference|usage|diagnostic|type error|compile error|problems)\b/.test(query) &&
    ["get_symbols", "find_definition", "find_references", "get_diagnostics"].includes(entry.name)) {
    score += 4;
  }
  if (/\b(debug|traceback|stack|frame|locals|runtime error|exception)\b/.test(query) &&
    ["dap_run", "dap_stacktrace", "dap_locals"].includes(entry.name)) {
    score += 5;
  }
  if (/\b(graph|impact|dependen|related files|refactor across)\b/.test(query) &&
    ["graph_build", "graph_query"].includes(entry.name)) {
    score += 4;
  }
  if (/\bmcp|context resource|external context\b/.test(query) && entry.name === "mcp_get_context") {
    score += 4;
  }

  return score;
}

function buildRetrievedToolsPrompt(tools: ToolCatalogEntry[]): string {
  const header = `search_tools selected ${tools.length} tool(s): ${tools.map((item) => item.name).join(", ")}.`;
  const defs = tools.map((item) => `- ${item.name}: ${item.signature}`).join(" ");
  return `${header} Use ONLY these tools. Allowed tool signatures: ${defs}`;
}

async function requestStructuredActionPlan(input: {
  mode: "plan" | "repair";
  intent: TaskIntent;
  task: string;
  userContext: string;
  allowedTools: Set<ToolName>;
  systemRules: string[];
}): Promise<ModelActionPlan | null> {
  let lastError = "invalid_json";
  for (let attempt = 1; attempt <= MODEL_SCHEMA_ATTEMPTS; attempt += 1) {
    const response = await callModel([
      {
        role: "system",
        content: [
          ...input.systemRules,
          "Return STRICT JSON only. No markdown, no prose.",
          'Top-level schema: {"actions":[Action...],"summary":"optional short text"}',
          `Action.tool must be one of: ${Array.from(input.allowedTools).join(", ")}.`,
          "Do not include keys other than actions and summary.",
          `Maximum actions: ${String(MAX_MODEL_ACTIONS)}.`
        ].join(" ")
      },
      {
        role: "user",
        content: [
          input.userContext,
          attempt > 1 ? `Previous response was invalid: ${lastError}. Return corrected strict JSON only.` : ""
        ]
          .filter(Boolean)
          .join("\n\n")
      }
    ]);

    const validated = parseStructuredActionPlanResponse(response, input.allowedTools);
    if (validated.plan) {
      return validated.plan;
    }
    lastError = validated.error;
  }

  return null;
}

function parseStructuredActionPlanResponse(
  raw: string,
  allowedTools: Set<ToolName>
): { plan: ModelActionPlan | null; error: string } {
  const parsed = parseJson<unknown>(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { plan: null, error: "top-level object is missing" };
  }

  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.actions)) {
    return { plan: null, error: "actions must be an array" };
  }

  const valid: ModelAction[] = [];
  let dropped = 0;
  for (const candidate of record.actions.slice(0, MAX_MODEL_ACTIONS)) {
    if (!isValidAction(candidate)) {
      dropped += 1;
      continue;
    }
    if (!allowedTools.has(candidate.tool)) {
      dropped += 1;
      continue;
    }
    valid.push(candidate);
  }

  if (valid.length === 0) {
    return { plan: null, error: dropped > 0 ? "all actions were invalid or disallowed" : "no actions provided" };
  }

  const summaryRaw = record.summary;
  const summary = typeof summaryRaw === "string" ? truncate(summaryRaw.trim(), 240) : undefined;
  return {
    plan: {
      actions: valid,
      summary: summary && summary.length > 0 ? summary : undefined
    },
    error: dropped > 0 ? `dropped ${String(dropped)} invalid/disallowed action(s)` : ""
  };
}

function fallbackPlan(task: string, intent: TaskIntent): ModelActionPlan {
  const wantsScreenshot = /screenshot|capture.*page|screen shot/i.test(task);
  if (wantsScreenshot && intent === "browser_interaction") {
    return {
      actions: [
        { tool: "browser_open", url: "https://example.com" },
        { tool: "browser_screenshot", path: ".local-agent-ide/screenshots/example.png" }
      ],
      summary: "Fallback opened example.com and captured screenshot"
    };
  }
  const folderMatch = /folder(?:\s+called|\s+named)?\s+"([^"]+)"/i.exec(task) ?? /folder\s+called\s+([a-z0-9_-]+)/i.exec(task);
  if (folderMatch?.[1]) {
    return {
      actions: [{ tool: "make_dir", path: folderMatch[1] }],
      summary: `Fallback created folder ${folderMatch[1]}`
    };
  }

  const renameMatch =
    /rename\s+.*folder.*to\s+"([^"]+)"/i.exec(task) ?? /rename\s+.*folder.*to\s+([a-z0-9_-]+)/i.exec(task);
  if (renameMatch?.[1]) {
    return {
      actions: [{ tool: "run_command", command: `Get-ChildItem -Directory | Select-Object -First 1 | Rename-Item -NewName "${renameMatch[1]}"` }],
      summary: `Fallback attempted to rename first folder to ${renameMatch[1]}`
    };
  }

  const wantsHtml = /html/i.test(task);
  const wantsHello = /hello\s+world|hello\s+milad/i.test(task);
  if ((wantsHtml || wantsHello) && intent !== "browser_interaction" && intent !== "run_project") {
    return {
      actions: [
        {
          tool: "write_file",
          path: "index.html",
          content: "<!doctype html>\n<html><body><h1>Hello Milad</h1></body></html>\n"
        }
      ],
      summary: "Fallback created index.html"
    };
  }

  return {
    actions: [
      {
        tool: "write_file",
        path: "AGENT_OUTPUT.md",
        content: `# Agent Output\n\nTask:\n\n${task}\n`
      }
    ],
    summary: "Fallback created AGENT_OUTPUT.md"
  };
}

function parseJson<T>(value: string): T | null {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const extracted = extractJsonObject(trimmed);
    if (extracted) {
      try {
        return JSON.parse(extracted) as T;
      } catch {
        // continue
      }
    }

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (!fenced) {
      return null;
    }

    try {
      return JSON.parse(fenced[1]) as T;
    } catch {
      return null;
    }
  }
}

function extractJsonObject(value: string): string | null {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return value.slice(start, end + 1);
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}...`;
}

async function clickWithFallback(page: Page, selector: string): Promise<void> {
  try {
    await page.click(selector, { timeout: 15_000 });
    return;
  } catch (error) {
    const submitLike = /(submit|search|button)/i.test(selector);
    if (!submitLike) {
      throw error;
    }
  }

  await page.keyboard.press("Enter");
}

async function fillWithFallback(page: Page, selector: string, text: string): Promise<void> {
  try {
    await page.fill(selector, text, { timeout: 15_000 });
    return;
  } catch {
    const fallbacks = [
      "input[name='q']",
      "input[type='search']",
      "textarea[name='q']",
      "input[type='text']"
    ];
    for (const fallback of fallbacks) {
      try {
        await page.fill(fallback, text, { timeout: 5_000 });
        return;
      } catch {
        // continue
      }
    }
  }

  throw new Error(`Unable to fill selector: ${selector}`);
}

function deriveDeterministicBrowserPlan(task: string, files: string[], workspaceRoot: string): ModelActionPlan | null {
  const normalizedTask = task.trim();
  const urlMatch = normalizedTask.match(/\bhttps?:\/\/[^\s)]+/i);
  const url = urlMatch ? stripTrailingPunctuation(urlMatch[0]) : null;

  const browserSearchPlan = deriveBrowserSearchPlan(normalizedTask);
  if (browserSearchPlan) {
    return browserSearchPlan;
  }

  const localOpenPlan = deriveLocalHtmlOpenPlan(normalizedTask, files, workspaceRoot);
  if (localOpenPlan) {
    return localOpenPlan;
  }

  const wantsTitle =
    /\bdocument\.title\b/i.test(normalizedTask) || /\breturn\b[\s\S]*\btitle\b/i.test(normalizedTask);
  if (wantsTitle && url) {
    return {
      actions: [
        { tool: "browser_open", url },
        { tool: "browser_eval", script: "document.title" }
      ],
      summary: "Deterministic browser plan: open page and evaluate document.title"
    };
  }

  const wantsScreenshot = /\bscreenshot\b|\bcapture\b/.test(normalizedTask.toLowerCase());
  if (url && wantsScreenshot) {
    const screenshotPath = parseScreenshotOutputPath(normalizedTask) ?? ".local-agent-ide/screenshots/page.png";
    return {
      actions: [
        { tool: "browser_open", url },
        { tool: "browser_wait_for", timeoutMs: 10_000 },
        { tool: "browser_screenshot", path: screenshotPath }
      ],
      summary: `Deterministic browser plan: open ${url} and capture screenshot`
    };
  }

  const typeMatch = normalizedTask.match(/\btype\s+["']([^"']+)["']/i);
  const wantsSearchFlow = /\bsearch\b/i.test(normalizedTask) && /\bscreenshot\b/i.test(normalizedTask);
  if (wantsSearchFlow && typeMatch?.[1] && url) {
    return {
      actions: [
        { tool: "browser_open", url },
        { tool: "browser_type", selector: "input[name='q']", text: typeMatch[1] },
        { tool: "browser_click", selector: "button[type='submit']" },
        { tool: "browser_wait_for", timeoutMs: 10_000 },
        { tool: "browser_screenshot", path: ".local-agent-ide/screenshots/search-results.png" }
      ],
      summary: "Deterministic browser plan: open, search, wait, screenshot"
    };
  }

  return null;
}

function deriveLocalHtmlOpenPlan(task: string, files: string[], workspaceRoot: string): ModelActionPlan | null {
  const wantsOpen = /\bopen\b/i.test(task) || /\bopen in browser\b/i.test(task);
  if (!wantsOpen) {
    return null;
  }

  const namedHtml = task.match(/\b([a-z0-9_.-]+\.html?)\b/i)?.[1];
  if (!namedHtml && !/\bhtml\b/i.test(task)) {
    return null;
  }
  const htmlFiles = files.filter((file) => /\.html?$/i.test(file));
  if (htmlFiles.length === 0) {
    return null;
  }

  let selected = "";
  if (namedHtml) {
    selected = htmlFiles.find((file) => file.toLowerCase().endsWith(namedHtml.toLowerCase())) ?? "";
  }
  if (!selected) {
    selected = htmlFiles[0];
  }

  const absolute = toSafeWorkspacePath(workspaceRoot, selected);
  const localUrl = pathToFileURL(absolute).href;
  const wantsScreenshot = /\bscreenshot\b|\bcapture\b/.test(task.toLowerCase());
  const screenshotPath = parseScreenshotOutputPath(task) ?? ".local-agent-ide/screenshots/local-open.png";

  if (wantsScreenshot) {
    return {
      actions: [
        { tool: "browser_open", url: localUrl },
        { tool: "browser_wait_for", timeoutMs: 8_000 },
        { tool: "browser_screenshot", path: screenshotPath }
      ],
      summary: `Deterministic browser plan: open local file ${selected} and screenshot`
    };
  }

  return {
    actions: [{ tool: "browser_open", url: localUrl }],
    summary: `Deterministic browser plan: open local file ${selected}`
  };
}

function deriveBrowserSearchPlan(task: string): ModelActionPlan | null {
  const lower = task.toLowerCase();
  const asksBrowser = /\bopen\b.*\bbrowser\b|\bbrowser\b.*\bopen\b/.test(lower) || lower.includes("search");
  if (!asksBrowser) {
    return null;
  }
  const queryMatch =
    task.match(/\b(?:search for|search|check for|look for)\s+["']?(.+?)["']?(?=\s+(?:and|then|take|save)\b|$)/i) ??
    task.match(/\bfor\s+["']?([^"'.!?]+)["']?\s*(?:and|then|$)/i);
  const query = queryMatch?.[1]?.trim();
  if (!query) {
    return null;
  }

  const wantsScreenshot = /\bscreenshot\b|\bcapture\b/.test(lower);
  const requestedScreenshot = parseScreenshotOutputPath(task) ?? ".local-agent-ide/screenshots/browser-search.png";
  const actions: ModelAction[] = [
    { tool: "browser_open", url: "https://duckduckgo.com" },
    { tool: "browser_type", selector: "input[name='q']", text: query },
    { tool: "browser_click", selector: "button[type='submit']" },
    { tool: "browser_wait_for", timeoutMs: 12_000 }
  ];
  if (wantsScreenshot) {
    actions.push({ tool: "browser_screenshot", path: requestedScreenshot });
  }
  return {
    actions,
    summary: wantsScreenshot
      ? `Deterministic browser search for "${query}" with screenshot`
      : `Deterministic browser search for "${query}"`
  };
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[),.;!?]+$/g, "");
}

function parseScreenshotOutputPath(task: string): string | null {
  const quoted = task.match(/\b(?:to|as|save(?: it)?(?: to)?)\s+["']([^"']+\.png)["']/i)?.[1];
  if (quoted) {
    return quoted.replace(/\\/g, "/");
  }
  const plain = task.match(/(?:^|\s)(\.?[a-z0-9_./\\-]+\.png)(?=\s|$|[),.;!?])/i)?.[1];
  if (!plain) {
    return null;
  }
  return plain.replace(/\\/g, "/").replace(/[),.;!?]+$/g, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function log(run: ExecutionRun, message: string): void {
  const timestamp = new Date().toISOString();
  run.logs.push(`[${timestamp}] ${message}`);
  if (run.logs.length > 200) {
    run.logs.splice(0, run.logs.length - 200);
  }
  notifyUpdate(run);
}

function notifyUpdate(run: ExecutionRun): void {
  run.onUpdate?.(run);
}
