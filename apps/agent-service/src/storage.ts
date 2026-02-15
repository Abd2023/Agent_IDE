import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentPlan, ApprovalMode, HistoryResponse } from "@local-agent-ide/core";

const HISTORY_DIR = path.resolve(process.cwd(), ".local-agent-ide");
const HISTORY_FILE = path.join(HISTORY_DIR, "history.json");

interface ChatHistoryItem {
  id: string;
  role: "user" | "agent";
  message: string;
  workspaceRoot?: string;
  timestamp: string;
}

interface RunHistoryItem {
  runId: string;
  task: string;
  workspaceRoot?: string;
  approvalMode: ApprovalMode;
  plan: AgentPlan;
  isFinished: boolean;
  updatedAt: string;
  logs: string[];
}

interface HistoryFile {
  chats: ChatHistoryItem[];
  runs: RunHistoryItem[];
}

let writeQueue: Promise<void> = Promise.resolve();

export async function appendChatHistory(input: {
  role: "user" | "agent";
  message: string;
  workspaceRoot?: string;
}): Promise<void> {
  await enqueueWrite(async (history) => {
    history.chats.push({
      id: createId("chat"),
      role: input.role,
      message: input.message,
      workspaceRoot: input.workspaceRoot,
      timestamp: new Date().toISOString()
    });

    if (history.chats.length > 500) {
      history.chats.splice(0, history.chats.length - 500);
    }
  });
}

export async function upsertRunHistory(input: {
  runId: string;
  task: string;
  workspaceRoot?: string;
  approvalMode: ApprovalMode;
  plan: AgentPlan;
  isFinished: boolean;
  updatedAt: string;
  logs: string[];
}): Promise<void> {
  await enqueueWrite(async (history) => {
    const next: RunHistoryItem = {
      runId: input.runId,
      task: input.task,
      workspaceRoot: input.workspaceRoot,
      approvalMode: input.approvalMode,
      plan: {
        task: input.plan.task,
        steps: input.plan.steps.map((step) => ({ ...step }))
      },
      isFinished: input.isFinished,
      updatedAt: input.updatedAt,
      logs: input.logs.slice(-200)
    };

    const idx = history.runs.findIndex((run) => run.runId === next.runId);
    if (idx >= 0) {
      history.runs[idx] = next;
    } else {
      history.runs.push(next);
    }

    if (history.runs.length > 200) {
      history.runs.splice(0, history.runs.length - 200);
    }
  });
}

export async function getHistorySnapshot(workspaceRoot?: string): Promise<HistoryResponse> {
  const history = await readHistory();
  const normalize = (value?: string) => value?.toLowerCase();
  const target = normalize(workspaceRoot);

  const chats = history.chats
    .filter((item) => (target ? normalize(item.workspaceRoot) === target : true))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-200);

  const runs = history.runs
    .filter((item) => (target ? normalize(item.workspaceRoot) === target : true))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .slice(-50);

  return { chats, runs };
}

async function enqueueWrite(mutator: (history: HistoryFile) => void | Promise<void>): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const history = await readHistory();
    await mutator(history);
    await saveHistory(history);
  });
  await writeQueue;
}

async function readHistory(): Promise<HistoryFile> {
  await mkdir(HISTORY_DIR, { recursive: true });
  try {
    const raw = await readFile(HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<HistoryFile>;
    return {
      chats: Array.isArray(parsed.chats) ? parsed.chats : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : []
    };
  } catch {
    return { chats: [], runs: [] };
  }
}

async function saveHistory(history: HistoryFile): Promise<void> {
  await mkdir(HISTORY_DIR, { recursive: true });
  await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), "utf8");
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
