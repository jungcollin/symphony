import path from "node:path";

import { SymphonyOrchestrator } from "./orchestrator.ts";
import { startServer } from "./server.ts";

function printHelp(): void {
  console.log(`Symphony TypeScript

Usage:
  node --experimental-transform-types src/cli.ts [workflow-path] [--port <port>]

Examples:
  node --experimental-transform-types src/cli.ts
  node --experimental-transform-types src/cli.ts ./WORKFLOW.local.md --port 4020
`);
}

function parseArgs(argv: string[]): { workflowPath: string; port: number | null } {
  let workflowPath = path.resolve(process.cwd(), "WORKFLOW.md");
  let port: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--port") {
      const nextValue = argv[index + 1];

      if (!nextValue || !/^\d+$/.test(nextValue)) {
        throw new Error("--port requires an integer value");
      }

      port = Number.parseInt(nextValue, 10);
      index += 1;
      continue;
    }

    if (!arg.startsWith("-")) {
      workflowPath = path.resolve(process.cwd(), arg);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { workflowPath, port };
}

async function main(): Promise<void> {
  const { workflowPath, port } = parseArgs(process.argv.slice(2));
  const orchestrator = new SymphonyOrchestrator(workflowPath, port);
  await orchestrator.start();

  const config = orchestrator.currentConfig();

  if (config.server.port !== null) {
    await startServer(orchestrator, config.server.port, config.server.host);
    console.log(`Symphony board listening on http://${config.server.host}:${config.server.port}/`);
  } else {
    console.log("Symphony started without HTTP server");
  }

  process.on("SIGINT", () => {
    orchestrator.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    orchestrator.stop();
    process.exit(0);
  });
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
