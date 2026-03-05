import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RuntimeConfig, ValidationError, WorkflowDefinition } from "./types.ts";

const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];

type ParsedValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

function trimTrailingWhitespace(text: string): string {
  return text.replace(/[ \t]+$/gm, "");
}

function splitFrontMatter(source: string): { frontMatter: string | null; body: string } {
  const normalized = source.replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---\n")) {
    return { frontMatter: null, body: normalized.trim() };
  }

  const closingIndex = normalized.indexOf("\n---\n", 4);

  if (closingIndex === -1) {
    throw new Error("workflow_parse_error: missing closing front matter delimiter");
  }

  return {
    frontMatter: normalized.slice(4, closingIndex),
    body: normalized.slice(closingIndex + 5).trim(),
  };
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function parseScalar(rawValue: string): ParsedValue {
  const value = rawValue.trim();

  if (value === "null" || value === "~") {
    return null;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  if (value.includes(",") && !value.includes(":")) {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return value;
}

function collectBlockScalar(lines: string[], index: number, indent: number): [string, number] {
  const parts: string[] = [];
  let cursor = index;

  while (cursor < lines.length) {
    const line = lines[cursor];

    if (line.trim() === "") {
      parts.push("");
      cursor += 1;
      continue;
    }

    const currentIndent = line.match(/^ */)?.[0].length ?? 0;

    if (currentIndent < indent) {
      break;
    }

    parts.push(line.slice(indent));
    cursor += 1;
  }

  return [trimTrailingWhitespace(parts.join("\n")).trimEnd(), cursor];
}

function skipEmptyLines(lines: string[], index: number): number {
  let cursor = index;

  while (cursor < lines.length && isBlankOrComment(lines[cursor])) {
    cursor += 1;
  }

  return cursor;
}

function parseYamlBlock(lines: string[], index: number, indent: number): [ParsedValue, number] {
  const start = skipEmptyLines(lines, index);

  if (start >= lines.length) {
    return [{}, start];
  }

  const currentIndent = lines[start].match(/^ */)?.[0].length ?? 0;

  if (currentIndent < indent) {
    return [{}, start];
  }

  if (lines[start].slice(currentIndent).startsWith("- ")) {
    return parseYamlArray(lines, start, indent);
  }

  return parseYamlObject(lines, start, indent);
}

function parseYamlArray(lines: string[], index: number, indent: number): [ParsedValue[], number] {
  const values: ParsedValue[] = [];
  let cursor = index;

  while (cursor < lines.length) {
    cursor = skipEmptyLines(lines, cursor);

    if (cursor >= lines.length) {
      break;
    }

    const line = lines[cursor];
    const lineIndent = line.match(/^ */)?.[0].length ?? 0;

    if (lineIndent < indent) {
      break;
    }

    if (lineIndent !== indent || !line.slice(indent).startsWith("- ")) {
      break;
    }

    const remainder = line.slice(indent + 2).trim();

    if (remainder === "") {
      const [nestedValue, nextCursor] = parseYamlBlock(lines, cursor + 1, indent + 2);
      values.push(nestedValue);
      cursor = nextCursor;
      continue;
    }

    values.push(parseScalar(remainder));
    cursor += 1;
  }

  return [values, cursor];
}

function parseYamlObject(lines: string[], index: number, indent: number): [Record<string, ParsedValue>, number] {
  const values: Record<string, ParsedValue> = {};
  let cursor = index;

  while (cursor < lines.length) {
    cursor = skipEmptyLines(lines, cursor);

    if (cursor >= lines.length) {
      break;
    }

    const line = lines[cursor];
    const lineIndent = line.match(/^ */)?.[0].length ?? 0;

    if (lineIndent < indent) {
      break;
    }

    if (lineIndent !== indent) {
      throw new Error(`workflow_parse_error: invalid indentation near "${line.trim()}"`);
    }

    const trimmed = line.slice(indent);
    const separatorIndex = trimmed.indexOf(":");

    if (separatorIndex === -1) {
      throw new Error(`workflow_parse_error: invalid mapping entry "${trimmed}"`);
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();

    if (rawValue === "|") {
      const [blockValue, nextCursor] = collectBlockScalar(lines, cursor + 1, indent + 2);
      values[key] = blockValue;
      cursor = nextCursor;
      continue;
    }

    if (rawValue !== "") {
      values[key] = parseScalar(rawValue);
      cursor += 1;
      continue;
    }

    const [nestedValue, nextCursor] = parseYamlBlock(lines, cursor + 1, indent + 2);
    values[key] = nestedValue;
    cursor = nextCursor;
  }

  return [values, cursor];
}

function parseYamlDocument(source: string): Record<string, unknown> {
  const lines = trimTrailingWhitespace(source).split("\n");
  const [parsedValue] = parseYamlBlock(lines, 0, 0);

  if (Array.isArray(parsedValue) || parsedValue === null || typeof parsedValue !== "object") {
    throw new Error("workflow_front_matter_not_a_map");
  }

  return parsedValue as Record<string, unknown>;
}

function getObject(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return null;
}

function asInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }

  return fallback;
}

function asStringList(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => asString(entry))
      .filter((entry): entry is string => Boolean(entry));
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return fallback;
}

function asStateConcurrencyMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, number> = {};

  for (const [key, raw] of Object.entries(value)) {
    const parsed = asInteger(raw, 0);

    if (parsed > 0) {
      result[key.trim().toLowerCase()] = parsed;
    }
  }

  return result;
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

function resolvePathLike(rawValue: unknown, baseDir: string, fallback: string): string {
  const stringValue = asString(rawValue) ?? fallback;
  const withEnv =
    stringValue.startsWith("$") && stringValue.length > 1
      ? process.env[stringValue.slice(1)] || fallback
      : stringValue;
  const expanded = expandHome(withEnv);

  if (path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }

  return path.resolve(baseDir, expanded);
}

function buildRuntimeConfig(definition: WorkflowDefinition, cliPort: number | null): RuntimeConfig {
  const baseDir = path.dirname(definition.path);
  const tracker = getObject(definition.config, "tracker");
  const polling = getObject(definition.config, "polling");
  const workspace = getObject(definition.config, "workspace");
  const hooks = getObject(definition.config, "hooks");
  const agent = getObject(definition.config, "agent");
  const codex = getObject(definition.config, "codex");
  const server = getObject(definition.config, "server");

  return {
    workflowPath: definition.path,
    tracker: {
      kind: asString(tracker.kind) ?? "",
      path: asString(tracker.path) ? resolvePathLike(tracker.path, baseDir, ".") : null,
      activeStates: asStringList(tracker.active_states, DEFAULT_ACTIVE_STATES),
      terminalStates: asStringList(tracker.terminal_states, DEFAULT_TERMINAL_STATES),
    },
    polling: {
      intervalMs: Math.max(asInteger(polling.interval_ms, 30_000), 1_000),
    },
    workspace: {
      root: resolvePathLike(
        workspace.root,
        baseDir,
        path.join(os.tmpdir(), "symphony_workspaces"),
      ),
    },
    hooks: {
      afterCreate: asString(hooks.after_create),
      beforeRun: asString(hooks.before_run),
      afterRun: asString(hooks.after_run),
      beforeRemove: asString(hooks.before_remove),
      timeoutMs: Math.max(asInteger(hooks.timeout_ms, 60_000), 1_000),
    },
    agent: {
      maxConcurrentAgents: Math.max(asInteger(agent.max_concurrent_agents, 10), 1),
      maxTurns: Math.max(asInteger(agent.max_turns, 20), 1),
      maxRetryBackoffMs: Math.max(asInteger(agent.max_retry_backoff_ms, 300_000), 10_000),
      maxConcurrentAgentsByState: asStateConcurrencyMap(agent.max_concurrent_agents_by_state),
    },
    codex: {
      command: asString(codex.command) ?? "codex -a never --sandbox workspace-write",
      turnTimeoutMs: Math.max(asInteger(codex.turn_timeout_ms, 3_600_000), 10_000),
      readTimeoutMs: Math.max(asInteger(codex.read_timeout_ms, 5_000), 1_000),
      stallTimeoutMs: asInteger(codex.stall_timeout_ms, 300_000),
    },
    server: {
      port: cliPort ?? (server.port === 0 ? 0 : asInteger(server.port, 0) || null),
      host: asString(server.host) ?? "127.0.0.1",
    },
  };
}

export class WorkflowStore {
  private readonly workflowPath: string;
  private readonly cliPort: number | null;
  private currentDefinition: WorkflowDefinition | null = null;
  private currentConfig: RuntimeConfig | null = null;
  private lastMtimeMs = 0;
  private lastError: ValidationError | null = null;

  constructor(workflowPath: string, cliPort: number | null) {
    this.workflowPath = workflowPath;
    this.cliPort = cliPort;
  }

  async initialize(): Promise<void> {
    await this.reloadIfChanged(true);
  }

  async reloadIfChanged(force = false): Promise<boolean> {
    const stat = await fs.stat(this.workflowPath).catch(() => {
      throw new Error("missing_workflow_file");
    });

    if (!force && stat.mtimeMs === this.lastMtimeMs) {
      return false;
    }

    const source = await fs.readFile(this.workflowPath, "utf8");
    const { frontMatter, body } = splitFrontMatter(source);
    const config = frontMatter ? parseYamlDocument(frontMatter) : {};
    const definition: WorkflowDefinition = {
      path: this.workflowPath,
      config,
      promptTemplate: body || "You are working on an issue from Symphony.",
    };
    const runtimeConfig = buildRuntimeConfig(definition, this.cliPort);

    this.currentDefinition = definition;
    this.currentConfig = runtimeConfig;
    this.lastMtimeMs = stat.mtimeMs;
    this.lastError = null;

    return true;
  }

  current(): { definition: WorkflowDefinition; config: RuntimeConfig } {
    if (!this.currentDefinition || !this.currentConfig) {
      throw new Error("missing_workflow_file");
    }

    return { definition: this.currentDefinition, config: this.currentConfig };
  }

  validationError(): ValidationError | null {
    return this.lastError;
  }

  validateForDispatch(): ValidationError | null {
    const { config } = this.current();

    if (!config.tracker.kind) {
      return { code: "missing_tracker_kind", message: "tracker.kind is required" };
    }

    if (config.tracker.kind === "file" && !config.tracker.path) {
      return { code: "missing_tracker_path", message: "tracker.path is required for file tracker" };
    }

    if (!config.codex.command.trim()) {
      return { code: "missing_codex_command", message: "codex.command is required" };
    }

    return null;
  }
}

function readPath(context: Record<string, unknown>, expression: string): unknown {
  const parts = expression.split(".").map((entry) => entry.trim()).filter(Boolean);
  let cursor: unknown = context;

  for (const part of parts) {
    if (!cursor || typeof cursor !== "object" || !(part in (cursor as Record<string, unknown>))) {
      throw new Error(`template_render_error: unknown variable "${expression}"`);
    }

    cursor = (cursor as Record<string, unknown>)[part];
  }

  return cursor;
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function findMatchingTag(
  template: string,
  offset: number,
  openTag: string,
  closeTag: string,
): { start: number; end: number; elseStart: number | null } {
  let depth = 1;
  let cursor = offset;
  let elseStart: number | null = null;

  while (cursor < template.length) {
    const nextDirectiveStart = template.indexOf("{%", cursor);

    if (nextDirectiveStart === -1) {
      break;
    }

    const nextDirectiveEnd = template.indexOf("%}", nextDirectiveStart);

    if (nextDirectiveEnd === -1) {
      break;
    }

    const directive = template.slice(nextDirectiveStart + 2, nextDirectiveEnd).trim();

    if (directive.startsWith(openTag)) {
      depth += 1;
    } else if (directive === closeTag) {
      depth -= 1;

      if (depth === 0) {
        return { start: offset, end: nextDirectiveStart, elseStart };
      }
    } else if (directive === "else" && depth === 1) {
      elseStart = nextDirectiveStart;
    }

    cursor = nextDirectiveEnd + 2;
  }

  throw new Error(`template_parse_error: missing ${closeTag}`);
}

function renderTemplateSegment(template: string, context: Record<string, unknown>): string {
  let cursor = 0;
  let output = "";

  while (cursor < template.length) {
    const variableStart = template.indexOf("{{", cursor);
    const directiveStart = template.indexOf("{%", cursor);
    const nextStartCandidates = [variableStart, directiveStart].filter((index) => index >= 0);
    const nextStart =
      nextStartCandidates.length === 0 ? -1 : Math.min(...nextStartCandidates);

    if (nextStart === -1) {
      output += template.slice(cursor);
      break;
    }

    output += template.slice(cursor, nextStart);

    if (nextStart === variableStart) {
      const variableEnd = template.indexOf("}}", variableStart);

      if (variableEnd === -1) {
        throw new Error("template_parse_error: unclosed variable tag");
      }

      const expression = template.slice(variableStart + 2, variableEnd).trim();

      if (expression.includes("|")) {
        throw new Error(`template_render_error: unsupported filter in "${expression}"`);
      }

      output += renderValue(readPath(context, expression));
      cursor = variableEnd + 2;
      continue;
    }

    const directiveEnd = template.indexOf("%}", directiveStart);

    if (directiveEnd === -1) {
      throw new Error("template_parse_error: unclosed directive tag");
    }

    const directive = template.slice(directiveStart + 2, directiveEnd).trim();

    if (directive.startsWith("if ")) {
      const expression = directive.slice(3).trim();
      const bodyStart = directiveEnd + 2;
      const { end, elseStart } = findMatchingTag(template, bodyStart, "if ", "endif");
      const branchBody =
        Boolean(readPath(context, expression))
          ? template.slice(bodyStart, elseStart ?? end)
          : elseStart === null
            ? ""
            : template.slice(template.indexOf("%}", elseStart) + 2, end);

      output += renderTemplateSegment(branchBody, context);
      cursor = template.indexOf("%}", end) + 2;
      continue;
    }

    if (directive.startsWith("for ")) {
      const match = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+)$/.exec(directive);

      if (!match) {
        throw new Error(`template_parse_error: invalid for directive "${directive}"`);
      }

      const [, variableName, expression] = match;
      const bodyStart = directiveEnd + 2;
      const { end } = findMatchingTag(template, bodyStart, "for ", "endfor");
      const values = readPath(context, expression.trim());

      if (!Array.isArray(values)) {
        throw new Error(`template_render_error: "${expression.trim()}" is not iterable`);
      }

      const loopBody = template.slice(bodyStart, end);

      for (const value of values) {
        output += renderTemplateSegment(loopBody, {
          ...context,
          [variableName]: value,
        });
      }

      cursor = template.indexOf("%}", end) + 2;
      continue;
    }

    if (directive === "else" || directive === "endif" || directive === "endfor") {
      throw new Error(`template_parse_error: unexpected directive "${directive}"`);
    }

    throw new Error(`template_parse_error: unsupported directive "${directive}"`);
  }

  return output;
}

export function renderPrompt(
  definition: WorkflowDefinition,
  issue: Record<string, unknown>,
  attempt: number | null,
): string {
  return renderTemplateSegment(definition.promptTemplate, {
    issue,
    attempt,
  }).trim();
}
