import * as vscode from "vscode";
import type {
  ApprovalDecisionRequest,
  ApprovalMode,
  ChatRequest,
  ChatResponse,
  HistoryResponse,
  PlanRequest,
  PlanResponse,
  RunStatusResponse
} from "@local-agent-ide/core";

export function activate(context: vscode.ExtensionContext): void {
  const command = vscode.commands.registerCommand("localAgentIDE.openChatPanel", () => {
    let runPollingTimer: NodeJS.Timeout | undefined;
    const panel = vscode.window.createWebviewPanel(
      "localAgentIDE.chat",
      "Local Agent IDE",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.html = getChatHtml();
    void loadHistoryIntoPanel(panel);

    const disposable = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (isApprovalDecisionMessage(message)) {
        try {
          await submitApprovalToAgentService(message.payload.runId, {
            approvalId: message.payload.approvalId,
            decision: message.payload.decision
          });
        } catch (error) {
          panel.webview.postMessage({
            type: "chat.error",
            payload: "Failed to submit approval decision."
          });
          console.error("[local-agent-ide] approval submit failed", error);
        }
        return;
      }

      if (!isChatSendMessage(message)) {
        return;
      }

      const text = message.payload.trim();
      if (!text) {
        return;
      }

      try {
        const chatResponse = await sendToAgentService({
          message: text,
          workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        });
        const planResponse = await requestPlanFromAgentService({
          task: text,
          workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          approvalMode: getApprovalMode()
        });

        panel.webview.postMessage({ type: "chat.response", payload: chatResponse });
        panel.webview.postMessage({ type: "plan.response", payload: planResponse });
        stopRunPolling();
        startRunPolling(planResponse.runId);
      } catch (error) {
        panel.webview.postMessage({
          type: "chat.error",
          payload: "Could not reach agent-service. Make sure it is running on the configured URL."
        });

        console.error("[local-agent-ide] chat send failed", error);
      }
    });

    panel.onDidDispose(() => {
      stopRunPolling();
      disposable.dispose();
    });

    function startRunPolling(runId: string): void {
      const poll = async (): Promise<void> => {
        try {
          const status = await fetchRunStatusFromAgentService(runId);
          panel.webview.postMessage({ type: "run.status", payload: status });

          if (status.isFinished) {
            stopRunPolling();
          }
        } catch (error) {
          stopRunPolling();
          panel.webview.postMessage({
            type: "chat.error",
            payload: "Run status polling failed. Check if agent-service is still running."
          });
          console.error("[local-agent-ide] run polling failed", error);
        }
      };

      poll().catch((error) => console.error(error));
      runPollingTimer = setInterval(() => {
        poll().catch((error) => console.error(error));
      }, 1000);
    }

    function stopRunPolling(): void {
      if (!runPollingTimer) {
        return;
      }

      clearInterval(runPollingTimer);
      runPollingTimer = undefined;
    }

    async function loadHistoryIntoPanel(targetPanel: vscode.WebviewPanel): Promise<void> {
      try {
        const history = await fetchHistoryFromAgentService(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
        targetPanel.webview.postMessage({ type: "history.load", payload: history });
      } catch (error) {
        targetPanel.webview.postMessage({
          type: "chat.error",
          payload: "Could not load persisted session history."
        });
        console.error("[local-agent-ide] history load failed", error);
      }
    }
  });

  context.subscriptions.push(command);
}

export function deactivate(): void {
  // no-op for scaffold
}

function getChatHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Local Agent IDE</title>
    <style>
      body {
        font-family: ui-sans-serif, system-ui, sans-serif;
        padding: 16px;
        margin: 0;
      }
      .layout {
        display: grid;
        grid-template-rows: auto 1fr auto;
        height: 100vh;
        gap: 12px;
        padding: 16px;
      }
      .meta {
        font-size: 12px;
        opacity: 0.8;
      }
      .messages {
        border: 1px solid #555;
        border-radius: 8px;
        padding: 10px;
        overflow-y: auto;
      }
      .plan {
        border: 1px solid #555;
        border-radius: 8px;
        padding: 10px;
      }
      .plan h3 {
        margin: 0 0 8px 0;
        font-size: 14px;
      }
      .plan .item {
        margin-bottom: 6px;
        padding: 6px;
        border-radius: 6px;
        background: rgba(127, 127, 127, 0.08);
      }
      .trace {
        border: 1px solid #555;
        border-radius: 8px;
        padding: 10px;
        overflow-y: auto;
      }
      .trace h3 {
        margin: 0 0 8px 0;
        font-size: 14px;
      }
      .trace pre {
        white-space: pre-wrap;
        margin: 0;
        font-size: 12px;
        line-height: 1.35;
      }
      .approval {
        border: 1px solid #996c00;
        border-radius: 8px;
        padding: 10px;
        background: rgba(153, 108, 0, 0.12);
      }
      .approval h3 {
        margin: 0 0 8px 0;
        font-size: 14px;
      }
      .approval .actions {
        display: flex;
        gap: 8px;
        margin-top: 8px;
      }
      .msg {
        margin-bottom: 8px;
        padding: 8px;
        border-radius: 6px;
        background: rgba(127, 127, 127, 0.12);
      }
      .role {
        font-weight: 700;
        margin-right: 8px;
      }
      .composer {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
      }
      textarea {
        width: 100%;
        min-height: 72px;
        resize: vertical;
        font: inherit;
      }
      button {
        font: inherit;
        padding: 0 14px;
      }
    </style>
  </head>
  <body>
    <div class="layout">
      <div>
        <h2>Local Agent IDE Chat</h2>
        <div id="progressMeta" class="meta">Current: Step 6/6 in progress. Next: terminal/browser tools and richer traces.</div>
      </div>
      <div id="messages" class="messages"></div>
      <div id="plan" class="plan">
        <h3>Plan Checklist</h3>
        <div class="meta">No plan yet. Send a task to generate one.</div>
      </div>
      <div id="trace" class="trace">
        <h3>Execution Trace</h3>
        <div class="meta">No traces yet.</div>
      </div>
      <div id="approval" class="approval" style="display:none;">
        <h3>Approval Required</h3>
        <div id="approvalText" class="meta"></div>
        <div class="actions">
          <button id="approveBtn">Approve</button>
          <button id="rejectBtn">Reject</button>
        </div>
      </div>
      <div class="composer">
        <textarea id="input" placeholder="Describe the coding task..."></textarea>
        <button id="send">Send</button>
      </div>
    </div>
    <script>
      const vscode = acquireVsCodeApi();
      const messagesEl = document.getElementById("messages");
      const planEl = document.getElementById("plan");
      const traceEl = document.getElementById("trace");
      const progressMetaEl = document.getElementById("progressMeta");
      const inputEl = document.getElementById("input");
      const sendEl = document.getElementById("send");
      const approvalEl = document.getElementById("approval");
      const approvalTextEl = document.getElementById("approvalText");
      const approveBtnEl = document.getElementById("approveBtn");
      const rejectBtnEl = document.getElementById("rejectBtn");
      let latestRunId = null;
      let latestApprovalId = null;

      function addMessage(role, text) {
        const node = document.createElement("div");
        node.className = "msg";
        const roleEl = document.createElement("span");
        roleEl.className = "role";
        roleEl.textContent = role;
        node.appendChild(roleEl);
        node.appendChild(document.createTextNode(text));
        messagesEl.appendChild(node);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      function renderPlan(payload) {
        latestRunId = payload.runId;
        planEl.innerHTML = "";

        const heading = document.createElement("h3");
        heading.textContent = "Plan Checklist";
        planEl.appendChild(heading);

        const runMeta = document.createElement("div");
        runMeta.className = "meta";
        runMeta.textContent = "Run: " + payload.runId + " | Task: " + payload.plan.task;
        planEl.appendChild(runMeta);

        for (const step of payload.plan.steps) {
          const item = document.createElement("div");
          item.className = "item";
          const suffix = step.notes ? " - " + step.notes : "";
          item.textContent = statusIcon(step.status) + " " + step.title + " [" + step.status + "]" + suffix;
          planEl.appendChild(item);
        }

        progressMetaEl.textContent = "Current: " + payload.currentStep + " | Next: " + payload.nextStep;
        renderTrace(payload.logs || []);
        renderApproval(payload.pendingApproval || null);
      }

      function restoreHistory(payload) {
        messagesEl.innerHTML = "";
        for (const item of payload.chats || []) {
          const role = item.role === "user" ? "You:" : "Agent:";
          addMessage(role, item.message);
        }

        const runs = payload.runs || [];
        if (runs.length > 0) {
          const latest = runs[runs.length - 1];
          renderPlan({
            runId: latest.runId,
            plan: latest.plan,
            isFinished: latest.isFinished,
            currentStep: latest.isFinished ? "Restored completed run" : "Restored active run",
            nextStep: latest.isFinished ? "Send a new task to start another run" : "Run can continue on new tasks",
            timestamp: latest.updatedAt,
            logs: latest.logs || []
          });
          addMessage("System:", "Previous session restored.");
        }
      }

      function renderTrace(logs) {
        traceEl.innerHTML = "";
        const heading = document.createElement("h3");
        heading.textContent = "Execution Trace";
        traceEl.appendChild(heading);

        if (!logs.length) {
          const meta = document.createElement("div");
          meta.className = "meta";
          meta.textContent = "No traces yet.";
          traceEl.appendChild(meta);
          return;
        }

        const block = document.createElement("pre");
        block.textContent = logs.join("\\n");
        traceEl.appendChild(block);
      }

      function renderApproval(pendingApproval) {
        if (!pendingApproval) {
          latestApprovalId = null;
          approvalEl.style.display = "none";
          return;
        }

        latestApprovalId = pendingApproval.approvalId;
        approvalTextEl.textContent = pendingApproval.tool + ": " + pendingApproval.summary;
        approvalEl.style.display = "block";
      }

      function statusIcon(status) {
        if (status === "completed") return "[x]";
        if (status === "in_progress") return "[~]";
        if (status === "failed") return "[!]";
        return "[ ]";
      }

      sendEl.addEventListener("click", () => {
        const text = inputEl.value.trim();
        if (!text) return;
        addMessage("You:", text);
        vscode.postMessage({ type: "chat.send", payload: text });
        inputEl.value = "";
      });

      approveBtnEl.addEventListener("click", () => {
        if (!latestRunId || !latestApprovalId) return;
        vscode.postMessage({
          type: "approval.submit",
          payload: { runId: latestRunId, approvalId: latestApprovalId, decision: "approve" }
        });
      });

      rejectBtnEl.addEventListener("click", () => {
        if (!latestRunId || !latestApprovalId) return;
        vscode.postMessage({
          type: "approval.submit",
          payload: { runId: latestRunId, approvalId: latestApprovalId, decision: "reject" }
        });
      });

      inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          sendEl.click();
        }
      });

      window.addEventListener("message", (event) => {
        const msg = event.data;
        if (msg.type === "chat.response") {
          const data = msg.payload;
          addMessage("Agent:", data.reply);
          addMessage("Progress:", "Current: " + data.currentStep + " | Next: " + data.nextStep);
          return;
        }
        if (msg.type === "plan.response") {
          renderPlan(msg.payload);
          return;
        }
        if (msg.type === "run.status") {
          renderPlan(msg.payload);
          if (msg.payload.isFinished) {
            addMessage("Agent:", "Checklist execution finished.");
          }
          return;
        }
        if (msg.type === "history.load") {
          restoreHistory(msg.payload);
          return;
        }

        if (msg.type === "chat.error") {
          addMessage("Error:", msg.payload);
        }
      });
    </script>
  </body>
</html>`;
}

async function sendToAgentService(request: ChatRequest): Promise<ChatResponse> {
  const endpoint = getEndpoint("/chat");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    throw new Error(`agent-service returned status ${response.status}`);
  }

  return (await response.json()) as ChatResponse;
}

async function requestPlanFromAgentService(request: PlanRequest): Promise<PlanResponse> {
  const endpoint = getEndpoint("/plan");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    throw new Error(`agent-service returned status ${response.status}`);
  }

  return (await response.json()) as PlanResponse;
}

async function fetchRunStatusFromAgentService(runId: string): Promise<RunStatusResponse> {
  const endpoint = getEndpoint(`/runs/${encodeURIComponent(runId)}`);
  const response = await fetch(endpoint, { method: "GET" });

  if (!response.ok) {
    throw new Error(`agent-service returned status ${response.status}`);
  }

  return (await response.json()) as RunStatusResponse;
}

async function fetchHistoryFromAgentService(workspaceRoot?: string): Promise<HistoryResponse> {
  const query = workspaceRoot ? `?workspaceRoot=${encodeURIComponent(workspaceRoot)}` : "";
  const endpoint = getEndpoint(`/history${query}`);
  const response = await fetch(endpoint, { method: "GET" });

  if (!response.ok) {
    throw new Error(`agent-service returned status ${response.status}`);
  }

  return (await response.json()) as HistoryResponse;
}

async function submitApprovalToAgentService(runId: string, request: ApprovalDecisionRequest): Promise<void> {
  const endpoint = getEndpoint(`/runs/${encodeURIComponent(runId)}/approval`);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    throw new Error(`agent-service returned status ${response.status}`);
  }
}

function getEndpoint(path: string): string {
  const config = vscode.workspace.getConfiguration("localAgentIDE");
  const baseUrl = config.get<string>("agentServiceUrl", "http://localhost:4000");
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function getApprovalMode(): ApprovalMode {
  const config = vscode.workspace.getConfiguration("localAgentIDE");
  const mode = config.get<string>("approvalMode", "auto");
  if (mode === "ask" || mode === "auto" || mode === "unrestricted") {
    return mode;
  }
  return "auto";
}

function isChatSendMessage(value: unknown): value is { type: "chat.send"; payload: string } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { type?: unknown; payload?: unknown };
  return candidate.type === "chat.send" && typeof candidate.payload === "string";
}

function isApprovalDecisionMessage(
  value: unknown
): value is { type: "approval.submit"; payload: { runId: string; approvalId: string; decision: "approve" | "reject" } } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { type?: unknown; payload?: unknown };
  if (candidate.type !== "approval.submit" || !candidate.payload || typeof candidate.payload !== "object") {
    return false;
  }

  const payload = candidate.payload as { runId?: unknown; approvalId?: unknown; decision?: unknown };
  return (
    typeof payload.runId === "string" &&
    typeof payload.approvalId === "string" &&
    (payload.decision === "approve" || payload.decision === "reject")
  );
}
