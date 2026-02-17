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
  sessionId?: string;
  timestamp: string;
}

interface RunHistoryItem {
  runId: string;
  task: string;
  workspaceRoot?: string;
  sessionId?: string;
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
  sessionId?: string;
}): Promise<void> {
  await enqueueWrite(async (history) => {
    history.chats.push({
      id: createId("chat"),
      role: input.role,
      message: input.message,
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
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
  sessionId?: string;
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
      sessionId: input.sessionId,
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

export async function getHistorySnapshot(workspaceRoot?: string, sessionId?: string): Promise<HistoryResponse> {
  const history = await readHistory();
  const normalize = (value?: string) => value?.toLowerCase();
  const target = normalize(workspaceRoot);
  const targetSession = normalize(sessionId);

  const scopeByWorkspace = <T extends { workspaceRoot?: string }>(item: T): boolean =>
    target ? normalize(item.workspaceRoot) === target : true;
  const scopeBySession = <T extends { sessionId?: string }>(item: T): boolean =>
    targetSession ? normalize(item.sessionId) === targetSession : true;

  const chats = history.chats
    .filter((item) => scopeByWorkspace(item) && scopeBySession(item))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-200);

  const runs = history.runs
    .filter((item) => scopeByWorkspace(item) && scopeBySession(item))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .slice(-50);

  const sessionsByUpdatedAt = new Map<string, string>();
  for (const chat of history.chats) {
    if (!scopeByWorkspace(chat) || !chat.sessionId) {
      continue;
    }
    const current = sessionsByUpdatedAt.get(chat.sessionId);
    if (!current || current < chat.timestamp) {
      sessionsByUpdatedAt.set(chat.sessionId, chat.timestamp);
    }
  }
  for (const run of history.runs) {
    if (!scopeByWorkspace(run) || !run.sessionId) {
      continue;
    }
    const current = sessionsByUpdatedAt.get(run.sessionId);
    if (!current || current < run.updatedAt) {
      sessionsByUpdatedAt.set(run.sessionId, run.updatedAt);
    }
  }

  const sessionFirstUserMessage = new Map<string, string>();
  for (const chat of history.chats) {
    if (!scopeByWorkspace(chat) || !chat.sessionId || chat.role !== "user") {
      continue;
    }
    if (!sessionFirstUserMessage.has(chat.sessionId)) {
      sessionFirstUserMessage.set(chat.sessionId, chat.message);
    }
  }

  const sessions = Array.from(sessionsByUpdatedAt.entries())
    .map(([id, updatedAt]) => ({
      sessionId: id,
      updatedAt,
      title: buildSessionTitle(sessionFirstUserMessage.get(id))
    }))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  return { chats, runs, sessions };
}

export async function deleteHistorySession(sessionId: string, workspaceRoot?: string): Promise<void> {
  const normalizedWorkspace = workspaceRoot?.toLowerCase();
  const normalizedSessionId = sessionId.toLowerCase();

  await enqueueWrite(async (history) => {
    history.chats = history.chats.filter((item) => {
      if (!item.sessionId || item.sessionId.toLowerCase() !== normalizedSessionId) {
        return true;
      }
      if (!normalizedWorkspace) {
        return false;
      }
      return item.workspaceRoot?.toLowerCase() !== normalizedWorkspace;
    });

    history.runs = history.runs.filter((item) => {
      if (!item.sessionId || item.sessionId.toLowerCase() !== normalizedSessionId) {
        return true;
      }
      if (!normalizedWorkspace) {
        return false;
      }
      return item.workspaceRoot?.toLowerCase() !== normalizedWorkspace;
    });
  });
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

function buildSessionTitle(firstUserMessage?: string): string {
  if (!firstUserMessage) {
    return "New Chat";
  }
  const compact = firstUserMessage.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "New Chat";
  }
  return compact.length > 56 ? `${compact.slice(0, 56)}...` : compact;
}
