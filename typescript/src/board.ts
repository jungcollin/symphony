import type { BoardColumnId, Issue, RuntimeConfig } from "./types.ts";

export const BOARD_COLUMNS: BoardColumnId[] = ["Todo", "In Progress", "Done"];

export function normalizeState(state: string | null | undefined): string {
  return (state || "").trim().toLowerCase();
}

export function todoLikeState(state: string): boolean {
  return ["todo", "backlog", "queued", "pending", "open", "ready", "triage"].includes(normalizeState(state));
}

export function isTerminalStateValue(state: string, config: RuntimeConfig): boolean {
  return config.tracker.terminalStates.map(normalizeState).includes(normalizeState(state));
}

export function trackerBoardColumn(state: string, config: RuntimeConfig): BoardColumnId {
  if (isTerminalStateValue(state, config)) {
    return "Done";
  }

  return todoLikeState(state) ? "Todo" : "In Progress";
}

export function resolveStateForBoardColumn(
  column: BoardColumnId,
  config: RuntimeConfig,
  currentState?: string | null,
): string {
  const current = currentState?.trim();

  if (column === "Todo") {
    if (current && todoLikeState(current)) {
      return current;
    }

    return (
      config.tracker.activeStates.find((state) => todoLikeState(state)) ??
      current ??
      "Todo"
    );
  }

  if (column === "In Progress") {
    if (current && !todoLikeState(current) && !isTerminalStateValue(current, config)) {
      return current;
    }

    return (
      config.tracker.activeStates.find(
        (state) => !todoLikeState(state) && !isTerminalStateValue(state, config),
      ) ??
      current ??
      "In Progress"
    );
  }

  return (
    config.tracker.terminalStates.find((state) => normalizeState(state) === "done") ??
    config.tracker.terminalStates[0] ??
    current ??
    "Done"
  );
}

export function compareIssues(left: Issue, right: Issue): number {
  const leftPosition = left.position ?? Number.MAX_SAFE_INTEGER;
  const rightPosition = right.position ?? Number.MAX_SAFE_INTEGER;

  if (leftPosition !== rightPosition) {
    return leftPosition - rightPosition;
  }

  const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
  const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;

  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  const leftCreated = left.createdAt ?? "9999-12-31T23:59:59.999Z";
  const rightCreated = right.createdAt ?? "9999-12-31T23:59:59.999Z";

  if (leftCreated !== rightCreated) {
    return leftCreated.localeCompare(rightCreated);
  }

  return left.identifier.localeCompare(right.identifier);
}

export function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort(compareIssues);
}
