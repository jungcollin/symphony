const AUTO_REFRESH_MS = 5000;
const BOARD_COLUMNS = ["Todo", "In Progress", "Done"];

const state = {
  snapshot: null,
  selectedIssueIdentifier: null,
  selectedDetail: null,
  loadingSnapshot: true,
  loadingDetail: false,
  refreshing: false,
  mutatingIssueIdentifier: null,
  dragIssueIdentifier: null,
  error: null,
};

const app = document.getElementById("app");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(value, maxLength) {
  if (!value) {
    return "";
  }

  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function formatTimestamp(value) {
  if (!value) {
    return "n/a";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatRelative(value) {
  if (!value) {
    return "No recent activity";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  if (Math.abs(diffSeconds) < 60) {
    return rtf.format(diffSeconds, "second");
  }

  const diffMinutes = Math.round(diffSeconds / 60);

  if (Math.abs(diffMinutes) < 60) {
    return rtf.format(diffMinutes, "minute");
  }

  const diffHours = Math.round(diffMinutes / 60);

  if (Math.abs(diffHours) < 24) {
    return rtf.format(diffHours, "hour");
  }

  return rtf.format(Math.round(diffHours / 24), "day");
}

function statusClass(runtimeStatus, trackerState) {
  if (runtimeStatus === "running") {
    return "pill pill--active";
  }

  if (runtimeStatus === "retrying") {
    return "pill pill--retrying";
  }

  if (String(trackerState).toLowerCase() === "done") {
    return "pill pill--done";
  }

  return "pill";
}

function runtimeLabel(issue) {
  if (issue.runtime_status === "running") {
    return "Active";
  }

  if (issue.runtime_status === "retrying") {
    return "Retrying";
  }

  return issue.tracker_state;
}

function laneDescriptor(column) {
  if (column === "Todo") {
    return "Queued and ready to pull";
  }

  if (column === "In Progress") {
    return "Live workspaces and active execution";
  }

  return "Finished or terminal items";
}

function selectedIssue() {
  if (!state.snapshot || !state.selectedIssueIdentifier) {
    return null;
  }

  return (
    state.snapshot.trackedIssues.find((issue) => issue.issue_identifier === state.selectedIssueIdentifier) || null
  );
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const code = payload?.error?.code || response.status;
    throw new Error(String(code));
  }

  return payload;
}

async function loadSnapshot({ silent = false } = {}) {
  if (!silent) {
    state.loadingSnapshot = true;
  }

  state.error = null;
  render();

  try {
    state.snapshot = await fetchJson("/api/v1/state");

    if (
      state.selectedIssueIdentifier &&
      !state.snapshot.trackedIssues.some(
        (issue) => issue.issue_identifier === state.selectedIssueIdentifier,
      )
    ) {
      state.selectedIssueIdentifier = null;
      state.selectedDetail = null;
    }

    if (state.selectedIssueIdentifier) {
      await loadIssueDetails(state.selectedIssueIdentifier, { silent: true });
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.loadingSnapshot = false;
    render();
  }
}

async function loadIssueDetails(issueIdentifier, { silent = false } = {}) {
  if (!issueIdentifier) {
    return;
  }

  if (!silent) {
    state.loadingDetail = true;
    render();
  }

  try {
    state.selectedDetail = await fetchJson(`/api/v1/${encodeURIComponent(issueIdentifier)}`);
  } catch (error) {
    state.selectedDetail = null;
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.loadingDetail = false;
    render();
  }
}

async function triggerRefresh() {
  state.refreshing = true;
  state.error = null;
  render();

  try {
    await fetchJson("/api/v1/refresh", { method: "POST" });
    await loadSnapshot({ silent: true });
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.refreshing = false;
    render();
  }
}

async function moveIssue(issueIdentifier, column, index) {
  state.mutatingIssueIdentifier = issueIdentifier;
  state.error = null;
  render();

  try {
    state.snapshot = await fetchJson(`/api/v1/issues/${encodeURIComponent(issueIdentifier)}/move`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        column,
        index,
      }),
    });

    if (state.selectedIssueIdentifier === issueIdentifier) {
      await loadIssueDetails(issueIdentifier, { silent: true });
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.mutatingIssueIdentifier = null;
    state.dragIssueIdentifier = null;
    clearLaneHighlights();
    render();
  }
}

function renderTop(snapshot) {
  const codexSeconds = Math.round(snapshot.codexTotals.secondsRunning || 0);

  return `
    <header class="hero">
      <section>
        <p class="hero__eyebrow">File-backed Symphony</p>
        <h1 class="hero__title">Execution board for real work.</h1>
        <p class="hero__copy">
          A vibe-kanban inspired control surface for Symphony. Move cards across lanes, inspect the active
          workspace, and keep orchestration state visible without depending on Linear.
        </p>
        <div class="hero__stats">
          ${[
            ["Tracked", snapshot.counts.tracked, "Cards loaded from the file tracker"],
            ["Running", snapshot.counts.running, "Active Codex sessions"],
            ["Retrying", snapshot.counts.retrying, "Cards queued for another turn"],
            ["Runtime", codexSeconds, "Total agent seconds recorded"],
          ]
            .map(
              ([label, value, meta]) => `
                <article class="stat">
                  <p class="stat__label">${escapeHtml(label)}</p>
                  <p class="stat__value">${escapeHtml(value)}</p>
                  <p class="stat__meta">${escapeHtml(meta)}</p>
                </article>
              `,
            )
            .join("")}
        </div>
      </section>
      <section class="hero__controls">
        <article class="action-card">
          <p class="action-card__label">Control surface</p>
          <p class="action-card__value">
            Drag cards between lanes to rewrite tracker state. The orchestrator keeps running independently and
            picks up active items on the next tick.
          </p>
        </article>
        <article class="action-card">
          <p class="action-card__label">Updated</p>
          <p class="action-card__value mono">${escapeHtml(snapshot.generatedAt)}</p>
        </article>
        <div class="toolbar">
          <button class="button button--primary" data-action="refresh-board" ${
            state.refreshing ? "disabled" : ""
          }>
            ${state.refreshing ? "Refreshing..." : "Refresh board"}
          </button>
          <a class="link-button" href="/observability">Observability</a>
        </div>
      </section>
    </header>
  `;
}

function renderBoard(snapshot) {
  return `
    <section class="board-panel">
      <div class="board-panel__header">
        <div>
          <h2 class="board-panel__title">Tracker lanes</h2>
          <p class="board-panel__copy">
            Drag to reorder or move cards. Runtime activity stays visible as badges and detail metadata.
          </p>
        </div>
      </div>
      <div class="lane-strip">
        ${BOARD_COLUMNS.map((column) => renderLane(snapshot, column)).join("")}
      </div>
    </section>
  `;
}

function renderLane(snapshot, column) {
  const lane = snapshot.board.columns.find((entry) => entry.label === column);
  const issues = lane?.issues || [];

  return `
    <section class="lane" data-column="${escapeHtml(column)}">
      <header class="lane__header">
        <div>
          <h3 class="lane__title">${escapeHtml(column)}</h3>
          <p class="lane__meta">${escapeHtml(laneDescriptor(column))}</p>
        </div>
        <span class="lane__count">${escapeHtml(issues.length)}</span>
      </header>
      <div class="lane__cards" data-drop-column="${escapeHtml(column)}">
        ${
          issues.length === 0
            ? `<div class="lane__empty">Drop an issue here to move it into ${escapeHtml(column)}.</div>`
            : issues.map((issue, index) => renderCard(issue, index)).join("")
        }
      </div>
    </section>
  `;
}

function renderCard(issue, index) {
  const isSelected = state.selectedIssueIdentifier === issue.issue_identifier;
  const isMutating = state.mutatingIssueIdentifier === issue.issue_identifier;

  return `
    <article
      class="issue-card ${isSelected ? "is-selected" : ""}"
      draggable="true"
      data-issue-identifier="${escapeHtml(issue.issue_identifier)}"
      data-select-issue="${escapeHtml(issue.issue_identifier)}"
      title="Drag to move this card"
    >
      <div class="issue-card__top">
        <div>
          <div class="issue-card__identifier">${escapeHtml(issue.issue_identifier)}</div>
          <div class="issue-card__order">Position ${escapeHtml(issue.position ?? (index + 1) * 1000)}</div>
        </div>
        <span class="${statusClass(issue.runtime_status, issue.tracker_state)}">
          ${escapeHtml(isMutating ? "Saving..." : runtimeLabel(issue))}
        </span>
      </div>
      <h3 class="issue-card__title">${escapeHtml(issue.title)}</h3>
      ${
        issue.description
          ? `<p class="issue-card__copy">${escapeHtml(truncate(issue.description, 160))}</p>`
          : ""
      }
      <div class="issue-card__meta">
        <span class="pill">${escapeHtml(issue.tracker_state)}</span>
        ${
          issue.retry_attempt
            ? `<span class="pill pill--retrying">Retry ${escapeHtml(issue.retry_attempt)}</span>`
            : ""
        }
        ${
          issue.blocked_by && issue.blocked_by.length > 0
            ? `<span class="pill">${escapeHtml(issue.blocked_by.length)} blockers</span>`
            : ""
        }
      </div>
      ${
        issue.labels && issue.labels.length > 0
          ? `<div class="label-strip">${issue.labels
              .map((label) => `<span class="label">${escapeHtml(label)}</span>`)
              .join("")}</div>`
          : ""
      }
      <footer class="issue-card__footer">
        <span>${escapeHtml(formatRelative(issue.last_activity_at || issue.updated_at || issue.created_at))}</span>
        <span>${issue.runtime_status === "running" ? "Workspace live" : "Tracker visible"}</span>
      </footer>
    </article>
  `;
}

function renderDrawer(snapshot) {
  const issue = selectedIssue();

  if (!issue) {
    return `
      <aside class="drawer">
        <div class="drawer__empty">
          <div>
            <p class="drawer__eyebrow">Issue details</p>
            <h2 class="drawer__title">Pick a card.</h2>
          </div>
          <p class="drawer__copy">
            Select a card to inspect its tracker state, workspace path, recent runtime events, and quick lane actions.
          </p>
          <div class="toolbar">
            <button class="button button--ghost button--compact" data-action="refresh-board">Refresh snapshot</button>
          </div>
        </div>
      </aside>
    `;
  }

  const detail = state.selectedDetail;
  const isLoading = state.loadingDetail;
  const tracked = detail?.tracked || issue;
  const currentColumn = issue.board_column;
  const recentEvents = detail?.recent_events || [];

  return `
    <aside class="drawer">
      <div class="drawer__card">
        <header class="drawer__header">
          <div>
            <p class="drawer__eyebrow">${escapeHtml(issue.issue_identifier)}</p>
            <h2 class="drawer__issue-title">${escapeHtml(issue.title)}</h2>
          </div>
          <span class="${statusClass(issue.runtime_status, issue.tracker_state)}">${escapeHtml(runtimeLabel(issue))}</span>
        </header>
        ${
          issue.description
            ? `<p class="drawer__muted">${escapeHtml(issue.description)}</p>`
            : `<p class="drawer__muted">No description was provided for this issue.</p>`
        }

        <section class="drawer__section">
          <h3 class="drawer__section-title">Quick move</h3>
          <div class="drawer__actions">
            ${BOARD_COLUMNS.map(
              (column) => `
                <button
                  class="button button--compact ${column === currentColumn ? "button--primary" : "button--ghost"}"
                  data-move-column="${escapeHtml(column)}"
                  data-issue-identifier="${escapeHtml(issue.issue_identifier)}"
                  ${state.mutatingIssueIdentifier ? "disabled" : ""}
                >
                  ${escapeHtml(column)}
                </button>
              `,
            ).join("")}
          </div>
        </section>

        <section class="drawer__section">
          <h3 class="drawer__section-title">Tracker</h3>
          <div class="drawer__detail-list">
            <div class="detail-row"><span class="detail-row__label">Tracker state</span><span class="detail-row__value">${escapeHtml(
              tracked.tracker_state || issue.tracker_state,
            )}</span></div>
            <div class="detail-row"><span class="detail-row__label">Board column</span><span class="detail-row__value">${escapeHtml(
              issue.board_column,
            )}</span></div>
            <div class="detail-row"><span class="detail-row__label">Updated</span><span class="detail-row__value">${escapeHtml(
              formatTimestamp(tracked.updated_at || issue.updated_at),
            )}</span></div>
            <div class="detail-row"><span class="detail-row__label">Workspace</span><span class="detail-row__value mono">${escapeHtml(
              detail?.workspace?.path || "n/a",
            )}</span></div>
            <div class="detail-row"><span class="detail-row__label">Retry</span><span class="detail-row__value">${escapeHtml(
              issue.retry_attempt || 0,
            )}</span></div>
          </div>
        </section>

        ${
          issue.labels && issue.labels.length > 0
            ? `
            <section class="drawer__section">
              <h3 class="drawer__section-title">Labels</h3>
              <div class="label-strip">${issue.labels
                .map((label) => `<span class="label">${escapeHtml(label)}</span>`)
                .join("")}</div>
            </section>
          `
            : ""
        }

        <section class="drawer__section">
          <h3 class="drawer__section-title">Activity</h3>
          ${
            isLoading
              ? `<p class="drawer__muted">Loading issue details...</p>`
              : recentEvents.length === 0
                ? `<p class="drawer__muted">No recent runtime events captured for this issue.</p>`
                : `<div class="timeline">${recentEvents
                    .map(
                      (event) => `
                        <article class="timeline__item">
                          <div class="timeline__meta">${escapeHtml(event.event || "event")} · ${escapeHtml(
                            formatTimestamp(event.at),
                          )}</div>
                          <div class="timeline__copy">${escapeHtml(event.message || "No message body")}</div>
                        </article>
                      `,
                    )
                    .join("")}</div>`
          }
          ${
            detail?.last_error
              ? `<div class="notice">Last error: ${escapeHtml(detail.last_error)}</div>`
              : ""
          }
        </section>

        <section class="drawer__section">
          <h3 class="drawer__section-title">JSON</h3>
          <a class="drawer__link" href="/api/v1/${encodeURIComponent(issue.issue_identifier)}" target="_blank" rel="noreferrer">
            Open issue detail JSON
          </a>
          <pre class="drawer__code">${escapeHtml(JSON.stringify(detail || issue, null, 2))}</pre>
        </section>
      </div>
    </aside>
  `;
}

function render() {
  if (!app) {
    return;
  }

  if (state.loadingSnapshot && !state.snapshot) {
    app.innerHTML = `
      <div class="app-loading">
        <div>
          <p class="app-loading__eyebrow">Symphony</p>
          <h1 class="app-loading__title">Loading board</h1>
          <p class="app-loading__copy">Waiting for the tracker snapshot and orchestration state.</p>
        </div>
      </div>
    `;
    return;
  }

  if (!state.snapshot) {
    app.innerHTML = `
      <div class="app-loading">
        <div>
          <p class="app-loading__eyebrow">Symphony</p>
          <h1 class="app-loading__title">Board unavailable</h1>
          <p class="app-loading__copy">${escapeHtml(state.error || "The board could not be loaded.")}</p>
          <div class="toolbar" style="justify-content:center; margin-top: 12px;">
            <button class="button button--primary" data-action="refresh-board">Retry</button>
          </div>
        </div>
      </div>
    `;
    return;
  }

  app.innerHTML = `
    <div class="shell">
      <div class="frame">
        ${renderTop(state.snapshot)}
        ${
          state.error
            ? `<div class="notice">Board error: ${escapeHtml(state.error)}</div>`
            : ""
        }
        <section class="workspace">
          ${renderBoard(state.snapshot)}
          ${renderDrawer(state.snapshot)}
        </section>
      </div>
    </div>
  `;
}

function clearLaneHighlights() {
  document.querySelectorAll(".lane").forEach((lane) => {
    lane.classList.remove("is-drop-target");
  });
}

function handleClick(event) {
  const refreshButton = event.target.closest("[data-action='refresh-board']");

  if (refreshButton) {
    event.preventDefault();
    void triggerRefresh();
    return;
  }

  const moveButton = event.target.closest("[data-move-column]");

  if (moveButton) {
    event.preventDefault();
    const issueIdentifier = moveButton.getAttribute("data-issue-identifier");
    const column = moveButton.getAttribute("data-move-column");

    if (issueIdentifier && column && BOARD_COLUMNS.includes(column)) {
      const lane = state.snapshot?.board.columns.find((entry) => entry.label === column);
      const targetIndex = lane?.issues?.length ?? 0;
      void moveIssue(issueIdentifier, column, targetIndex);
    }

    return;
  }

  const issueTrigger = event.target.closest("[data-select-issue]");

  if (issueTrigger) {
    const issueIdentifier = issueTrigger.getAttribute("data-select-issue");

    if (issueIdentifier) {
      state.selectedIssueIdentifier = issueIdentifier;
      render();
      void loadIssueDetails(issueIdentifier);
    }
  }
}

function handleDragStart(event) {
  const card = event.target.closest(".issue-card");

  if (!card) {
    return;
  }

  const issueIdentifier = card.getAttribute("data-issue-identifier");

  if (!issueIdentifier) {
    return;
  }

  state.dragIssueIdentifier = issueIdentifier;
  card.classList.add("is-dragging");

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", issueIdentifier);
  }
}

function handleDragEnd(event) {
  const card = event.target.closest(".issue-card");

  if (card) {
    card.classList.remove("is-dragging");
  }

  state.dragIssueIdentifier = null;
  clearLaneHighlights();
}

function computeDropIndex(container, clientY) {
  const cards = [...container.querySelectorAll(".issue-card:not(.is-dragging)")];

  for (let index = 0; index < cards.length; index += 1) {
    const rect = cards[index].getBoundingClientRect();

    if (clientY < rect.top + rect.height / 2) {
      return index;
    }
  }

  return cards.length;
}

function handleDragOver(event) {
  const laneCards = event.target.closest(".lane__cards");

  if (!laneCards || !state.dragIssueIdentifier) {
    return;
  }

  event.preventDefault();
  clearLaneHighlights();
  laneCards.closest(".lane")?.classList.add("is-drop-target");

  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }
}

function handleDrop(event) {
  const laneCards = event.target.closest(".lane__cards");

  if (!laneCards || !state.dragIssueIdentifier) {
    return;
  }

  event.preventDefault();
  const column = laneCards.getAttribute("data-drop-column");

  if (!column || !BOARD_COLUMNS.includes(column)) {
    return;
  }

  const index = computeDropIndex(laneCards, event.clientY);
  void moveIssue(state.dragIssueIdentifier, column, index);
}

document.addEventListener("click", handleClick);
document.addEventListener("dragstart", handleDragStart);
document.addEventListener("dragend", handleDragEnd);
document.addEventListener("dragover", handleDragOver);
document.addEventListener("drop", handleDrop);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    void loadSnapshot({ silent: true });
  }
});

setInterval(() => {
  if (!document.hidden && !state.dragIssueIdentifier && !state.mutatingIssueIdentifier) {
    void loadSnapshot({ silent: true });
  }
}, AUTO_REFRESH_MS);

void loadSnapshot();
