import { createServer } from "node:http";
import { agentConfig } from "./config.js";
import type {
  ApprovalDecisionRequest,
  AgentPlan,
  ApprovalMode,
  ChatRequest,
  ChatResponse,
  HistoryResponse,
  PlanRequest,
  PlanResponse
} from "@local-agent-ide/core";
import { executeRun, getRunStatus, type ExecutionRun } from "./executor.js";
import { generateChatReply } from "./model.js";
import { appendChatHistory, getHistorySnapshot, upsertRunHistory } from "./storage.js";

const runs = new Map<string, ExecutionRun>();
const approvalResolvers = new Map<string, { approvalId: string; resolve: (approved: boolean) => void }>();

const server = createServer((req, res) => {
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const pathname = requestUrl.pathname;

  if (req.method === "GET" && pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "agent-service",
        modelEndpoint: agentConfig.modelEndpoint
      })
    );
    return;
  }

  if (req.method === "GET" && pathname === "/history") {
    const workspaceRoot = requestUrl.searchParams.get("workspaceRoot") ?? undefined;
    getHistorySnapshot(workspaceRoot)
      .then((history) => {
        const response: HistoryResponse = history;
        sendJson(res, 200, response);
      })
      .catch((error) => {
        console.error("[agent-service] failed to read history", error);
        sendJson(res, 500, { error: "history_read_failed" });
      });
    return;
  }

  if (req.method === "POST" && pathname === "/chat") {
    readJsonBody<ChatRequest>(req)
      .then((body) => {
        if (!body.message || typeof body.message !== "string") {
          sendJson(res, 400, { error: "invalid_message" });
          return;
        }

        void appendChatHistory({
          role: "user",
          message: body.message.trim(),
          workspaceRoot: body.workspaceRoot
        });

        generateChatReply(body.message, body.workspaceRoot)
          .then((reply) => {
            void appendChatHistory({
              role: "agent",
              message: reply,
              workspaceRoot: body.workspaceRoot
            });

            const response: ChatResponse = {
              reply,
              currentStep: "Step 5/6: Approval modes and safety controls are active",
              nextStep: "Step 6/6: Add terminal/browser tools and richer traces",
              timestamp: new Date().toISOString()
            };
            sendJson(res, 200, response);
          })
          .catch((error) => {
            console.warn("[agent-service] model chat failed, using fallback", error);
            const fallback = buildFallbackReply(body.message, body.workspaceRoot);
            void appendChatHistory({
              role: "agent",
              message: fallback,
              workspaceRoot: body.workspaceRoot
            });
            const response: ChatResponse = {
              reply: fallback,
              currentStep: "Step 5/6: Approval modes and safety controls are active",
              nextStep: "Step 6/6: Add terminal/browser tools and richer traces",
              timestamp: new Date().toISOString()
            };
            sendJson(res, 200, response);
          });
      })
      .catch(() => {
        sendJson(res, 400, { error: "invalid_json" });
      });
    return;
  }

  if (req.method === "POST" && pathname === "/plan") {
    readJsonBody<PlanRequest>(req)
      .then((body) => {
        if (!body.task || typeof body.task !== "string") {
          sendJson(res, 400, { error: "invalid_task" });
          return;
        }

        const runId = createRunId();
        const plan = buildPlan(body.task);
        const run: ExecutionRun = {
          runId,
          task: body.task.trim(),
          workspaceRoot: body.workspaceRoot,
          approvalMode: normalizeApprovalMode(body.approvalMode),
          plan,
          isFinished: false,
          updatedAt: new Date().toISOString(),
          logs: [],
          requestApproval: ({ tool, summary }) =>
            new Promise<boolean>((resolve) => {
              const approvalId = createRunId();
              run.pendingApproval = {
                approvalId,
                tool,
                summary,
                createdAt: new Date().toISOString()
              };
              run.updatedAt = new Date().toISOString();
              run.logs.push(`[${run.updatedAt}] awaiting_approval: ${summary}`);
              if (run.logs.length > 200) {
                run.logs.splice(0, run.logs.length - 200);
              }
              approvalResolvers.set(run.runId, { approvalId, resolve });
              run.onUpdate?.(run);
            }),
          onUpdate: (updatedRun) => {
            void upsertRunHistory({
              runId: updatedRun.runId,
              task: updatedRun.task,
              workspaceRoot: updatedRun.workspaceRoot,
              approvalMode: updatedRun.approvalMode,
              plan: updatedRun.plan,
              isFinished: updatedRun.isFinished,
              updatedAt: updatedRun.updatedAt,
              logs: updatedRun.logs
            });
          }
        };
        runs.set(runId, run);
        void upsertRunHistory({
          runId: run.runId,
          task: run.task,
          workspaceRoot: run.workspaceRoot,
          approvalMode: run.approvalMode,
          plan: run.plan,
          isFinished: run.isFinished,
          updatedAt: run.updatedAt,
          logs: run.logs
        });
        void executeRun(run);

        const response: PlanResponse = {
          runId,
          plan,
          currentStep: "Step 5/6: Model-driven execution started with safety policy",
          nextStep: "Track step state with GET /runs/:runId",
          timestamp: new Date().toISOString()
        };

        sendJson(res, 200, response);
      })
      .catch(() => {
        sendJson(res, 400, { error: "invalid_json" });
      });
    return;
  }

  const runId = getRunIdFromPath(pathname);
  if (req.method === "GET" && runId) {
    const run = runs.get(runId);
    if (!run) {
      sendJson(res, 404, { error: "run_not_found" });
      return;
    }

    const progress = getRunStatus(run);
    sendJson(res, 200, progress);
    return;
  }

  const approvalRunId = getRunApprovalIdFromPath(pathname);
  if (req.method === "POST" && approvalRunId) {
    readJsonBody<ApprovalDecisionRequest>(req)
      .then((body) => {
        const run = runs.get(approvalRunId);
        if (!run) {
          sendJson(res, 404, { error: "run_not_found" });
          return;
        }

        const resolverState = approvalResolvers.get(approvalRunId);
        if (!resolverState || !run.pendingApproval) {
          sendJson(res, 409, { error: "no_pending_approval" });
          return;
        }

        if (!body || (body.decision !== "approve" && body.decision !== "reject")) {
          sendJson(res, 400, { error: "invalid_decision" });
          return;
        }

        if (body.approvalId !== resolverState.approvalId || body.approvalId !== run.pendingApproval.approvalId) {
          sendJson(res, 409, { error: "approval_id_mismatch" });
          return;
        }

        approvalResolvers.delete(approvalRunId);
        run.pendingApproval = undefined;
        run.updatedAt = new Date().toISOString();
        run.onUpdate?.(run);
        resolverState.resolve(body.decision === "approve");
        sendJson(res, 200, { ok: true });
      })
      .catch(() => {
        sendJson(res, 400, { error: "invalid_json" });
      });
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(agentConfig.port, () => {
  console.log(`[agent-service] listening on http://localhost:${agentConfig.port}`);
});

function sendJson(res: import("node:http").ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readJsonBody<T>(req: import("node:http").IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(raw) as T;
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", (error) => {
      reject(error);
    });
  });
}

function buildFallbackReply(message: string, workspaceRoot?: string): string {
  const location = workspaceRoot ? `Workspace: ${workspaceRoot}` : "Workspace not provided.";
  return [
    "Message received by local agent-service (fallback mode).",
    `Task: ${message.trim()}`,
    location,
    `Model endpoint configured: ${agentConfig.modelEndpoint}`
  ].join(" ");
}

function buildPlan(task: string): AgentPlan {
  const normalizedTask = task.trim();
  return {
    task: normalizedTask,
    steps: [
      {
        id: "analyze-task",
        title: `Analyze task scope: "${normalizedTask}"`,
        status: "in_progress"
      },
      {
        id: "scan-project",
        title: "Scan project files and identify impacted modules",
        status: "pending"
      },
      {
        id: "implement",
        title: "Implement code changes for the requested task",
        status: "pending"
      },
      {
        id: "verify",
        title: "Run validations/tests and inspect outputs",
        status: "pending"
      },
      {
        id: "finalize",
        title: "Summarize changes and list next actions",
        status: "pending"
      }
    ]
  };
}

function createRunId(): string {
  return `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeApprovalMode(mode: unknown): ApprovalMode {
  if (mode === "ask" || mode === "auto" || mode === "unrestricted") {
    return mode;
  }

  const fallback = agentConfig.defaultApprovalMode;
  if (fallback === "ask" || fallback === "auto" || fallback === "unrestricted") {
    return fallback;
  }

  return "auto";
}

function getRunIdFromPath(pathname: string): string | null {
  const match = /^\/runs\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

function getRunApprovalIdFromPath(pathname: string): string | null {
  const match = /^\/runs\/([^/]+)\/approval$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}
