export interface IssueRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  position: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: IssueRef[];
  createdAt: string | null;
  updatedAt: string | null;
}

export type BoardColumnId = "Todo" | "In Progress" | "Done";

export interface WorkflowDefinition {
  path: string;
  config: Record<string, unknown>;
  promptTemplate: string;
}

export interface RuntimeConfig {
  workflowPath: string;
  tracker: {
    kind: string;
    path: string | null;
    activeStates: string[];
    terminalStates: string[];
  };
  polling: {
    intervalMs: number;
  };
  workspace: {
    root: string;
  };
  hooks: {
    afterCreate: string | null;
    beforeRun: string | null;
    afterRun: string | null;
    beforeRemove: string | null;
    timeoutMs: number;
  };
  agent: {
    maxConcurrentAgents: number;
    maxTurns: number;
    maxRetryBackoffMs: number;
    maxConcurrentAgentsByState: Record<string, number>;
  };
  codex: {
    command: string;
    turnTimeoutMs: number;
    readTimeoutMs: number;
    stallTimeoutMs: number;
  };
  server: {
    port: number | null;
    host: string;
  };
}

export interface ValidationError {
  code: string;
  message: string;
}

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  error: string | null;
  kind: "continuation" | "retry";
  resumeThreadId: string | null;
}

export interface RunningEntry {
  issue: Issue;
  workspacePath: string;
  startedAt: string;
  threadId: string | null;
  sessionId: string | null;
  turnCount: number;
  lastEvent: string | null;
  lastMessage: string | null;
  lastEventAt: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  attempt: number | null;
  processId: number | null;
  finishReason: "success" | "failure" | "cancelled" | null;
  finishError: string | null;
}

export interface RunnerUpdate {
  type:
    | "thread.started"
    | "turn.started"
    | "turn.completed"
    | "turn.failed"
    | "turn.cancelled"
    | "agent.message"
    | "log";
  timestamp: string;
  threadId?: string | null;
  sessionId?: string | null;
  turnCount?: number;
  message?: string | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface RunnerResult {
  status: "success" | "failure" | "cancelled";
  error: string | null;
  threadId: string | null;
  sessionId: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface Snapshot {
  generatedAt: string;
  counts: {
    running: number;
    retrying: number;
    tracked: number;
  };
  running: Array<Record<string, unknown>>;
  retrying: Array<Record<string, unknown>>;
  trackedIssues: Array<Record<string, unknown>>;
  board: {
    columns: Array<Record<string, unknown>>;
  };
  codexTotals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    secondsRunning: number;
  };
  rateLimits: Record<string, unknown> | null;
  workflowError: ValidationError | null;
}
