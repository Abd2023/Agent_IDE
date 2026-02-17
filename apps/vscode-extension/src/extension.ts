import * as vscode from "vscode";
import path from "node:path";
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
    let currentSessionId = createSessionId();
    const changedLineDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
      overviewRulerColor: "rgba(255, 190, 70, 0.9)",
      overviewRulerLane: vscode.OverviewRulerLane.Left
    });
    const changedLinesByFile = new Map<string, number[]>();
    const panel = vscode.window.createWebviewPanel(
      "localAgentIDE.chat",
      "Local Agent IDE",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.html = getChatHtml();
    void loadHistoryIntoPanel(panel);

    const disposable = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (isOpenFileLineMessage(message)) {
        await openFileAtLine(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, message.payload.path, message.payload.line);
        return;
      }

      if (isSessionNewMessage(message)) {
        currentSessionId = createSessionId();
        stopRunPolling();
        changedLinesByFile.clear();
        clearAllLineHighlights(changedLineDecoration);
        await loadHistoryIntoPanel(panel, currentSessionId);
        return;
      }

      if (isSessionSelectMessage(message)) {
        currentSessionId = message.payload.sessionId;
        stopRunPolling();
        changedLinesByFile.clear();
        clearAllLineHighlights(changedLineDecoration);
        await loadHistoryIntoPanel(panel, currentSessionId);
        return;
      }

      if (isSessionDeleteMessage(message)) {
        try {
          await deleteSessionFromAgentService(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, message.payload.sessionId);
          if (currentSessionId === message.payload.sessionId) {
            currentSessionId = createSessionId();
            changedLinesByFile.clear();
            clearAllLineHighlights(changedLineDecoration);
            await loadHistoryIntoPanel(panel, currentSessionId);
            return;
          }
          await loadHistoryIntoPanel(panel, currentSessionId);
        } catch (error) {
          panel.webview.postMessage({ type: "chat.error", payload: "Failed to delete session." });
          console.error("[local-agent-ide] session delete failed", error);
        }
        return;
      }

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

      const text = (typeof message.payload === "string" ? message.payload : message.payload.text).trim();
      if (!text) {
        return;
      }

      try {
        const chatResponse = await sendToAgentService({
          message: text,
          workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          sessionId: currentSessionId
        });

        panel.webview.postMessage({ type: "chat.response", payload: chatResponse });
        await postSessionState(panel, currentSessionId);
        const shouldRunTask = typeof message.payload === "string" ? false : Boolean(message.payload.runTask);
        if (shouldRunTask) {
          const planResponse = await requestPlanFromAgentService({
            task: text,
            workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            approvalMode: getApprovalMode(),
            sessionId: currentSessionId
          });
          panel.webview.postMessage({ type: "plan.response", payload: planResponse });
          stopRunPolling();
          startRunPolling(planResponse.runId);
        }
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
      clearAllLineHighlights(changedLineDecoration);
      changedLineDecoration.dispose();
      disposable.dispose();
    });

    function startRunPolling(runId: string): void {
      const poll = async (): Promise<void> => {
        try {
          const status = await fetchRunStatusFromAgentService(runId);
          panel.webview.postMessage({ type: "run.status", payload: status });
          updateLineHighlights(status.logs, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, changedLinesByFile);
          applyLineHighlights(changedLineDecoration, changedLinesByFile);

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

    async function loadHistoryIntoPanel(targetPanel: vscode.WebviewPanel, forcedSessionId?: string): Promise<void> {
      try {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!forcedSessionId) {
          const all = await fetchHistoryFromAgentService(workspaceRoot);
          if (all.sessions.length > 0) {
            currentSessionId = all.sessions[all.sessions.length - 1].sessionId;
          }
        } else {
          currentSessionId = forcedSessionId;
        }

        const history = await fetchHistoryFromAgentService(workspaceRoot, currentSessionId);
        targetPanel.webview.postMessage({ type: "history.load", payload: history });
        targetPanel.webview.postMessage({ type: "session.state", payload: { currentSessionId, sessions: history.sessions } });
      } catch (error) {
        targetPanel.webview.postMessage({
          type: "chat.error",
          payload: "Could not load persisted session history."
        });
        console.error("[local-agent-ide] history load failed", error);
      }
    }

    const activeEditorListener = vscode.window.onDidChangeActiveTextEditor(() => {
      applyLineHighlights(changedLineDecoration, changedLinesByFile);
    });
    const visibleEditorsListener = vscode.window.onDidChangeVisibleTextEditors(() => {
      applyLineHighlights(changedLineDecoration, changedLinesByFile);
    });
    context.subscriptions.push(activeEditorListener, visibleEditorsListener);

    async function postSessionState(targetPanel: vscode.WebviewPanel, activeSessionId: string): Promise<void> {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const all = await fetchHistoryFromAgentService(workspaceRoot);
      targetPanel.webview.postMessage({ type: "session.state", payload: { currentSessionId: activeSessionId, sessions: all.sessions } });
    }
  });

  context.subscriptions.push(command);
}

export function deactivate(): void {
  // no-op for scaffold
}

function updateLineHighlights(logs: string[], workspaceRoot: string | undefined, target: Map<string, number[]>): void {
  if (!workspaceRoot) {
    return;
  }
  target.clear();
  for (const line of logs) {
    const match = line.match(/line_diff:\s(.+?):(\d+):\s-\s([\s\S]*)\s\|\|\s\+\s([\s\S]*)$/);
    if (!match) {
      continue;
    }
    const relativePath = match[1];
    const lineNumber = Number(match[2]);
    if (!Number.isFinite(lineNumber) || lineNumber < 1) {
      continue;
    }
    const absolutePath = path.resolve(workspaceRoot, relativePath.replace(/\//g, path.sep));
    const existing = target.get(absolutePath) ?? [];
    if (!existing.includes(lineNumber)) {
      existing.push(lineNumber);
      target.set(absolutePath, existing);
    }
  }
}

function applyLineHighlights(
  decoration: vscode.TextEditorDecorationType,
  changedLinesByFile: Map<string, number[]>
): void {
  for (const editor of vscode.window.visibleTextEditors) {
    const key = editor.document.uri.fsPath;
    const lines = changedLinesByFile.get(key) ?? [];
    const ranges = lines.map((line) => {
      const zero = Math.max(0, line - 1);
      return new vscode.Range(new vscode.Position(zero, 0), new vscode.Position(zero, 0));
    });
    editor.setDecorations(decoration, ranges);
  }
}

function clearAllLineHighlights(decoration: vscode.TextEditorDecorationType): void {
  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(decoration, []);
  }
}

async function openFileAtLine(workspaceRoot: string | undefined, relativePath: string, line: number): Promise<void> {
  if (!workspaceRoot) {
    return;
  }
  const normalized = relativePath.replace(/\//g, path.sep);
  const absolutePath = path.resolve(workspaceRoot, normalized);
  const document = await vscode.workspace.openTextDocument(absolutePath);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const zeroBasedLine = Math.max(0, line - 1);
  const pos = new vscode.Position(zeroBasedLine, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

function getChatHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Local Agent IDE</title>
    <style>
      :root {
        --bg0: #12161f;
        --bg1: #1c2431;
        --panel: #0f141c;
        --line: #324258;
        --text: #e8edf6;
        --muted: #9fb0c7;
        --accent: #53c7a8;
        --warn: #e7b152;
      }
      body {
        font-family: "Segoe UI Variable Text", "Trebuchet MS", "Tahoma", sans-serif;
        color: var(--text);
        background: radial-gradient(1400px 600px at -10% -10%, #23314a 0%, transparent 50%),
          radial-gradient(1200px 500px at 110% 0%, #20403a 0%, transparent 45%), var(--bg0);
        padding: 10px;
        margin: 0;
      }
      .layout {
        display: grid;
        grid-template-rows: auto auto minmax(150px, 1.2fr) minmax(130px, 1fr) minmax(130px, 1fr) auto auto;
        height: 100vh;
        gap: 10px;
        padding: 10px;
        box-sizing: border-box;
      }
      .meta {
        font-size: 12px;
        color: var(--muted);
      }
      .topbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .topbar h2 {
        margin: 0;
        letter-spacing: 0.3px;
      }
      .toolbar {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .toolbar label {
        font-size: 12px;
        color: var(--muted);
      }
      select {
        font: inherit;
        color: var(--text);
        background: #111926;
        border: 1px solid #4f667e;
        border-radius: 8px;
        padding: 3px 8px;
      }
      .messages {
        border: 1px solid var(--line);
        border-radius: 10px;
        background: color-mix(in oklab, var(--panel) 90%, black);
        padding: 10px;
        overflow-y: auto;
        min-height: 0;
      }
      .plan {
        border: 1px solid var(--line);
        border-radius: 10px;
        background: color-mix(in oklab, var(--panel) 88%, black);
        padding: 10px;
        overflow-y: auto;
        min-height: 0;
      }
      .plan h3 {
        margin: 0 0 8px 0;
        font-size: 14px;
        color: var(--accent);
      }
      .plan .item {
        margin-bottom: 6px;
        padding: 6px;
        border-radius: 6px;
        background: rgba(176, 204, 255, 0.08);
      }
      .trace {
        border: 1px solid var(--line);
        border-radius: 10px;
        background: color-mix(in oklab, var(--panel) 88%, black);
        padding: 10px;
        overflow-y: auto;
        min-height: 0;
      }
      .trace h3 {
        margin: 0 0 8px 0;
        font-size: 14px;
        color: var(--accent);
      }
      .trace pre {
        white-space: pre-wrap;
        margin: 0;
        font-size: 12px;
        line-height: 1.35;
      }
      .approval {
        border: 1px solid var(--warn);
        border-radius: 8px;
        padding: 10px;
        background: rgba(180, 117, 15, 0.15);
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
        padding: 9px 10px;
        border-radius: 8px;
        background: rgba(178, 204, 245, 0.11);
        border-left: 3px solid rgba(83, 199, 168, 0.6);
      }
      .role {
        font-weight: 700;
        margin-right: 8px;
      }
      .composer {
        display: grid;
        grid-template-columns: 1fr auto auto;
        gap: 8px;
        min-height: 70px;
      }
      textarea {
        box-sizing: border-box;
        width: 100%;
        min-height: 72px;
        border-radius: 10px;
        border: 1px solid var(--line);
        background: #0e1219;
        color: var(--text);
        padding: 10px;
        resize: vertical;
        font: inherit;
      }
      button {
        font: inherit;
        border-radius: 8px;
        border: 1px solid #4f667e;
        color: var(--text);
        background: #1c2a3d;
        padding: 0 14px;
        cursor: pointer;
      }
      button:hover {
        background: #22324a;
      }
      #runTask {
        background: #1b3e39;
        border-color: #2f7a6a;
      }
      @media (max-height: 860px) {
        .layout {
          grid-template-rows: auto auto minmax(120px, 1fr) minmax(120px, 0.9fr) minmax(120px, 0.9fr) auto auto;
        }
      }
    </style>
  </head>
  <body>
    <div class="layout">
      <div class="topbar">
        <h2>Local Agent IDE Chat</h2>
        <div class="toolbar">
          <label for="sessionSelect">Session</label>
          <select id="sessionSelect"></select>
          <button id="deleteSession">Delete</button>
          <button id="newChat">New Chat</button>
        </div>
      </div>
      <div id="progressMeta" class="meta">Chat mode: Ask questions with Send. Use Run Task only when you want actions/files/browser execution.</div>
      <div id="messages" class="messages"></div>
      <div id="plan" class="plan">
        <h3>Plan Checklist</h3>
        <div class="meta">No run yet. Click Run Task to execute tools.</div>
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
        <textarea id="input" placeholder="Ask a question, or describe a task..."></textarea>
        <button id="send">Send</button>
        <button id="runTask">Run Task</button>
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
      const runTaskEl = document.getElementById("runTask");
      const newChatEl = document.getElementById("newChat");
      const deleteSessionEl = document.getElementById("deleteSession");
      const sessionSelectEl = document.getElementById("sessionSelect");
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

      function renderSessions(payload) {
        const sessions = payload.sessions || [];
        const current = payload.currentSessionId || "";
        sessionSelectEl.innerHTML = "";

        for (const item of sessions) {
          const option = document.createElement("option");
          option.value = item.sessionId;
          option.textContent = item.title || item.sessionId.slice(-8);
          if (item.sessionId === current) {
            option.selected = true;
          }
          sessionSelectEl.appendChild(option);
        }

        if (!sessions.find((item) => item.sessionId === current) && current) {
          const option = document.createElement("option");
          option.value = current;
          option.textContent = current.slice(-8);
          option.selected = true;
          sessionSelectEl.appendChild(option);
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

      function submitMessage(runTask) {
        const text = inputEl.value.trim();
        if (!text) return;
        addMessage("You:", text);
        vscode.postMessage({ type: "chat.send", payload: { text, runTask } });
        inputEl.value = "";
      }

      function resetRunPanels() {
        latestRunId = null;
        latestApprovalId = null;
        approvalEl.style.display = "none";
        planEl.innerHTML = "<h3>Plan Checklist</h3><div class='meta'>No run yet. Click Run Task to execute tools.</div>";
        traceEl.innerHTML = "<h3>Execution Trace</h3><div class='meta'>No traces yet.</div>";
        progressMetaEl.textContent = "Chat mode: Ask questions with Send. Use Run Task only when you want actions/files/browser execution.";
      }

      sendEl.addEventListener("click", () => submitMessage(false));
      runTaskEl.addEventListener("click", () => submitMessage(true));
      newChatEl.addEventListener("click", () => {
        vscode.postMessage({ type: "session.new" });
      });
      sessionSelectEl.addEventListener("change", () => {
        const sessionId = sessionSelectEl.value;
        if (!sessionId) return;
        vscode.postMessage({ type: "session.select", payload: { sessionId } });
      });
      deleteSessionEl.addEventListener("click", () => {
        const sessionId = sessionSelectEl.value;
        if (!sessionId) return;
        vscode.postMessage({ type: "session.delete", payload: { sessionId } });
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
          submitMessage(false);
        }
      });

      window.addEventListener("message", (event) => {
        const msg = event.data;
        if (msg.type === "chat.response") {
          const data = msg.payload;
          addMessage("Agent:", data.reply);
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
          resetRunPanels();
          restoreHistory(msg.payload);
          return;
        }
        if (msg.type === "session.state") {
          renderSessions(msg.payload);
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

async function fetchHistoryFromAgentService(workspaceRoot?: string, sessionId?: string): Promise<HistoryResponse> {
  const params = new URLSearchParams();
  if (workspaceRoot) {
    params.set("workspaceRoot", workspaceRoot);
  }
  if (sessionId) {
    params.set("sessionId", sessionId);
  }
  const query = params.toString() ? `?${params.toString()}` : "";
  const endpoint = getEndpoint(`/history${query}`);
  const response = await fetch(endpoint, { method: "GET" });

  if (!response.ok) {
    throw new Error(`agent-service returned status ${response.status}`);
  }

  return (await response.json()) as HistoryResponse;
}

async function deleteSessionFromAgentService(workspaceRoot: string | undefined, sessionId: string): Promise<void> {
  const params = new URLSearchParams();
  if (workspaceRoot) {
    params.set("workspaceRoot", workspaceRoot);
  }
  params.set("sessionId", sessionId);
  const query = `?${params.toString()}`;
  const endpoint = getEndpoint(`/history/session${query}`);
  const response = await fetch(endpoint, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`agent-service returned status ${response.status}`);
  }
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

function isChatSendMessage(
  value: unknown
): value is { type: "chat.send"; payload: { text: string; runTask?: boolean } | string } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { type?: unknown; payload?: unknown };
  if (candidate.type !== "chat.send" || candidate.payload === undefined || candidate.payload === null) {
    return false;
  }
  if (typeof candidate.payload === "string") {
    return true;
  }
  if (typeof candidate.payload !== "object") {
    return false;
  }
  const payload = candidate.payload as { text?: unknown; runTask?: unknown };
  if (typeof payload.text !== "string") {
    return false;
  }
  return payload.runTask === undefined || typeof payload.runTask === "boolean";
}

function isSessionNewMessage(value: unknown): value is { type: "session.new" } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { type?: unknown };
  return candidate.type === "session.new";
}

function isSessionSelectMessage(value: unknown): value is { type: "session.select"; payload: { sessionId: string } } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { type?: unknown; payload?: unknown };
  if (candidate.type !== "session.select" || !candidate.payload || typeof candidate.payload !== "object") {
    return false;
  }
  const payload = candidate.payload as { sessionId?: unknown };
  return typeof payload.sessionId === "string" && payload.sessionId.trim().length > 0;
}

function isSessionDeleteMessage(value: unknown): value is { type: "session.delete"; payload: { sessionId: string } } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { type?: unknown; payload?: unknown };
  if (candidate.type !== "session.delete" || !candidate.payload || typeof candidate.payload !== "object") {
    return false;
  }
  const payload = candidate.payload as { sessionId?: unknown };
  return typeof payload.sessionId === "string" && payload.sessionId.trim().length > 0;
}

function isOpenFileLineMessage(value: unknown): value is { type: "file.open_line"; payload: { path: string; line: number } } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { type?: unknown; payload?: unknown };
  if (candidate.type !== "file.open_line" || !candidate.payload || typeof candidate.payload !== "object") {
    return false;
  }
  const payload = candidate.payload as { path?: unknown; line?: unknown };
  return typeof payload.path === "string" && typeof payload.line === "number" && Number.isFinite(payload.line);
}

function createSessionId(): string {
  return `session_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
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
