import fs from "node:fs/promises";
import path from "node:path";

import { compareIssues, normalizeState, trackerBoardColumn } from "./board.ts";
import type { Issue, RuntimeConfig } from "./types.ts";

function normalizeString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return null;
}

function normalizeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }

  return null;
}

function normalizeIssue(raw: Record<string, unknown>): Issue | null {
  const id = normalizeString(raw.id);
  const identifier = normalizeString(raw.identifier);
  const title = normalizeString(raw.title);
  const state = normalizeString(raw.state);

  if (!id || !identifier || !title || !state) {
    return null;
  }

  const labels = Array.isArray(raw.labels)
    ? raw.labels
        .map((entry) => normalizeString(entry))
        .filter((entry): entry is string => Boolean(entry))
        .map((entry) => entry.toLowerCase())
    : [];

  const blockedBy = Array.isArray(raw.blocked_by)
    ? raw.blocked_by
        .map((entry) =>
          entry && typeof entry === "object"
            ? {
                id: normalizeString((entry as Record<string, unknown>).id),
                identifier: normalizeString((entry as Record<string, unknown>).identifier),
                state: normalizeString((entry as Record<string, unknown>).state),
              }
            : null,
        )
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : [];

  return {
    id,
    identifier,
    title,
    description: normalizeString(raw.description),
    priority: normalizeInteger(raw.priority),
    position: normalizeInteger(raw.position),
    state,
    branchName: normalizeString(raw.branch_name),
    url: normalizeString(raw.url),
    labels,
    blockedBy,
    createdAt: normalizeString(raw.created_at),
    updatedAt: normalizeString(raw.updated_at),
  };
}

interface StoredIssueRow {
  raw: Record<string, unknown>;
  issue: Issue;
  rowIndex: number;
}

interface IssueDocument {
  rootKind: "array" | "object";
  rootObject: Record<string, unknown> | null;
  rows: unknown[];
  issues: StoredIssueRow[];
}

function sortStoredIssueRows(entries: StoredIssueRow[]): StoredIssueRow[] {
  return [...entries].sort((left, right) => compareIssues(left.issue, right.issue));
}

export interface TrackerAdapter {
  listIssues(): Promise<Issue[]>;
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(states: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
  moveIssue(issueIdentifier: string, targetState: string, targetIndex: number | null): Promise<Issue>;
}

export class FileTracker implements TrackerAdapter {
  private readonly issueFilePath: string;
  private readonly activeStates: string[];
  private readonly config: RuntimeConfig;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(issueFilePath: string, activeStates: string[], config: RuntimeConfig) {
    this.issueFilePath = issueFilePath;
    this.activeStates = activeStates;
    this.config = config;
  }

  async listIssues(): Promise<Issue[]> {
    const document = await this.readDocument();
    return document.issues.map((entry) => entry.issue);
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    const issues = await this.listIssues();
    const activeStates = new Set(this.activeStates.map((state) => normalizeState(state)));
    return issues.filter((issue) => activeStates.has(normalizeState(issue.state)));
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const issues = await this.listIssues();
    const wantedStates = new Set(states.map((state) => normalizeState(state)));
    return issues.filter((issue) => wantedStates.has(normalizeState(issue.state)));
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    const issues = await this.listIssues();
    const wantedIds = new Set(issueIds);
    return issues.filter((issue) => wantedIds.has(issue.id));
  }

  async moveIssue(issueIdentifier: string, targetState: string, targetIndex: number | null): Promise<Issue> {
    return this.enqueueWrite(async () => {
      const document = await this.readDocument();
      const currentEntry = document.issues.find((entry) => entry.issue.identifier === issueIdentifier);

      if (!currentEntry) {
        throw new Error("issue_not_found");
      }

      const currentColumn = trackerBoardColumn(currentEntry.issue.state, this.config);
      const timestamp = new Date().toISOString();
      const updatedRaw: Record<string, unknown> = {
        ...currentEntry.raw,
        state: targetState,
        updated_at: timestamp,
      };
      const updatedIssue = normalizeIssue(updatedRaw);

      if (!updatedIssue) {
        throw new Error("issue_update_invalid");
      }

      const targetColumn = trackerBoardColumn(updatedIssue.state, this.config);
      const updatedEntries = document.issues.map((entry) =>
        entry.issue.id === currentEntry.issue.id ? { ...entry, raw: updatedRaw, issue: updatedIssue } : entry,
      );
      const targetEntries = sortStoredIssueRows(
        updatedEntries.filter(
          (entry) =>
            entry.issue.id !== updatedIssue.id && trackerBoardColumn(entry.issue.state, this.config) === targetColumn,
        ),
      );
      const currentColumnEntries = sortStoredIssueRows(
        updatedEntries.filter((entry) => trackerBoardColumn(entry.issue.state, this.config) === currentColumn),
      );
      const currentIndex = currentColumnEntries.findIndex((entry) => entry.issue.id === updatedIssue.id);
      const fallbackIndex =
        currentColumn === targetColumn
          ? Math.max(currentIndex, 0)
          : targetColumn === "In Progress"
            ? 0
            : targetEntries.length;
      const insertionIndex = Math.max(0, Math.min(targetIndex ?? fallbackIndex, targetEntries.length));
      const reorderedTargetEntries = [...targetEntries];
      reorderedTargetEntries.splice(insertionIndex, 0, updatedEntries.find((entry) => entry.issue.id === updatedIssue.id)!);

      const positionsByIssueId = new Map<string, number>();
      this.assignPositions(reorderedTargetEntries, positionsByIssueId);

      if (currentColumn !== targetColumn) {
        const sourceEntries = sortStoredIssueRows(
          updatedEntries.filter(
            (entry) =>
              entry.issue.id !== updatedIssue.id && trackerBoardColumn(entry.issue.state, this.config) === currentColumn,
          ),
        );
        this.assignPositions(sourceEntries, positionsByIssueId);
      }

      const nextRows = [...document.rows];

      for (const entry of updatedEntries) {
        const nextPosition = positionsByIssueId.get(entry.issue.id);
        const baseRaw =
          entry.issue.id === updatedIssue.id ? updatedRaw : nextRows[entry.rowIndex] && typeof nextRows[entry.rowIndex] === "object"
            ? (nextRows[entry.rowIndex] as Record<string, unknown>)
            : entry.raw;

        if (!baseRaw || typeof baseRaw !== "object") {
          continue;
        }

        if (entry.issue.id === updatedIssue.id || nextPosition !== undefined) {
          nextRows[entry.rowIndex] = {
            ...baseRaw,
            ...(entry.issue.id === updatedIssue.id ? { state: targetState, updated_at: timestamp } : {}),
            ...(nextPosition !== undefined ? { position: nextPosition } : {}),
          };
        }
      }

      await this.writeDocument(document, nextRows);

      return {
        ...updatedIssue,
        position: positionsByIssueId.get(updatedIssue.id) ?? updatedIssue.position,
      };
    });
  }

  private assignPositions(entries: StoredIssueRow[], positionsByIssueId: Map<string, number>): void {
    entries.forEach((entry, index) => {
      positionsByIssueId.set(entry.issue.id, (index + 1) * 1_000);
    });
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.writeQueue;
    this.writeQueue = previous.then(() => gate, () => gate);
    await previous;

    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private async readDocument(): Promise<IssueDocument> {
    const source = await fs.readFile(this.issueFilePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return '{"issues": []}';
      }

      throw error;
    });
    const parsed = JSON.parse(source) as unknown;
    const rootKind = Array.isArray(parsed) ? "array" : "object";
    const rootObject =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    const rows = Array.isArray(parsed)
      ? parsed
      : rootObject && Array.isArray(rootObject.issues)
        ? (rootObject.issues as unknown[])
        : [];
    const issues = rows
      .map((row, rowIndex) =>
        row && typeof row === "object"
          ? {
              raw: row as Record<string, unknown>,
              issue: normalizeIssue(row as Record<string, unknown>),
              rowIndex,
            }
          : null,
      )
      .filter((entry): entry is { raw: Record<string, unknown>; issue: Issue | null; rowIndex: number } => Boolean(entry))
      .filter((entry): entry is StoredIssueRow => Boolean(entry.issue))
      .map((entry) => ({ ...entry, issue: entry.issue as Issue }));

    return { rootKind, rootObject, rows, issues };
  }

  private async writeDocument(document: IssueDocument, rows: unknown[]): Promise<void> {
    const payload =
      document.rootKind === "array"
        ? rows
        : {
            ...(document.rootObject ?? {}),
            issues: rows,
          };
    const content = `${JSON.stringify(payload, null, 2)}\n`;
    const directory = path.dirname(this.issueFilePath);
    const tempPath = path.join(directory, `.issues.${process.pid}.${Date.now()}.tmp`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(tempPath, content, "utf8");
    await fs.rename(tempPath, this.issueFilePath);
  }
}
