---
tracker:
  kind: file
  path: ./issues.local.json
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
polling:
  interval_ms: 5000
workspace:
  root: ./tmp/workspaces
hooks:
  after_create: |
    if [ -n "$SYMPHONY_SOURCE_REPO" ]; then
      git clone "$SYMPHONY_SOURCE_REPO" .
    fi
agent:
  max_concurrent_agents: 1
  max_turns: 5
  max_retry_backoff_ms: 60000
codex:
  command: codex -a never --sandbox workspace-write
  turn_timeout_ms: 900000
  stall_timeout_ms: 300000
server:
  port: 4020
  host: 127.0.0.1
---
# Symphony Issue

You are working on a tracked issue in a Symphony workspace.

Issue identifier: {{ issue.identifier }}
Issue title: {{ issue.title }}
Issue state: {{ issue.state }}

{% if issue.description %}
Description:
{{ issue.description }}
{% else %}
Description:
No additional description was provided.
{% endif %}

{% if attempt %}
This is a continuation or retry attempt: {{ attempt }}
{% endif %}

Rules:

1. Work only inside the current workspace.
2. Prefer small, verifiable changes.
3. Leave a short summary of what changed in `local-summary.md`.
