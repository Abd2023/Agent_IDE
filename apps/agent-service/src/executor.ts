import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
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
  approvalMode: ApprovalMode;
  plan: AgentPlan;
  isFinished: boolean;
  updatedAt: string;
  logs: string[];
  pendingApproval?: PendingApprovalRequest;
  requestApproval?: (input: { tool: string; summary: string }) => Promise<boolean>;
  onUpdate?: (run: ExecutionRun) => void;
  browserSession?: BrowserSession;
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

type ModelAction =
  | FileAction
  | CommandAction
  | BrowseAction
  | MkdirAction
  | RenameAction
  | BrowserOpenAction
  | BrowserClickAction
  | BrowserTypeAction
  | BrowserWaitForAction
  | BrowserScreenshotAction
  | BrowserEvalAction;

interface ModelActionPlan {
  actions: ModelAction[];
  summary?: string;
}

export async function executeRun(run: ExecutionRun): Promise<void> {
  try {
    log(run, "Run started.");

    await runStep(run, "analyze-task", async () => {
      log(run, `Task: ${run.task}`);
      log(run, `Approval mode: ${run.approvalMode}`);
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

    await runStep(run, "implement", async () => {
      if (!run.workspaceRoot) {
        throw new Error("No workspace root provided by extension.");
      }

      const files = await scanWorkspaceFiles(run.workspaceRoot, 200);
      const actionPlan = await proposeImplementationActions(run.task, files);
      log(run, `Action plan generated: ${actionPlan.actions.length} action(s).`);
      await executeActionsWithRetry(run, actionPlan.actions, files);

      const step = getStep(run.plan.steps, "implement");
      step.notes = actionPlan.summary ?? `Applied ${actionPlan.actions.length} action(s)`;
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

async function runStep(run: ExecutionRun, stepId: string, worker: () => Promise<void>): Promise<void> {
  const step = getStep(run.plan.steps, stepId);
  markInProgress(run.plan.steps, stepId);
  run.updatedAt = new Date().toISOString();
  notifyUpdate(run);
  log(run, `Step started: ${step.title}`);
  await worker();
  step.status = "completed";
  run.updatedAt = new Date().toISOString();
  notifyUpdate(run);
  log(run, `Step completed: ${step.title}`);
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

async function proposeImplementationActions(task: string, files: string[]): Promise<ModelActionPlan> {
  const deterministic = deriveDeterministicBrowserPlan(task);
  if (deterministic) {
    return deterministic;
  }

  const fallback = fallbackPlan(task);
  const fileList = files.slice(0, 120).join(", ");
  const response = await callModel([
    {
      role: "system",
      content: [
        "You are a coding agent that proposes tool actions.",
        "Return strict JSON only and no markdown.",
        'Schema: {"actions":[{"tool":"write_file","path":"relative/path","content":"full file content"}|{"tool":"make_dir","path":"relative/path"}|{"tool":"rename_path","from":"old/rel/path","to":"new/rel/path"}|{"tool":"run_command","command":"npm run build"}|{"tool":"browse_url","url":"https://example.com"}|{"tool":"browser_open","url":"https://example.com"}|{"tool":"browser_click","selector":"button[type=submit]"}|{"tool":"browser_type","selector":"input[name=q]","text":"hello"}|{"tool":"browser_wait_for","selector":"#app","timeoutMs":10000}|{"tool":"browser_screenshot","path":"artifacts/screen.png"}|{"tool":"browser_eval","script":"document.title"}],"summary":"short text"}',
        "Rules: max 6 actions. Keep actions safe and workspace-relevant."
      ].join(" ")
    },
    {
      role: "user",
      content: `Task: ${task}\nExisting files (subset): ${fileList}`
    }
  ]);

  const parsed = parseJson<ModelActionPlan>(response);
  if (!parsed || !Array.isArray(parsed.actions) || parsed.actions.length === 0) {
    return fallback;
  }

  const validActions = parsed.actions.filter(isValidAction).slice(0, 6);
  if (validActions.length === 0) {
    return fallback;
  }

  return { actions: validActions, summary: parsed.summary };
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
    return typeof candidate.command === "string" && candidate.command.trim().length > 0;
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

  if (candidate.tool === "browse_url") {
    return typeof candidate.url === "string" && /^https?:\/\//i.test(candidate.url);
  }

  if (candidate.tool === "browser_open") {
    return typeof candidate.url === "string" && /^https?:\/\//i.test(candidate.url);
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

  return false;
}

async function executeActions(run: ExecutionRun, actions: ModelAction[]): Promise<void> {
  if (!run.workspaceRoot) {
    throw new Error("Missing workspace root for action execution.");
  }

  for (const action of actions) {
    if (action.tool === "write_file") {
      await requireApproval(run, "write_file", `Write file ${action.path}`);
      enforceWritePolicy(action, run.workspaceRoot, run.approvalMode);
      const outputPath = toSafeWorkspacePath(run.workspaceRoot, action.path);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, action.content, "utf8");
      log(run, `write_file: ${action.path}`);
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

    if (action.tool === "run_command") {
      await requireApproval(run, "run_command", `Run command: ${action.command}`);
      enforceCommandPolicy(action.command, run.approvalMode);
      const output = await runCommand(action.command, run.workspaceRoot);
      log(run, `run_command: ${action.command}`);
      if (output.trim()) {
        log(run, `command_output: ${truncate(output, 500)}`);
      }
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
      enforceBrowsePolicy(action.url, run.approvalMode);
      const session = await getBrowserSession(run);
      await session.page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      log(run, `browser_open: ${action.url}`);
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
      } else {
        await session.page.waitForLoadState("networkidle", { timeout: timeoutMs });
        log(run, "browser_wait_for: network idle");
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
      log(run, `browser_screenshot: ${path.relative(run.workspaceRoot, outputPath).replace(/\\/g, "/")}`);
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
      continue;
    }
  }
}

async function executeActionsWithRetry(run: ExecutionRun, baseActions: ModelAction[], files: string[]): Promise<void> {
  let actions = baseActions;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      log(run, `Execution attempt ${attempt}/${maxAttempts}`);
      await executeActions(run, actions);
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown action error";
      log(run, `Attempt ${attempt} failed: ${reason}`);

      if (attempt === maxAttempts) {
        throw error;
      }

      const repaired = await proposeRepairActions(run.task, files, actions, reason);
      if (!repaired || repaired.length === 0) {
        throw error;
      }
      actions = repaired;
      log(run, `Repair plan generated: ${actions.length} action(s).`);
    }
  }
}

async function proposeRepairActions(
  task: string,
  files: string[],
  attemptedActions: ModelAction[],
  failureReason: string
): Promise<ModelAction[] | null> {
  const response = await callModel([
    {
      role: "system",
      content: [
        "You repair failed coding agent actions.",
        "Return strict JSON only with schema:",
        '{"actions":[{"tool":"write_file","path":"relative/path","content":"..."}|{"tool":"make_dir","path":"relative/path"}|{"tool":"rename_path","from":"a","to":"b"}|{"tool":"run_command","command":"..."}|{"tool":"browse_url","url":"https://..."}|{"tool":"browser_open","url":"https://..."}|{"tool":"browser_click","selector":"..."}|{"tool":"browser_type","selector":"...","text":"..."}|{"tool":"browser_wait_for","selector":"...","timeoutMs":10000}|{"tool":"browser_screenshot","path":"..."}|{"tool":"browser_eval","script":"document.title"}]}',
        "Prefer minimal fix actions and avoid repeating failing paths."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        `Task: ${task}`,
        `Failure: ${failureReason}`,
        `Attempted actions: ${JSON.stringify(attemptedActions)}`,
        `Files: ${files.slice(0, 120).join(", ")}`
      ].join("\n")
    }
  ]);

  const parsed = parseJson<{ actions?: unknown[] }>(response);
  if (!parsed?.actions || !Array.isArray(parsed.actions)) {
    return null;
  }
  return parsed.actions.filter(isValidAction).slice(0, 6);
}

function enforceWritePolicy(action: FileAction, workspaceRoot: string, approvalMode: ApprovalMode): void {
  if (approvalMode === "unrestricted") {
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

async function runCommand(command: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", command], {
      cwd,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out: ${command}`));
    }, 30_000);

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

async function browseUrl(url: string): Promise<string> {
  const response = await fetch(url, { method: "GET" });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (/html|text|json/i.test(contentType)) {
    return body.replace(/\s+/g, " ").trim();
  }
  return `[${contentType}] ${body.slice(0, 200)}`;
}

async function getBrowserSession(run: ExecutionRun): Promise<BrowserSession> {
  if (run.browserSession) {
    return run.browserSession;
  }

  const browser = await chromium.launch({
    headless: agentConfig.browserHeadless,
    slowMo: agentConfig.browserSlowMoMs
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  run.browserSession = { browser, context, page };
  log(
    run,
    `browser_session: started (headless=${String(agentConfig.browserHeadless)}, slowMoMs=${String(agentConfig.browserSlowMoMs)})`
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

function fallbackPlan(task: string): ModelActionPlan {
  const wantsScreenshot = /screenshot|capture.*page|screen shot/i.test(task);
  if (wantsScreenshot) {
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
  if (wantsHtml || wantsHello) {
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

function deriveDeterministicBrowserPlan(task: string): ModelActionPlan | null {
  const normalizedTask = task.trim();
  const urlMatch = normalizedTask.match(/\bhttps?:\/\/[^\s)]+/i);
  if (!urlMatch) {
    return null;
  }
  const url = stripTrailingPunctuation(urlMatch[0]);

  const wantsTitle =
    /\bdocument\.title\b/i.test(normalizedTask) || /\breturn\b[\s\S]*\btitle\b/i.test(normalizedTask);
  if (wantsTitle) {
    return {
      actions: [
        { tool: "browser_open", url },
        { tool: "browser_eval", script: "document.title" }
      ],
      summary: "Deterministic browser plan: open page and evaluate document.title"
    };
  }

  const typeMatch = normalizedTask.match(/\btype\s+["']([^"']+)["']/i);
  const wantsSearchFlow = /\bsearch\b/i.test(normalizedTask) && /\bscreenshot\b/i.test(normalizedTask);
  if (wantsSearchFlow && typeMatch?.[1]) {
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

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[),.;!?]+$/g, "");
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
