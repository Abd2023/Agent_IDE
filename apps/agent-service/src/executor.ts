import { readdir, writeFile } from "node:fs/promises";
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
}

interface ModelActionPlan {
  actions: Array<{
    tool: "write_file";
    path: string;
    content: string;
  }>;
  summary?: string;
}

export async function executeRun(run: ExecutionRun): Promise<void> {
  try {
    await runStep(run, "analyze-task", async () => {
      return;
    });

    await runStep(run, "scan-project", async () => {
      if (!run.workspaceRoot) {
        return;
      }

      const files = await scanWorkspaceFiles(run.workspaceRoot, 300);
      const step = getStep(run.plan.steps, "scan-project");
      step.notes = `Scanned ${files.length} files`;
    });

    await runStep(run, "implement", async () => {
      if (!run.workspaceRoot) {
        throw new Error("No workspace root provided by extension.");
      }

      const files = await scanWorkspaceFiles(run.workspaceRoot, 200);
      const actionPlan = await proposeImplementationActions(run.task, files);
      await executeActions(run.workspaceRoot, actionPlan.actions, run.approvalMode);

      const step = getStep(run.plan.steps, "implement");
      step.notes = actionPlan.summary ?? `Applied ${actionPlan.actions.length} file action(s)`;
    });

    await runStep(run, "verify", async () => {
      const step = getStep(run.plan.steps, "verify");
      step.notes = "Basic execution completed. Command-level verification comes in Step 5.";
    });

    await runStep(run, "finalize", async () => {
      const step = getStep(run.plan.steps, "finalize");
      step.notes = "Run completed.";
    });

    run.isFinished = true;
    run.updatedAt = new Date().toISOString();
  } catch (error) {
    run.isFinished = true;
    run.updatedAt = new Date().toISOString();

    const active = run.plan.steps.find((step) => step.status === "in_progress");
    if (active) {
      active.status = "failed";
      active.notes = error instanceof Error ? error.message : "unknown execution error";
    }
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
      ? "Step 5/6: Model-driven execution finished under safety policy"
      : activeStep
        ? `Executing: ${activeStep.title}`
        : "Preparing next step",
    nextStep: run.isFinished
      ? "Step 6/6: Add terminal/browser tools and richer execution traces"
      : `${pendingCount} step(s) remaining`,
    timestamp: run.updatedAt
  };
}

async function runStep(run: ExecutionRun, stepId: string, worker: () => Promise<void>): Promise<void> {
  const step = getStep(run.plan.steps, stepId);
  markInProgress(run.plan.steps, stepId);
  run.updatedAt = new Date().toISOString();
  await worker();
  step.status = "completed";
  run.updatedAt = new Date().toISOString();
}

function markInProgress(steps: AgentStep[], stepId: string): void {
  for (const step of steps) {
    if (step.status === "in_progress" && step.id !== stepId) {
      step.status = "completed";
    }
  }
  const step = getStep(steps, stepId);
  step.status = "in_progress";
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
        "You are a coding agent that proposes file edit actions.",
        "Return strict JSON only, no markdown.",
        'Schema: {"actions":[{"tool":"write_file","path":"relative/path","content":"full file content"}],"summary":"short text"}',
        "Rules: max 3 actions, workspace-relative paths only."
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

  const validActions = parsed.actions.filter(
    (action) =>
      action &&
      action.tool === "write_file" &&
      typeof action.path === "string" &&
      typeof action.content === "string" &&
      action.path.trim().length > 0
  );

  if (validActions.length === 0) {
    return fallback;
  }

  return { actions: validActions.slice(0, 3), summary: parsed.summary };
}

async function executeActions(
  workspaceRoot: string,
  actions: ModelActionPlan["actions"],
  approvalMode: ApprovalMode
): Promise<void> {
  for (const action of actions) {
    enforceActionPolicy(action, workspaceRoot, approvalMode);
    const outputPath = toSafeWorkspacePath(workspaceRoot, action.path);
    await writeFile(outputPath, action.content, "utf8");
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
  const wantsHtml = /html/i.test(task);
  const wantsHello = /hello\s+world/i.test(task);
  if (wantsHtml || wantsHello) {
    return {
      actions: [
        {
          tool: "write_file",
          path: "hello.html",
          content: "<!doctype html>\n<html><body><h1>Hello World</h1></body></html>\n"
        }
      ],
      summary: "Fallback plan created hello.html"
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
    summary: "Fallback plan created AGENT_OUTPUT.md"
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

function enforceActionPolicy(
  action: ModelActionPlan["actions"][number],
  workspaceRoot: string,
  approvalMode: ApprovalMode
): void {
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
    throw new Error(
      `Approval required before writing "${action.path}". Switch localAgentIDE.approvalMode to "auto" or "unrestricted" to continue.`
    );
  }

  const extension = path.extname(action.path).toLowerCase();
  const allowedExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".txt", ".html", ".css"]);
  if (extension && !allowedExtensions.has(extension)) {
    throw new Error(`Blocked by safety policy in auto mode: extension "${extension}" is not in allowlist.`);
  }

  const safeOutputPath = toSafeWorkspacePath(workspaceRoot, action.path);
  if (!safeOutputPath.startsWith(workspaceRoot)) {
    throw new Error(`Blocked by safety policy: out-of-workspace path "${action.path}"`);
  }
}
