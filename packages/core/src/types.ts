export type StepStatus = "pending" | "in_progress" | "completed" | "failed";
export type ApprovalMode = "ask" | "auto" | "unrestricted";

export interface AgentStep {
  id: string;
  title: string;
  status: StepStatus;
  notes?: string;
}

export interface AgentPlan {
  task: string;
  steps: AgentStep[];
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface RunState {
  runId: string;
  plan: AgentPlan;
  startedAt: string;
  updatedAt: string;
}

export interface ChatRequest {
  message: string;
  workspaceRoot?: string;
  sessionId?: string;
}

export interface ChatResponse {
  reply: string;
  currentStep: string;
  nextStep: string;
  timestamp: string;
}

export interface PlanRequest {
  task: string;
  workspaceRoot?: string;
  approvalMode?: ApprovalMode;
  sessionId?: string;
}

export interface PlanResponse {
  runId: string;
  plan: AgentPlan;
  currentStep: string;
  nextStep: string;
  timestamp: string;
}

export interface RunStatusResponse {
  runId: string;
  plan: AgentPlan;
  isFinished: boolean;
  currentStep: string;
  nextStep: string;
  timestamp: string;
  logs: string[];
  pendingApproval?: PendingApprovalRequest;
}

export interface PendingApprovalRequest {
  approvalId: string;
  tool: string;
  summary: string;
  createdAt: string;
}

export interface ApprovalDecisionRequest {
  approvalId: string;
  decision: "approve" | "reject";
}

export interface ChatHistoryItem {
  id: string;
  role: "user" | "agent";
  message: string;
  workspaceRoot?: string;
  sessionId?: string;
  timestamp: string;
}

export interface RunHistoryItem {
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

export interface HistorySessionItem {
  sessionId: string;
  updatedAt: string;
  title: string;
}

export interface HistoryResponse {
  chats: ChatHistoryItem[];
  runs: RunHistoryItem[];
  sessions: HistorySessionItem[];
}
