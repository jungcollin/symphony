import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import type { Issue, RuntimeConfig } from "./types.ts";

function normalizeAbsolute(targetPath: string): string {
  return path.resolve(targetPath);
}

function ensureInsideRoot(rootPath: string, targetPath: string): void {
  const absoluteRoot = normalizeAbsolute(rootPath);
  const absoluteTarget = normalizeAbsolute(targetPath);

  if (absoluteTarget !== absoluteRoot && !absoluteTarget.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`invalid_workspace_path: ${absoluteTarget}`);
  }
}

function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

function nowIso(): string {
  return new Date().toISOString();
}

export class WorkspaceManager {
  private readonly config: RuntimeConfig;

  constructor(config: RuntimeConfig) {
    this.config = config;
  }

  workspacePath(identifier: string): string {
    const workspaceKey = sanitizeWorkspaceKey(identifier);
    const workspacePath = path.join(this.config.workspace.root, workspaceKey);
    ensureInsideRoot(this.config.workspace.root, workspacePath);
    return workspacePath;
  }

  async prepareWorkspace(issue: Issue): Promise<{ workspacePath: string; createdNow: boolean }> {
    const workspacePath = this.workspacePath(issue.identifier);
    await fs.mkdir(this.config.workspace.root, { recursive: true });

    const existed = await fs
      .stat(workspacePath)
      .then((stat) => stat.isDirectory())
      .catch(() => false);

    if (!existed) {
      await fs.mkdir(workspacePath, { recursive: true });
      await this.runHook("afterCreate", issue, workspacePath, true);
    }

    return { workspacePath, createdNow: !existed };
  }

  async beforeRun(issue: Issue, workspacePath: string): Promise<void> {
    await this.runHook("beforeRun", issue, workspacePath, true);
  }

  async afterRun(issue: Issue, workspacePath: string): Promise<void> {
    await this.runHook("afterRun", issue, workspacePath, false);
  }

  async removeWorkspace(issue: Issue): Promise<void> {
    const workspacePath = this.workspacePath(issue.identifier);
    const exists = await fs
      .stat(workspacePath)
      .then((stat) => stat.isDirectory())
      .catch(() => false);

    if (!exists) {
      return;
    }

    await this.runHook("beforeRemove", issue, workspacePath, false);
    await fs.rm(workspacePath, { recursive: true, force: true });
  }

  private async runHook(
    hookName: keyof RuntimeConfig["hooks"],
    issue: Issue,
    workspacePath: string,
    fatal: boolean,
  ): Promise<void> {
    const script = this.config.hooks[hookName];

    if (!script) {
      return;
    }

    const timeoutMs = this.config.hooks.timeoutMs;

    await new Promise<void>((resolve, reject) => {
      const child = spawn("sh", ["-lc", script], {
        cwd: workspacePath,
        env: {
          ...process.env,
          SYMPHONY_ISSUE_ID: issue.id,
          SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
          SYMPHONY_ISSUE_TITLE: issue.title,
          SYMPHONY_WORKSPACE_PATH: workspacePath,
          SYMPHONY_WORKSPACE_CREATED_AT: nowIso(),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, timeoutMs);

      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);

        if (code === 0) {
          resolve();
          return;
        }

        const reason = `hook_${hookName}_failed: code=${code ?? "null"} signal=${signal ?? "null"} ${stderr.trim()}`.trim();

        if (fatal) {
          reject(new Error(reason));
        } else {
          console.warn(reason);
          resolve();
        }
      });

      child.on("error", (error) => {
        clearTimeout(timer);

        if (fatal) {
          reject(error);
        } else {
          console.warn(`hook_${hookName}_spawn_failed: ${error.message}`);
          resolve();
        }
      });
    });
  }
}
