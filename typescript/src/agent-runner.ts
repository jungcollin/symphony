import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { RunnerResult, RunnerUpdate, RuntimeConfig } from "./types.ts";

function nowIso(): string {
  return new Date().toISOString();
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseUsage(rawUsage: unknown): { inputTokens: number; outputTokens: number; totalTokens: number } {
  if (!rawUsage || typeof rawUsage !== "object") {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  const usage = rawUsage as Record<string, unknown>;
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const totalTokens =
    typeof usage.total_tokens === "number" ? usage.total_tokens : inputTokens + outputTokens;

  return { inputTokens, outputTokens, totalTokens };
}

export class AgentRunHandle {
  readonly promise: Promise<RunnerResult>;
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams, promise: Promise<RunnerResult>) {
    this.child = child;
    this.promise = promise;
  }

  kill(): void {
    this.child.kill("SIGTERM");
  }
}

export class AgentRunner {
  private readonly config: RuntimeConfig;

  constructor(config: RuntimeConfig) {
    this.config = config;
  }

  start(
    prompt: string,
    workspacePath: string,
    attempt: number | null,
    resumeThreadId: string | null,
    onUpdate: (update: RunnerUpdate) => void,
  ): AgentRunHandle {
    const command = resumeThreadId
      ? `${this.config.codex.command} exec resume --json --skip-git-repo-check ${shellEscape(resumeThreadId)} -`
      : `${this.config.codex.command} exec --json --skip-git-repo-check -`;

    const child = spawn("sh", ["-lc", command], {
      cwd: workspacePath,
      env: {
        ...process.env,
        SYMPHONY_ATTEMPT: attempt === null ? "" : String(attempt),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdin.write(prompt);
    child.stdin.end();

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let threadId: string | null = resumeThreadId;
    let turnCount = 0;
    let success = false;
    let failureError: string | null = null;
    let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    const promise = new Promise<RunnerResult>((resolve) => {
      const timeout = setTimeout(() => {
        failureError = "turn_timeout";
        child.kill("SIGTERM");
      }, this.config.codex.turnTimeoutMs);

      const emit = (update: RunnerUpdate): void => {
        onUpdate(update);
      };

      const handleLine = (line: string): void => {
        if (!line.trim()) {
          return;
        }

        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const type = typeof parsed.type === "string" ? parsed.type : "log";

          if (type === "thread.started") {
            threadId = typeof parsed.thread_id === "string" ? parsed.thread_id : threadId;
            turnCount = 0;
            emit({
              type: "thread.started",
              timestamp: nowIso(),
              threadId,
              sessionId: threadId,
              turnCount,
            });
            return;
          }

          if (type === "turn.started") {
            turnCount += 1;
            emit({
              type: "turn.started",
              timestamp: nowIso(),
              threadId,
              sessionId: threadId ? `${threadId}-turn-${turnCount}` : null,
              turnCount,
            });
            return;
          }

          if (type === "item.completed") {
            const item = parsed.item;

            if (
              item &&
              typeof item === "object" &&
              (item as Record<string, unknown>).type === "agent_message"
            ) {
              const text =
                typeof (item as Record<string, unknown>).text === "string"
                  ? ((item as Record<string, unknown>).text as string)
                  : "";

              emit({
                type: "agent.message",
                timestamp: nowIso(),
                threadId,
                sessionId: threadId ? `${threadId}-turn-${turnCount}` : null,
                turnCount,
                message: text,
              });
            }

            return;
          }

          if (type === "turn.completed") {
            success = true;
            usage = parseUsage(parsed.usage);
            emit({
              type: "turn.completed",
              timestamp: nowIso(),
              threadId,
              sessionId: threadId ? `${threadId}-turn-${turnCount}` : null,
              turnCount,
              usage,
            });
            return;
          }

          if (type === "turn.failed" || type === "turn.cancelled") {
            failureError = type;
            emit({
              type: type === "turn.failed" ? "turn.failed" : "turn.cancelled",
              timestamp: nowIso(),
              threadId,
              sessionId: threadId ? `${threadId}-turn-${turnCount}` : null,
              turnCount,
              message: JSON.stringify(parsed),
            });
            return;
          }

          emit({
            type: "log",
            timestamp: nowIso(),
            threadId,
            sessionId: threadId ? `${threadId}-turn-${turnCount}` : null,
            turnCount,
            message: line,
          });
        } catch {
          emit({
            type: "log",
            timestamp: nowIso(),
            threadId,
            sessionId: threadId ? `${threadId}-turn-${turnCount}` : null,
            turnCount,
            message: line,
          });
        }
      };

      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();

        while (stdoutBuffer.includes("\n")) {
          const newlineIndex = stdoutBuffer.indexOf("\n");
          const line = stdoutBuffer.slice(0, newlineIndex);
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          handleLine(line);
        }
      });

      child.stderr.on("data", (chunk) => {
        stderrBuffer += chunk.toString();
      });

      child.on("close", (code, signal) => {
        clearTimeout(timeout);

        if (success) {
          resolve({
            status: "success",
            error: null,
            threadId,
            sessionId: threadId ? `${threadId}-turn-${turnCount}` : null,
            usage,
          });
          return;
        }

        const reason =
          failureError ||
          stderrBuffer.trim() ||
          `agent exited with code=${code ?? "null"} signal=${signal ?? "null"}`;

        resolve({
          status: signal === "SIGTERM" && failureError === null ? "cancelled" : "failure",
          error: reason,
          threadId,
          sessionId: threadId ? `${threadId}-turn-${turnCount}` : null,
          usage,
        });
      });

      child.on("error", (error) => {
        clearTimeout(timeout);
        resolve({
          status: "failure",
          error: error.message,
          threadId,
          sessionId: threadId ? `${threadId}-turn-${turnCount}` : null,
          usage,
        });
      });
    });

    return new AgentRunHandle(child, promise);
  }
}
