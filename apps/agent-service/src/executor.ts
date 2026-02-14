import { readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import type { AgentPlan, AgentStep, ApprovalMode, RunStatusResponse } from "@local-agent-ide/core";
import { callModel } from "./model.js";

export interface ExecutionRun {
  runId: string;
  task: string;
  workspaceRoot?: string;
  approvalMode: ApprovalMode;
  plan: AgentPlan;
  isFinished: boolean;
  updatedAt: string;
  logs: string[];
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

type ModelAction = FileAction | CommandAction | BrowseAction;

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
      await executeActions(run, actionPlan.actions);

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
    logs: run.logs.slice(-40)
  };
}

async function runStep(run: ExecutionRun, stepId: string, worker: () => Promise<void>): Promise<void> {
  const step = getStep(run.plan.steps, stepId);
  markInProgress(run.plan.steps, stepId);
  run.updatedAt = new Date().toISOString();
  log(run, `Step started: ${step.title}`);
  await worker();
  step.status = "completed";
  run.updatedAt = new Date().toISOString();
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
  const fallback = fallbackPlan(task);
  const fileList = files.slice(0, 120).join(", ");
  const response = await callModel([
    {
      role: "system",
      content: [
        "You are a coding agent that proposes tool actions.",
        "Return strict JSON only and no markdown.",
        'Schema: {"actions":[{"tool":"write_file","path":"relative/path","content":"full file content"}|{"tool":"run_command","command":"npm run build"}|{"tool":"browse_url","url":"https://example.com"}],"summary":"short text"}',
        "Rules: max 4 actions. Keep actions safe and workspace-relevant."
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

  const validActions = parsed.actions.filter(isValidAction).slice(0, 4);
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

  if (candidate.tool === "browse_url") {
    return typeof candidate.url === "string" && /^https?:\/\//i.test(candidate.url);
  }

  return false;
}

async function executeActions(run: ExecutionRun, actions: ModelAction[]): Promise<void> {
  if (!run.workspaceRoot) {
    throw new Error("Missing workspace root for action execution.");
  }

  for (const action of actions) {
    if (action.tool === "write_file") {
      enforceWritePolicy(action, run.workspaceRoot, run.approvalMode);
      const outputPath = toSafeWorkspacePath(run.workspaceRoot, action.path);
      await writeFile(outputPath, action.content, "utf8");
      log(run, `write_file: ${action.path}`);
      continue;
    }

    if (action.tool === "run_command") {
      enforceCommandPolicy(action.command, run.approvalMode);
      const output = await runCommand(action.command, run.workspaceRoot);
      log(run, `run_command: ${action.command}`);
      if (output.trim()) {
        log(run, `command_output: ${truncate(output, 500)}`);
      }
      continue;
    }

    if (action.tool === "browse_url") {
      enforceBrowsePolicy(action.url, run.approvalMode);
      const snapshot = await browseUrl(action.url);
      log(run, `browse_url: ${action.url}`);
      if (snapshot.trim()) {
        log(run, `browse_snapshot: ${truncate(snapshot, 300)}`);
      }
    }
  }
}

function enforceWritePolicy(action: FileAction, workspaceRoot: string, approvalMode: ApprovalMode): void {
  if (approvalMode === "unrestricted") {
    return;
  }

  const lowerPath = action.path.toLowerCase().replace(/\\/g, "/");
  if (lowerPath.includes("../") || lowerPath.startsWith("/") || /^[a-z]:\//.test(lowerPath)) {
    throw new Error(`Blocked by safety policy: invalid path "${action.path}"`);
  }

  if (lowerPath.startsWith(".git/") || lowerPath.includes("/.git/") || lowerPath.startsWith("node_modules/")) {
    throw new Error(`Blocked by safety policy: restricted path "${action.path}"`);
  }

  if (approvalMode === "ask") {
    throw new Error(`Approval required before write_file "${action.path}". Set approval mode to auto to allow.`);
  }

  const extension = path.extname(action.path).toLowerCase();
  const allowedExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".txt", ".html", ".css", ".yml"]);
  if (extension && !allowedExtensions.has(extension)) {
    throw new Error(`Blocked by auto policy: extension "${extension}" is not allowed.`);
  }

  const safeOutputPath = toSafeWorkspacePath(workspaceRoot, action.path);
  if (!safeOutputPath.startsWith(workspaceRoot)) {
    throw new Error(`Blocked by safety policy: out-of-workspace path "${action.path}"`);
  }
}

function enforceCommandPolicy(command: string, approvalMode: ApprovalMode): void {
  if (approvalMode === "ask") {
    throw new Error(`Approval required before run_command "${command}".`);
  }

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
  if (approvalMode === "ask") {
    throw new Error(`Approval required before browse_url "${url}".`);
  }

  if (approvalMode === "unrestricted") {
    return;
  }

  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Blocked URL: ${url}`);
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

function log(run: ExecutionRun, message: string): void {
  const timestamp = new Date().toISOString();
  run.logs.push(`[${timestamp}] ${message}`);
  if (run.logs.length > 200) {
    run.logs.splice(0, run.logs.length - 200);
  }
}

