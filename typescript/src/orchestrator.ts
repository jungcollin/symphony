import path from "node:path";

import { AgentRunner, type AgentRunHandle } from "./agent-runner.ts";
import {
  BOARD_COLUMNS,
  isTerminalStateValue,
  normalizeState,
  resolveStateForBoardColumn,
  sortIssues,
  todoLikeState,
  trackerBoardColumn,
} from "./board.ts";
import { FileTracker, type TrackerAdapter } from "./tracker.ts";
import { renderPrompt, WorkflowStore } from "./workflow.ts";
import { WorkspaceManager } from "./workspace.ts";
import type {
  BoardColumnId,
  Issue,
  RetryEntry,
  RunningEntry,
  RuntimeConfig,
  Snapshot,
  ValidationError,
} from "./types.ts";

function nowIso(): string {
  return new Date().toISOString();
}

function isTerminalState(issue: Issue, config: RuntimeConfig): boolean {
  return isTerminalStateValue(issue.state, config);
}

function isActiveState(issue: Issue, config: RuntimeConfig): boolean {
  return config.tracker.activeStates.map(normalizeState).includes(normalizeState(issue.state));
}

function issueToTemplateContext(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    position: issue.position,
    state: issue.state,
    branch_name: issue.branchName,
    url: issue.url,
    labels: issue.labels,
    blocked_by: issue.blockedBy.map((entry) => ({
      id: entry.id,
      identifier: entry.identifier,
      state: entry.state,
    })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

export class SymphonyOrchestrator {
  private readonly workflowStore: WorkflowStore;
  private tracker: TrackerAdapter | null = null;
  private workspaceManager: WorkspaceManager | null = null;
  private agentRunner: AgentRunner | null = null;

  private tickTimer: NodeJS.Timeout | null = null;
  private isTickRunning = false;
  private refreshQueued = false;

  private readonly running = new Map<string, RunningEntry>();
  private readonly runningHandles = new Map<string, AgentRunHandle>();
  private readonly claimed = new Set<string>();
  private readonly retries = new Map<string, RetryEntry>();
  private readonly lastThreadByIssue = new Map<string, string>();
  private endedRuntimeSeconds = 0;
  private codexTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private workflowError: ValidationError | null = null;

  constructor(workflowPath: string, cliPort: number | null) {
    this.workflowStore = new WorkflowStore(workflowPath, cliPort);
  }

  async start(): Promise<void> {
    await this.workflowStore.initialize();
    this.applyConfig();
    this.workflowError = this.workflowStore.validateForDispatch();

    if (this.workflowError) {
      throw new Error(`${this.workflowError.code}: ${this.workflowError.message}`);
    }

    await this.startupCleanup();
    void this.runTick("startup");
  }

  stop(): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }

    for (const handle of this.runningHandles.values()) {
      handle.kill();
    }
  }

  currentConfig(): RuntimeConfig {
    return this.workflowStore.current().config;
  }

  requestRefresh(): { queued: boolean; coalesced: boolean; requestedAt: string; operations: string[] } {
    const coalesced = this.isTickRunning || this.refreshQueued;
    this.refreshQueued = true;

    if (!this.isTickRunning) {
      this.scheduleNextTick(0);
    }

    return {
      queued: true,
      coalesced,
      requestedAt: nowIso(),
      operations: ["poll", "reconcile"],
    };
  }

  async snapshot(): Promise<Snapshot> {
    const trackedIssues = await this.buildTrackedIssues();

    return {
      generatedAt: nowIso(),
      counts: {
        running: this.running.size,
        retrying: this.retries.size,
        tracked: trackedIssues.length,
      },
      running: Array.from(this.running.values()).map((entry) => ({
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        state: entry.issue.state,
        session_id: entry.sessionId,
        turn_count: entry.turnCount,
        last_event: entry.lastEvent,
        last_message: entry.lastMessage,
        started_at: entry.startedAt,
        last_event_at: entry.lastEventAt,
        tokens: {
          input_tokens: entry.inputTokens,
          output_tokens: entry.outputTokens,
          total_tokens: entry.totalTokens,
        },
      })),
      retrying: Array.from(this.retries.values()).map((entry) => ({
        issue_id: entry.issueId,
        issue_identifier: entry.identifier,
        attempt: entry.attempt,
        due_at: new Date(entry.dueAtMs).toISOString(),
        error: entry.error,
      })),
      trackedIssues,
      board: {
        columns: BOARD_COLUMNS.map((label) => ({
          label,
          issue_count: trackedIssues.filter((issue) => issue.board_column === label).length,
          issues: trackedIssues.filter((issue) => issue.board_column === label),
        })),
      },
      codexTotals: {
        inputTokens: this.codexTotals.inputTokens,
        outputTokens: this.codexTotals.outputTokens,
        totalTokens: this.codexTotals.totalTokens,
        secondsRunning:
          this.endedRuntimeSeconds +
          Array.from(this.running.values()).reduce((total, entry) => {
            const startedAt = new Date(entry.startedAt).getTime();
            return total + Math.max((Date.now() - startedAt) / 1000, 0);
          }, 0),
      },
      rateLimits: null,
      workflowError: this.workflowError,
    };
  }

  async issueDetails(issueIdentifier: string): Promise<Record<string, unknown> | null> {
    const snapshot = await this.snapshot();
    const running = snapshot.running.find((entry) => entry.issue_identifier === issueIdentifier) ?? null;
    const retry = snapshot.retrying.find((entry) => entry.issue_identifier === issueIdentifier) ?? null;
    const tracked = snapshot.trackedIssues.find((entry) => entry.issue_identifier === issueIdentifier) ?? null;

    if (!running && !retry && !tracked) {
      return null;
    }

    return {
      issue_identifier: issueIdentifier,
      issue_id: (running as Record<string, unknown> | null)?.issue_id ?? (tracked as Record<string, unknown> | null)?.issue_id ?? null,
      status:
        running !== null ? "running" : retry !== null ? "retrying" : (tracked as Record<string, unknown>)?.state ?? "tracked",
      workspace: {
        path: path.join(this.currentConfig().workspace.root, issueIdentifier.replace(/[^A-Za-z0-9._-]/g, "_")),
      },
      attempts: {
        restart_count: retry ? Math.max(((retry as Record<string, unknown>).attempt as number) - 1, 0) : 0,
        current_retry_attempt: retry ? ((retry as Record<string, unknown>).attempt as number) : 0,
      },
      running,
      retry,
      logs: { codex_session_logs: [] },
      recent_events:
        running && (running as Record<string, unknown>).last_event_at
          ? [
              {
                at: (running as Record<string, unknown>).last_event_at,
                event: (running as Record<string, unknown>).last_event,
                message: (running as Record<string, unknown>).last_message,
              },
            ]
          : [],
      last_error: retry ? (retry as Record<string, unknown>).error : null,
      tracked: tracked ?? {},
    };
  }

  async moveIssue(
    issueIdentifier: string,
    column: BoardColumnId,
    targetIndex: number | null,
  ): Promise<Snapshot> {
    if (!BOARD_COLUMNS.includes(column)) {
      throw new Error("invalid_board_column");
    }

    const tracker = this.requireTracker();
    const issue = (await tracker.listIssues()).find((entry) => entry.identifier === issueIdentifier);

    if (!issue) {
      throw new Error("issue_not_found");
    }

    const nextState = resolveStateForBoardColumn(column, this.currentConfig(), issue.state);
    const updatedIssue = await tracker.moveIssue(issueIdentifier, nextState, targetIndex);

    this.claimed.delete(updatedIssue.id);
    this.retries.delete(updatedIssue.id);

    if (isTerminalState(updatedIssue, this.currentConfig())) {
      this.cancelRun(updatedIssue.id, "moved_to_terminal", true);
    } else if (!isActiveState(updatedIssue, this.currentConfig())) {
      this.cancelRun(updatedIssue.id, "moved_to_inactive", false);
    }

    this.requestRefresh();
    return this.snapshot();
  }

  private applyConfig(): void {
    const config = this.currentConfig();

    if (config.tracker.kind !== "file" || !config.tracker.path) {
      throw new Error("unsupported_tracker_kind: only tracker.kind=file is implemented in the TypeScript adaptation");
    }

    this.tracker = new FileTracker(config.tracker.path, config.tracker.activeStates, config);
    this.workspaceManager = new WorkspaceManager(config);
    this.agentRunner = new AgentRunner(config);
  }

  private scheduleNextTick(delayMs: number): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
    }

    this.tickTimer = setTimeout(() => {
      void this.runTick("scheduled");
    }, delayMs);
  }

  private async runTick(trigger: "startup" | "scheduled" | "manual"): Promise<void> {
    if (this.isTickRunning) {
      this.refreshQueued = true;
      return;
    }

    this.isTickRunning = true;

    try {
      try {
        await this.workflowStore.reloadIfChanged();
        this.applyConfig();
      } catch (error) {
        if (!this.workflowError) {
          this.workflowError = {
            code: "workflow_reload_failed",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }

      this.workflowError = this.workflowStore.validateForDispatch();
      await this.reconcile();

      if (!this.workflowError) {
        await this.processDueRetries();
        await this.dispatchCandidates();
      }
    } finally {
      this.isTickRunning = false;
      const config = this.currentConfig();
      const nextDelay = this.refreshQueued ? 0 : config.polling.intervalMs;
      this.refreshQueued = false;
      this.scheduleNextTick(nextDelay);
    }
  }

  private async startupCleanup(): Promise<void> {
    const tracker = this.requireTracker();
    const workspaceManager = this.requireWorkspaceManager();
    const terminalIssues = await tracker.fetchIssuesByStates(this.currentConfig().tracker.terminalStates);

    for (const issue of terminalIssues) {
      await workspaceManager.removeWorkspace(issue).catch((error) => {
        console.warn(`startup_cleanup_failed issue_id=${issue.id} issue_identifier=${issue.identifier} error=${String(error)}`);
      });
    }
  }

  private async reconcile(): Promise<void> {
    const config = this.currentConfig();
    const tracker = this.requireTracker();
    const runningIssues = Array.from(this.running.values());

    if (config.codex.stallTimeoutMs > 0) {
      for (const entry of runningIssues) {
        const referenceTime = entry.lastEventAt ?? entry.startedAt;
        const elapsedMs = Date.now() - new Date(referenceTime).getTime();

        if (elapsedMs > config.codex.stallTimeoutMs) {
          this.cancelRun(entry.issue.id, "stalled");
        }
      }
    }

    if (this.running.size === 0) {
      return;
    }

    const refreshed = await tracker.fetchIssueStatesByIds(Array.from(this.running.keys()));
    const refreshedById = new Map(refreshed.map((issue) => [issue.id, issue]));

    for (const entry of Array.from(this.running.values())) {
      const updatedIssue = refreshedById.get(entry.issue.id);

      if (!updatedIssue) {
        this.cancelRun(entry.issue.id, "missing_in_tracker", false);
        continue;
      }

      entry.issue = updatedIssue;

      if (isTerminalState(updatedIssue, config)) {
        this.cancelRun(entry.issue.id, "terminal_state", true);
        continue;
      }

      if (!isActiveState(updatedIssue, config)) {
        this.cancelRun(entry.issue.id, "inactive_state", false);
      }
    }
  }

  private cancelRun(issueId: string, reason: string, cleanupWorkspace = false): void {
    const handle = this.runningHandles.get(issueId);
    const entry = this.running.get(issueId);

    if (!handle || !entry) {
      return;
    }

    entry.finishReason = "cancelled";
    entry.finishError = reason;
    handle.kill();

    if (cleanupWorkspace) {
      void this.requireWorkspaceManager().removeWorkspace(entry.issue).catch(() => undefined);
    }
  }

  private async processDueRetries(): Promise<void> {
    const now = Date.now();
    const dueEntries = Array.from(this.retries.values()).filter((entry) => entry.dueAtMs <= now);

    if (dueEntries.length === 0) {
      return;
    }

    const tracker = this.requireTracker();
    const candidates = await tracker.fetchCandidateIssues();
    const candidateById = new Map(candidates.map((issue) => [issue.id, issue]));

    for (const retryEntry of dueEntries) {
      const issue = candidateById.get(retryEntry.issueId);

      if (!issue) {
        this.retries.delete(retryEntry.issueId);
        this.claimed.delete(retryEntry.issueId);
        continue;
      }

      if (!this.hasDispatchCapacity(issue)) {
        this.retries.set(retryEntry.issueId, {
          ...retryEntry,
          dueAtMs: Date.now() + 5_000,
          error: "no available orchestrator slots",
        });
        continue;
      }

      this.retries.delete(retryEntry.issueId);
      await this.dispatchIssue(issue, retryEntry.attempt, retryEntry.resumeThreadId);
    }
  }

  private async dispatchCandidates(): Promise<void> {
    const tracker = this.requireTracker();
    const issues = sortIssues(await tracker.fetchCandidateIssues());

    for (const issue of issues) {
      if (!this.isDispatchEligible(issue)) {
        continue;
      }

      await this.dispatchIssue(issue, null, null);
    }
  }

  private isDispatchEligible(issue: Issue): boolean {
    const config = this.currentConfig();

    if (this.claimed.has(issue.id) || this.running.has(issue.id)) {
      return false;
    }

    if (!isActiveState(issue, config) || isTerminalState(issue, config)) {
      return false;
    }

    if (todoLikeState(issue.state)) {
      const hasActiveBlocker = issue.blockedBy.some((blocker) => {
        const blockerState = blocker.state ? blocker.state : "";
        return !config.tracker.terminalStates.map(normalizeState).includes(normalizeState(blockerState));
      });

      if (hasActiveBlocker) {
        return false;
      }
    }

    return this.hasDispatchCapacity(issue);
  }

  private hasDispatchCapacity(issue: Issue): boolean {
    const config = this.currentConfig();

    if (this.running.size >= config.agent.maxConcurrentAgents) {
      return false;
    }

    const normalizedState = normalizeState(issue.state);
    const perStateLimit =
      config.agent.maxConcurrentAgentsByState[normalizedState] ?? config.agent.maxConcurrentAgents;
    const currentStateCount = Array.from(this.running.values()).filter(
      (entry) => normalizeState(entry.issue.state) === normalizedState,
    ).length;

    return currentStateCount < perStateLimit;
  }

  private async dispatchIssue(issue: Issue, attempt: number | null, resumeThreadId: string | null): Promise<void> {
    const workspaceManager = this.requireWorkspaceManager();
    const agentRunner = this.requireAgentRunner();
    const tracker = this.requireTracker();
    const { definition } = this.workflowStore.current();
    let trackedIssue = issue;

    if (trackerBoardColumn(issue.state, this.currentConfig()) === "Todo") {
      const targetState = resolveStateForBoardColumn("In Progress", this.currentConfig(), issue.state);
      trackedIssue = await tracker.moveIssue(issue.identifier, targetState, 0);
    }

    const prompt = renderPrompt(definition, issueToTemplateContext(trackedIssue), attempt);

    this.claimed.add(trackedIssue.id);
    const { workspacePath } = await workspaceManager.prepareWorkspace(trackedIssue);
    await workspaceManager.beforeRun(trackedIssue, workspacePath);

    const startedAt = nowIso();
    const entry: RunningEntry = {
      issue: trackedIssue,
      workspacePath,
      startedAt,
      threadId: resumeThreadId,
      sessionId: resumeThreadId,
      turnCount: 0,
      lastEvent: null,
      lastMessage: null,
      lastEventAt: startedAt,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      attempt,
      processId: null,
      finishReason: null,
      finishError: null,
    };

    this.running.set(trackedIssue.id, entry);

    const handle = agentRunner.start(prompt, workspacePath, attempt, resumeThreadId, (update) => {
      const current = this.running.get(trackedIssue.id);

      if (!current) {
        return;
      }

      current.threadId = update.threadId ?? current.threadId;
      current.sessionId = update.sessionId ?? current.sessionId;
      current.turnCount = update.turnCount ?? current.turnCount;
      current.lastEvent = update.type;
      current.lastEventAt = update.timestamp;

      if (update.message !== undefined) {
        current.lastMessage = update.message;
      }

      if (update.usage) {
        current.inputTokens = update.usage.inputTokens;
        current.outputTokens = update.usage.outputTokens;
        current.totalTokens = update.usage.totalTokens;
      }
    });

    this.runningHandles.set(trackedIssue.id, handle);

    void handle.promise.then(async (result) => {
      this.runningHandles.delete(trackedIssue.id);
      this.running.delete(trackedIssue.id);

      const runtimeSeconds = Math.max((Date.now() - new Date(startedAt).getTime()) / 1000, 0);
      this.endedRuntimeSeconds += runtimeSeconds;
      this.codexTotals.inputTokens += result.usage.inputTokens;
      this.codexTotals.outputTokens += result.usage.outputTokens;
      this.codexTotals.totalTokens += result.usage.totalTokens;

      await workspaceManager.afterRun(trackedIssue, workspacePath);

      if (result.threadId) {
        this.lastThreadByIssue.set(trackedIssue.id, result.threadId);
      }

      if (result.status === "success") {
        this.retries.set(trackedIssue.id, {
          issueId: trackedIssue.id,
          identifier: trackedIssue.identifier,
          attempt: 1,
          dueAtMs: Date.now() + 1_000,
          error: "continuation_check",
          kind: "continuation",
          resumeThreadId: result.threadId,
        });
        return;
      }

      if (entry.finishReason === "cancelled") {
        this.claimed.delete(trackedIssue.id);
        this.retries.delete(trackedIssue.id);
        return;
      }

      const previousAttempt = attempt ?? 0;
      const retryAttempt = previousAttempt + 1;
      const backoffMs = Math.min(10_000 * 2 ** Math.max(retryAttempt - 1, 0), this.currentConfig().agent.maxRetryBackoffMs);

      this.retries.set(trackedIssue.id, {
        issueId: trackedIssue.id,
        identifier: trackedIssue.identifier,
        attempt: retryAttempt,
        dueAtMs: Date.now() + backoffMs,
        error: result.error,
        kind: "retry",
        resumeThreadId: this.lastThreadByIssue.get(trackedIssue.id) ?? null,
      });
    });
  }

  private async buildTrackedIssues(): Promise<Array<Record<string, unknown>>> {
    const issues = await this.requireTracker().listIssues();
    const retryById = new Map(this.retries.entries());

    return sortIssues(issues).map((issue) => {
      const running = this.running.get(issue.id);
      const retry = retryById.get(issue.id);
      const boardColumn = trackerBoardColumn(issue.state, this.currentConfig());

      return {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        state: issue.state,
        tracker_state: issue.state,
        position: issue.position,
        board_column: boardColumn,
        labels: issue.labels,
        blocked_by: issue.blockedBy,
        updated_at: issue.updatedAt,
        created_at: issue.createdAt,
        started_at: running?.startedAt ?? null,
        last_message: running?.lastMessage ?? null,
        last_event: running?.lastEvent ?? null,
        last_event_at: running?.lastEventAt ?? null,
        last_activity_at: running?.lastEventAt ?? issue.updatedAt ?? issue.createdAt,
        retry_attempt: retry?.attempt ?? null,
        due_at: retry ? new Date(retry.dueAtMs).toISOString() : null,
        runtime_status: retry ? "retrying" : running ? "running" : "tracked",
      };
    });
  }

  private requireTracker(): TrackerAdapter {
    if (!this.tracker) {
      throw new Error("tracker_not_initialized");
    }

    return this.tracker;
  }

  private requireWorkspaceManager(): WorkspaceManager {
    if (!this.workspaceManager) {
      throw new Error("workspace_manager_not_initialized");
    }

    return this.workspaceManager;
  }

  private requireAgentRunner(): AgentRunner {
    if (!this.agentRunner) {
      throw new Error("agent_runner_not_initialized");
    }

    return this.agentRunner;
  }
}
