import { RefreshCw, Trash2, createLucideIcon } from "../ui/originalIcons.js";
import "./dev-tools.css";

export type ToolStatsSummaryRow = {
  name: string;
  calls: number;
  success: number;
  failure: number;
};

export type ToolStatsInvocationRow = {
  id: string;
  name: string;
  status: string;
  reason: string;
  sessionId: string;
  startedAt: number;
  durationMs: number;
  returnCode?: number;
  sceneJson?: string;
};

export type ToolStatsScope = "session" | "global";

/** Tools tab — left tool list + right invocation history for the selected tool. */
export class ToolStatsPaneView {
  readonly root: HTMLElement;
  readonly refreshButton: HTMLButtonElement;
  readonly resetButton: HTMLButtonElement;
  readonly filterSessionButton: HTMLButtonElement;
  readonly filterGlobalButton: HTMLButtonElement;
  private readonly overviewHost: HTMLElement;
  private readonly toolsHost: HTMLElement;
  private readonly invocationsHost: HTMLElement;
  private readonly toolsCountEl: HTMLElement;
  private readonly invocationsCountEl: HTMLElement;
  private readonly invocationsTitleEl: HTMLElement;
  private readonly noticeEl: HTMLElement;
  private toolSelectHandler: ((name: string) => void) | undefined;
  private filterChangeHandler:
    | ((scope: ToolStatsScope) => void)
    | undefined;
  private selectedName = "";
  private scope: ToolStatsScope = "global";

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "tool-stats-pane";

    const toolbar = document.createElement("div");
    toolbar.className = "tool-stats-toolbar";

    const filterGroup = document.createElement("div");
    filterGroup.className = "tool-stats-filter";
    filterGroup.setAttribute("role", "group");
    filterGroup.setAttribute("aria-label", "Tool stats scope");
    this.filterSessionButton = filterButton(
      "Current session",
      "Only the focused conversation (and its subagents)",
    );
    this.filterGlobalButton = filterButton(
      "Global",
      "Every recorded invocation across all sessions",
    );
    this.filterSessionButton.addEventListener("click", () => {
      this.applyScope("session");
    });
    this.filterGlobalButton.addEventListener("click", () => {
      this.applyScope("global");
    });
    filterGroup.append(this.filterSessionButton, this.filterGlobalButton);
    toolbar.append(filterGroup);

    this.refreshButton = document.createElement("button");
    this.refreshButton.type = "button";
    this.refreshButton.className = "tool-stats-refresh";
    this.refreshButton.title = "Refresh";
    this.refreshButton.setAttribute("aria-label", "Refresh");
    this.refreshButton.append(createLucideIcon(RefreshCw, { size: 14 }));
    toolbar.append(this.refreshButton);

    this.resetButton = document.createElement("button");
    this.resetButton.type = "button";
    this.resetButton.className = "tool-stats-reset";
    this.resetButton.title = "Reset all tool stats";
    this.resetButton.setAttribute("aria-label", "Reset all tool stats");
    this.resetButton.append(createLucideIcon(Trash2, { size: 14 }));
    toolbar.append(this.resetButton);

    this.overviewHost = document.createElement("div");
    this.overviewHost.className = "tool-stats-overview";

    const body = document.createElement("div");
    body.className = "tool-stats-body";

    const columns = document.createElement("div");
    columns.className = "tool-stats-columns";

    const toolsSection = document.createElement("section");
    toolsSection.className = "tool-stats-section tool-stats-section-tools";
    const toolsHeader = document.createElement("div");
    toolsHeader.className = "tool-stats-section-header";
    const toolsTitle = document.createElement("h3");
    toolsTitle.className = "tool-stats-section-title";
    toolsTitle.textContent = "Tools";
    this.toolsCountEl = document.createElement("span");
    this.toolsCountEl.className = "tool-stats-section-count";
    toolsHeader.append(toolsTitle, this.toolsCountEl);
    this.toolsHost = document.createElement("div");
    this.toolsHost.className = "tool-stats-table-wrap";
    toolsSection.append(toolsHeader, this.toolsHost);

    const invocationsSection = document.createElement("section");
    invocationsSection.className =
      "tool-stats-section tool-stats-section-invocations";
    const invocationsHeader = document.createElement("div");
    invocationsHeader.className = "tool-stats-section-header";
    this.invocationsTitleEl = document.createElement("h3");
    this.invocationsTitleEl.className = "tool-stats-section-title";
    this.invocationsTitleEl.textContent = "Invocations";
    this.invocationsCountEl = document.createElement("span");
    this.invocationsCountEl.className = "tool-stats-section-count";
    invocationsHeader.append(this.invocationsTitleEl, this.invocationsCountEl);
    this.invocationsHost = document.createElement("div");
    this.invocationsHost.className = "tool-stats-table-wrap";
    invocationsSection.append(invocationsHeader, this.invocationsHost);

    columns.append(toolsSection, invocationsSection);
    this.noticeEl = document.createElement("div");
    this.noticeEl.className = "tool-stats-notice";
    this.noticeEl.hidden = true;
    body.append(this.noticeEl, this.overviewHost, columns);
    this.root.append(toolbar, body);
  }

  /**
   * Recording-disabled banner. Without it an empty table reads as "no calls
   * happened" when the real cause is toolStatsEnabled=false in settings.
   */
  setRecordingDisabled(disabled: boolean): void {
    this.noticeEl.hidden = !disabled;
    this.noticeEl.textContent = disabled
      ? "Tool call stats recording is disabled — enable it in Settings → Agent → Tool call stats. Calls made while disabled are not recorded."
      : "";
  }

  onToolSelect(handler: (name: string) => void): void {
    this.toolSelectHandler = handler;
  }

  onFilterChange(handler: (scope: ToolStatsScope) => void): void {
    this.filterChangeHandler = handler;
  }

  getScope(): ToolStatsScope {
    return this.scope;
  }

  private applyScope(scope: ToolStatsScope): void {
    if (this.scope === scope) return;
    this.scope = scope;
    this.renderScope();
    this.filterChangeHandler?.(scope);
  }

  private renderScope(): void {
    this.filterSessionButton.classList.toggle(
      "is-active",
      this.scope === "session",
    );
    this.filterSessionButton.setAttribute(
      "aria-pressed",
      String(this.scope === "session"),
    );
    this.filterGlobalButton.classList.toggle(
      "is-active",
      this.scope === "global",
    );
    this.filterGlobalButton.setAttribute(
      "aria-pressed",
      String(this.scope === "global"),
    );
  }

  getSelectedName(): string {
    return this.selectedName;
  }

  setTools(
    rows: ToolStatsSummaryRow[],
    selectedName: string,
    emptyHint?: string,
  ): void {
    const totals = rows.reduce(
      (acc, row) => {
        acc.calls += row.calls;
        acc.success += row.success;
        acc.failure += row.failure;
        return acc;
      },
      { calls: 0, success: 0, failure: 0 },
    );
    this.renderOverview(totals);
    this.toolsCountEl.textContent =
      rows.length === 0 ? "" : `${rows.length}`;

    this.selectedName = selectedName;
    this.toolsHost.replaceChildren();
    if (rows.length === 0) {
      this.toolsHost.append(
        emptyState(emptyHint ?? "No tool calls recorded yet."),
      );
      return;
    }

    const table = document.createElement("table");
    table.className = "tool-stats-table tool-stats-table-tools";
    const thead = document.createElement("thead");
    thead.append(
      headerRow([
        { label: "Tool", className: "is-tool" },
        { label: "Calls", className: "is-center is-calls" },
        { label: "OK", className: "is-center is-ok-col" },
        { label: "Fail", className: "is-center is-fail-col" },
        { label: "Rate", className: "is-center is-rate" },
      ]),
    );
    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const rate =
        row.calls > 0 ? Math.round((row.success / row.calls) * 100) : 0;
      const tr = document.createElement("tr");
      tr.className = "tool-stats-tool-row";
      tr.tabIndex = 0;
      tr.setAttribute("role", "button");
      tr.title = `Show invocations for ${row.name}`;
      if (row.name === selectedName) tr.classList.add("is-selected");
      if (row.failure > 0) tr.classList.add("has-fail");

      const name = document.createElement("td");
      name.className = "is-tool";
      const nameInner = document.createElement("code");
      nameInner.className = "tool-stats-tool-name";
      nameInner.textContent = row.name;
      nameInner.title = row.name;
      name.append(nameInner);

      const calls = centerCell(row.calls, "is-calls");
      const success = centerCell(row.success, "is-ok-col");
      success.classList.add("is-ok");
      const failure = centerCell(row.failure, "is-fail-col");
      if (row.failure > 0) failure.classList.add("is-fail");
      const rateTd = centerCell(`${rate}%`, "is-rate");
      if (rate === 100) rateTd.classList.add("is-ok");
      else if (row.failure > 0) rateTd.classList.add("is-fail");

      tr.append(name, calls, success, failure, rateTd);

      const select = () => {
        if (this.selectedName === row.name) return;
        this.selectedName = row.name;
        for (const other of tbody.querySelectorAll(".tool-stats-tool-row")) {
          other.classList.toggle(
            "is-selected",
            other === tr,
          );
        }
        this.toolSelectHandler?.(row.name);
      };
      tr.addEventListener("click", select);
      tr.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
      });

      tbody.append(tr);
    }
    table.append(thead, tbody);
    this.toolsHost.append(table);
  }

  setInvocations(toolName: string, rows: ToolStatsInvocationRow[]): void {
    this.invocationsTitleEl.textContent = toolName
      ? toolName
      : "Invocations";
    this.invocationsCountEl.textContent =
      rows.length === 0 ? "" : `${rows.length}`;
    this.invocationsHost.replaceChildren();

    if (!toolName) {
      this.invocationsHost.append(emptyState("Select a tool on the left."));
      return;
    }
    if (rows.length === 0) {
      this.invocationsHost.append(emptyState("No invocations for this tool."));
      return;
    }

    const table = document.createElement("table");
    table.className = "tool-stats-table tool-stats-table-invocations";
    const thead = document.createElement("thead");
    thead.append(
      headerRow([
        { label: "When", className: "is-center is-time" },
        { label: "Status", className: "is-center is-status" },
        { label: "Reason", className: "is-center is-reason" },
        { label: "ms", className: "is-center is-ms" },
        { label: "Session", className: "is-center is-session" },
      ]),
    );
    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.className = "tool-stats-invocation-row";
      const canExpand = Boolean(row.sceneJson) || row.status !== "success";
      if (canExpand) {
        tr.tabIndex = 0;
        tr.title = "Click to expand scene";
        tr.classList.add("is-expandable");
      }

      const when = document.createElement("td");
      when.className = "is-center is-time";
      when.textContent = formatTime(row.startedAt);
      when.title = new Date(row.startedAt).toLocaleString();

      const status = document.createElement("td");
      status.className = "is-center is-status";
      const badge = document.createElement("span");
      badge.className = `tool-stats-badge is-${sanitizeToken(row.status)}`;
      badge.textContent = row.status;
      status.append(badge);

      const reason = document.createElement("td");
      reason.className = "is-center is-reason";
      reason.textContent = row.reason;
      reason.title =
        row.returnCode != null
          ? `${row.reason} (rc=${row.returnCode})`
          : row.reason;

      const duration = centerCell(row.durationMs, "is-ms");
      const session = document.createElement("td");
      session.className = "is-center is-session";
      session.textContent = shortId(row.sessionId);
      session.title = row.sessionId;

      tr.append(when, status, reason, duration, session);

      const sceneTr = document.createElement("tr");
      sceneTr.className = "tool-stats-scene-row";
      sceneTr.hidden = true;
      const sceneTd = document.createElement("td");
      sceneTd.colSpan = 5;
      const scene = document.createElement("pre");
      scene.className = "tool-stats-failure-scene";
      scene.textContent = formatScene(row.sceneJson);
      sceneTd.append(scene);
      sceneTr.append(sceneTd);

      if (canExpand) {
        const toggle = () => {
          const open = sceneTr.hasAttribute("hidden");
          sceneTr.hidden = !open;
          if (!open) sceneTr.setAttribute("hidden", "");
          else sceneTr.removeAttribute("hidden");
          tr.classList.toggle("is-open", open);
        };
        tr.addEventListener("click", toggle);
        tr.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        });
      }

      tbody.append(tr, sceneTr);
    }
    table.append(thead, tbody);
    this.invocationsHost.append(table);
  }

  setRefreshBusy(busy: boolean): void {
    this.refreshButton.disabled = busy;
    this.refreshButton.classList.toggle("is-busy", busy);
  }

  setResetBusy(busy: boolean): void {
    this.resetButton.disabled = busy;
    this.resetButton.setAttribute("aria-busy", String(busy));
  }

  setResetDisabled(disabled: boolean): void {
    this.resetButton.disabled = disabled;
    this.resetButton.title = disabled
      ? "Reset clears all recorded invocations globally — switch to Global to reset"
      : "Reset all tool stats";
  }

  private renderOverview(totals: {
    calls: number;
    success: number;
    failure: number;
  }): void {
    this.overviewHost.replaceChildren();
    const rate =
      totals.calls > 0
        ? Math.round((totals.success / totals.calls) * 100)
        : null;
    this.overviewHost.append(
      overviewStat("Calls", String(totals.calls), "is-total"),
      overviewStat("Success", String(totals.success), "is-ok"),
      overviewStat(
        "Failure",
        String(totals.failure),
        totals.failure > 0 ? "is-fail" : undefined,
      ),
      overviewStat(
        "Success rate",
        rate == null ? "—" : `${rate}%`,
        rate === 100 ? "is-ok" : undefined,
      ),
    );
  }
}

function filterButton(label: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tool-stats-filter-button";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-pressed", "false");
  return button;
}

function overviewStat(
  label: string,
  value: string,
  tone?: string,
): HTMLElement {
  const el = document.createElement("div");
  el.className = "tool-stats-overview-stat";
  if (tone) el.classList.add(tone);
  const valueEl = document.createElement("div");
  valueEl.className = "tool-stats-overview-value";
  valueEl.textContent = value;
  const labelEl = document.createElement("div");
  labelEl.className = "tool-stats-overview-label";
  labelEl.textContent = label;
  el.append(valueEl, labelEl);
  return el;
}

function emptyState(text: string): HTMLElement {
  const empty = document.createElement("div");
  empty.className = "tool-stats-empty";
  empty.textContent = text;
  return empty;
}

function headerRow(
  cols: Array<{ label: string; className?: string }>,
): HTMLTableRowElement {
  const tr = document.createElement("tr");
  for (const col of cols) {
    const th = document.createElement("th");
    if (col.className) th.className = col.className;
    th.textContent = col.label;
    tr.append(th);
  }
  return tr;
}

function centerCell(
  value: string | number,
  extraClass?: string,
): HTMLTableCellElement {
  const td = document.createElement("td");
  td.className = extraClass ? `is-center ${extraClass}` : "is-center";
  td.textContent = String(value);
  return td;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

function sanitizeToken(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "other";
}

function formatScene(sceneJson: string | undefined): string {
  if (!sceneJson) return "(No scene captured.)";
  try {
    return JSON.stringify(JSON.parse(sceneJson), null, 2);
  } catch {
    return sceneJson;
  }
}
