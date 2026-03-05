import fs from "node:fs/promises";
import http from "node:http";

import type { SymphonyOrchestrator } from "./orchestrator.ts";

const BOARD_ASSETS = new Map([
  [
    "/assets/board.css",
    {
      fileUrl: new URL("../web/board.css", import.meta.url),
      contentType: "text/css; charset=utf-8",
    },
  ],
  [
    "/assets/board.js",
    {
      fileUrl: new URL("../web/board.js", import.meta.url),
      contentType: "text/javascript; charset=utf-8",
    },
  ],
]);

function escapeHtml(value: string | null | undefined): string {
  const source = value ?? "";
  return source
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlPage(title: string, body: string, head = ""): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    ${head}
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

function renderBoardShell(): string {
  return htmlPage(
    "Symphony Board",
    `
    <div id="app">
      <div class="app-loading">
        <p class="app-loading__eyebrow">Symphony</p>
        <h1 class="app-loading__title">Loading board</h1>
        <p class="app-loading__copy">Fetching tracker state and orchestration status.</p>
      </div>
    </div>
    <script type="module" src="/assets/board.js"></script>
    `,
    `
    <link rel="stylesheet" href="/assets/board.css" />
    `,
  );
}

function renderObservability(snapshot: Awaited<ReturnType<SymphonyOrchestrator["snapshot"]>>): string {
  const body = `
  <main style="max-width: 1200px; margin: 0 auto; padding: 24px; font-family: 'Avenir Next', 'Segoe UI', sans-serif; color: #16202a;">
    <header style="display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 20px;">
      <div>
        <p style="margin: 0; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #6c7b88;">Symphony Observability</p>
        <h1 style="margin: 8px 0 0; font-size: 44px; line-height: 0.96; letter-spacing: -0.05em;">Operations Dashboard</h1>
        <p style="margin: 12px 0 0; max-width: 720px; color: #5b6772; line-height: 1.6;">Runtime status, retries, token totals, and the current board snapshot from the active Symphony service.</p>
      </div>
      <a href="/" style="display: inline-flex; min-height: 38px; align-items: center; padding: 0 14px; border-radius: 999px; border: 1px solid #d7dde3; color: #16202a; text-decoration: none; font-weight: 700;">Board</a>
    </header>
    <section style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 18px;">
      ${[
        ["Running", snapshot.counts.running],
        ["Retrying", snapshot.counts.retrying],
        ["Tracked", snapshot.counts.tracked],
        ["Tokens", snapshot.codexTotals.totalTokens],
      ]
        .map(
          ([label, value]) => `
            <article style="padding: 16px 18px; border: 1px solid #d7dde3; border-radius: 18px; background: #ffffff;">
              <p style="margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; color: #6c7b88;">${escapeHtml(String(label))}</p>
              <p style="margin: 10px 0 0; font-size: 28px; line-height: 1; letter-spacing: -0.04em;">${escapeHtml(String(value))}</p>
            </article>
          `,
        )
        .join("")}
    </section>
    <section style="display: grid; gap: 16px;">
      <article style="padding: 16px 18px; border: 1px solid #d7dde3; border-radius: 18px; background: #ffffff;">
        <h2 style="margin: 0; font-size: 20px;">Board Snapshot</h2>
        <pre style="margin: 16px 0 0; white-space: pre-wrap; word-break: break-word; color: #334155;">${escapeHtml(JSON.stringify(snapshot.board, null, 2))}</pre>
      </article>
      <article style="padding: 16px 18px; border: 1px solid #d7dde3; border-radius: 18px; background: #ffffff;">
        <h2 style="margin: 0; font-size: 20px;">Running Sessions</h2>
        <pre style="margin: 16px 0 0; white-space: pre-wrap; word-break: break-word; color: #334155;">${escapeHtml(JSON.stringify(snapshot.running, null, 2))}</pre>
      </article>
      <article style="padding: 16px 18px; border: 1px solid #d7dde3; border-radius: 18px; background: #ffffff;">
        <h2 style="margin: 0; font-size: 20px;">Retry Queue</h2>
        <pre style="margin: 16px 0 0; white-space: pre-wrap; word-break: break-word; color: #334155;">${escapeHtml(JSON.stringify(snapshot.retrying, null, 2))}</pre>
      </article>
    </section>
  </main>`;

  return htmlPage("Symphony Observability", body);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;

    if (totalBytes > 64 * 1024) {
      throw new Error("request_body_too_large");
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();

  if (body === "") {
    return {};
  }

  const parsed = JSON.parse(body) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid_json_object");
  }

  return parsed as Record<string, unknown>;
}

async function serveAsset(pathname: string, res: http.ServerResponse): Promise<boolean> {
  const asset = BOARD_ASSETS.get(pathname);

  if (!asset) {
    return false;
  }

  const content = await fs.readFile(asset.fileUrl);
  res.writeHead(200, {
    "content-type": asset.contentType,
    "cache-control": "no-store",
  });
  res.end(content);
  return true;
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function html(res: http.ServerResponse, status: number, payload: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(payload);
}

export async function startServer(
  orchestrator: SymphonyOrchestrator,
  port: number,
  host: string,
): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
      const moveMatch = url.pathname.match(/^\/api\/v1\/issues\/([^/]+)\/move$/);

      if (await serveAsset(url.pathname, res)) {
        return;
      }

      if (req.method === "GET" && url.pathname === "/") {
        html(res, 200, renderBoardShell());
        return;
      }

      if (req.method === "GET" && url.pathname === "/observability") {
        html(res, 200, renderObservability(await orchestrator.snapshot()));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/state") {
        json(res, 200, await orchestrator.snapshot());
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/refresh") {
        json(res, 202, orchestrator.requestRefresh());
        return;
      }

      if (moveMatch) {
        if (req.method !== "POST" && req.method !== "PATCH") {
          json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
          return;
        }

        const issueIdentifier = decodeURIComponent(moveMatch[1] ?? "");
        const payload = await readJsonBody(req);
        const column = payload.column;
        const index = payload.index;

        if (column !== "Todo" && column !== "In Progress" && column !== "Done") {
          json(res, 422, { error: { code: "invalid_board_column", message: "Column must be Todo, In Progress, or Done" } });
          return;
        }

        if (index !== undefined && index !== null && (!Number.isInteger(index) || Number(index) < 0)) {
          json(res, 422, { error: { code: "invalid_board_index", message: "Index must be a non-negative integer" } });
          return;
        }

        const snapshot = await orchestrator.moveIssue(
          issueIdentifier,
          column,
          typeof index === "number" ? index : null,
        );
        json(res, 200, snapshot);
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/v1/")) {
        const issueIdentifier = decodeURIComponent(url.pathname.slice("/api/v1/".length));
        const payload = await orchestrator.issueDetails(issueIdentifier);

        if (!payload) {
          json(res, 404, { error: { code: "issue_not_found", message: "Issue not found" } });
          return;
        }

        json(res, 200, payload);
        return;
      }

      if (url.pathname.startsWith("/api/v1/")) {
        json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
        return;
      }

      json(res, 404, { error: { code: "not_found", message: "Route not found" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status =
        message === "issue_not_found" ? 404 : message.startsWith("invalid_") || message === "request_body_too_large" ? 422 : 500;
      json(res, status, { error: { code: message, message } });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  return server;
}
