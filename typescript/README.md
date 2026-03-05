# Symphony TypeScript

This directory contains a TypeScript implementation of Symphony for teams that want to adopt the
`SPEC.md` model without using the Elixir reference implementation.

## Design choices

- Follows the Symphony spec structure: workflow loader, config layer, tracker adapter, workspace
  manager, orchestrator, runner, and HTTP status surface.
- Uses `tracker.kind: file` as the first implemented tracker so the service works without Linear.
- Ships with a vibe-kanban-inspired interactive board, served directly by the runtime.
- Uses `codex exec` for coding-agent runs instead of `codex app-server`.
  - This is the main adaptation from the reference implementation.
  - Continuation runs reuse the recorded Codex thread via `codex exec resume`.
- Runs directly on Node 22 using `--experimental-transform-types`, so no npm packages are required.

## Files

- `src/cli.ts`: CLI entrypoint
- `src/workflow.ts`: workflow loader, YAML/front-matter parser, strict prompt renderer
- `src/tracker.ts`: file tracker adapter
- `src/workspace.ts`: workspace preparation and hooks
- `src/agent-runner.ts`: `codex exec` integration
- `src/orchestrator.ts`: polling, retries, reconciliation, runtime state
- `src/server.ts`: board, observability UI, and JSON API

## Local run

```bash
cd /Users/collin/Project/etc/symphony/typescript
SYMPHONY_SOURCE_REPO=/Users/collin/Project/etc/symphony \
node --experimental-transform-types src/cli.ts ./WORKFLOW.local.md --port 4020
```

Requirements:

- Node.js 22 or newer
- `codex` available on `PATH`

Then open:

- `http://127.0.0.1:4020/` for the board
- `http://127.0.0.1:4020/observability` for runtime status

Generated workspaces are created under `typescript/tmp/` and are ignored by Git.

The board supports:

- drag-and-drop lane changes
- persistent card ordering through `position`
- a detail panel with workspace and runtime metadata
- quick move buttons for mobile or non-drag workflows

## Workflow contract

The implementation reads `WORKFLOW.md` with YAML front matter and supports these core sections:

- `tracker`
- `polling`
- `workspace`
- `hooks`
- `agent`
- `codex`
- `server` as an HTTP extension

Implemented tracker kinds:

- `file`

TypeScript-specific `tracker` extension fields:

- `path`: path to a JSON issue file for `tracker.kind: file`

The issue file may be either:

- a JSON array of issues
- or `{ "issues": [...] }`

Required issue fields for dispatch:

- `id`
- `identifier`
- `title`
- `state`

## Current limitations

- Linear transport is not implemented yet in this TypeScript adaptation.
- The runner uses `codex exec` JSON events, so token and session metadata are less detailed than the
  app-server protocol in the spec.
- Tracker writes currently cover board moves and ordering only. Comments and richer issue edits are
  still outside the orchestrator boundary.
