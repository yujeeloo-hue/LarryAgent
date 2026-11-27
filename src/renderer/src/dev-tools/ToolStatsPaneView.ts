import {
  ChartLine, ChevronDown, ChevronUp, ChevronsUpDown, List,
  RefreshCw, Trash2, createLucideIcon,
} from "../ui/originalIcons.js";
import {
  buildChartModel,
  revisionLabel,
  type ToolStatsChartModel,
  type ToolStatsChartPoint,
  type ToolStatsDayRow,
} from "./toolStatsChart.js";
import "./tool-stats.css";

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
  docRevision?: number;
};

export type ToolStatsScope = "session" | "global";
export type ToolStatsViewMode = "list" | "chart";
type ToolStatsSortKey = "name" | "calls" | "failure" | "rate";
let nextSceneId = 0;
let nextChartId = 0;

export class ToolStatsPaneView {
  readonly root: HTMLElement;
  readonly refreshButton: HTMLButtonElement;
  readonly resetButton: HTMLButtonElement;
  readonly filterSessionButton: HTMLButtonElement;
  readonly filterGlobalButton: HTMLButtonElement;
  readonly listViewButton: HTMLButtonElement;
  readonly chartViewButton: HTMLButtonElement;
  private readonly overviewHost: HTMLElement;
  private readonly toolsHost: HTMLElement;
  private readonly invocationsHost: HTMLElement;
  private readonly invocationsSection: HTMLElement;
  private readonly invocationsMeta: HTMLElement;
  private readonly legendHost: HTMLElement;
  private readonly noticeEl: HTMLElement;
  private toolSelectHandler: ((name: string) => void) | undefined;
  private filterChangeHandler:
    | ((scope: ToolStatsScope) => void)
    | undefined;
  private viewModeHandler: ((mode: ToolStatsViewMode) => void) | undefined;
  private selectedName = "";
  private scope: ToolStatsScope = "global";
  private viewMode: ToolStatsViewMode = "list";
  private invocationToolName = "";
  private invocationRows: ToolStatsInvocationRow[] = [];
  private chartModel: ToolStatsChartModel = emptyChartModel();
  private chartObserver: ResizeObserver | undefined;
  private chartTip: HTMLElement | undefined;
  private toolsRows: ToolStatsSummaryRow[] = [];
  private sortKey: ToolStatsSortKey = "calls";
  private sortDirection: "asc" | "desc" = "desc";


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
      "Current task",
      "Only the focused conversation (and its subagents)",
    );
    this.filterGlobalButton = filterButton(
      "Global",
      "Every recorded invocation across all tasks",
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

    this.resetButton = document.createElement("button");
    this.resetButton.type = "button";
    this.resetButton.className = "tool-stats-reset";
    this.resetButton.title = "Reset all tool stats";
    this.resetButton.setAttribute("aria-label", "Reset all tool stats");
    this.resetButton.append(createLucideIcon(Trash2, { size: 14 }));

    this.overviewHost = document.createElement("div");
    this.overviewHost.className = "tool-stats-overview";

    const body = document.createElement("div");
    body.className = "tool-stats-body";

    const columns = document.createElement("div");
    columns.className = "tool-stats-columns";

    const toolsSection = document.createElement("section");
    toolsSection.className = "tool-stats-section tool-stats-section-tools";
    toolsSection.setAttribute("aria-label", "Tools");
    this.toolsHost = document.createElement("div");
    this.toolsHost.className = "tool-stats-table-wrap";
    toolsSection.append(this.toolsHost);

    this.invocationsSection = document.createElement("section");
    this.invocationsSection.className =
      "tool-stats-section tool-stats-section-invocations";
    this.invocationsSection.setAttribute("aria-label", "Invocations");

    const invocationsHead = document.createElement("div");
    invocationsHead.className = "tool-stats-section-head";
    this.invocationsMeta = document.createElement("div");
    this.invocationsMeta.className = "tool-stats-section-meta";
    this.legendHost = document.createElement("div");
    this.legendHost.className = "tool-stats-legend";
    this.legendHost.hidden = true;
    this.listViewButton = viewToggleButton(List, "List");
    this.chartViewButton = viewToggleButton(ChartLine, "Daily success rate");
    const viewToggle = document.createElement("div");
    viewToggle.className = "tool-stats-view-toggle";
    viewToggle.setAttribute("role", "group");
    viewToggle.setAttribute("aria-label", "Invocation view");
    viewToggle.append(this.listViewButton, this.chartViewButton);
    invocationsHead.append(this.invocationsMeta, this.legendHost, viewToggle);
    this.listViewButton.addEventListener("click", () => this.setViewMode("list"));
    this.chartViewButton.addEventListener("click", () =>
      this.setViewMode("chart"),
    );

    this.invocationsHost = document.createElement("div");
    this.invocationsHost.className = "tool-stats-table-wrap";
    this.invocationsSection.append(invocationsHead, this.invocationsHost);
    toolbar.append(this.overviewHost, this.refreshButton, this.resetButton);

    columns.append(toolsSection, this.invocationsSection);
    this.noticeEl = document.createElement("div");
    this.noticeEl.className = "tool-stats-notice";
    this.noticeEl.hidden = true;
    body.append(this.noticeEl, columns);
    this.root.append(toolbar, body);
    this.renderScope();
  }

  setRecordingDisabled(disabled: boolean): void {
    this.noticeEl.hidden = !disabled;
    this.noticeEl.textContent = disabled
      ? "Recording disabled · Settings → Agent → Tool call stats"
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
    this.toolsRows = rows;
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
    table.setAttribute("aria-label", "Tool statistics");
    const thead = document.createElement("thead");
    const headings = document.createElement("tr");
    for (const [key, label, className] of [
      ["name", `Tool · ${rows.length}`, "is-tool"],
      ["calls", "Calls", "is-center is-calls"],
      ["failure", "Fail", "is-center is-fail-col"],
      ["rate", "Rate", "is-center is-rate"],
    ] as const) {
      const th = document.createElement("th");
      th.className = className;
      th.scope = "col";
      th.dataset.sortKey = key;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tool-stats-sort-button";
      button.dataset.label = label;
      const text = document.createElement("span");
      text.textContent = label;
      const icon = document.createElement("span");
      icon.className = "tool-stats-sort-icon";
      icon.setAttribute("aria-hidden", "true");
      button.append(text, icon);
      button.addEventListener("click", () => {
        this.sortDirection = this.sortKey === key
          ? (this.sortDirection === "asc" ? "desc" : "asc")
          : key === "name" ? "asc" : "desc";
        this.sortKey = key;
        this.applyToolSort();
      });
      th.append(button);
      headings.append(th);
    }
    thead.append(headings);
    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const rate =
        row.calls > 0 ? Math.round((row.success / row.calls) * 100) : 0;
      const tr = document.createElement("tr");
      tr.className = "tool-stats-tool-row";
      tr.dataset.toolName = row.name;
      tr.tabIndex = 0;
      tr.setAttribute("role", "button");
      tr.setAttribute("aria-pressed", String(row.name === selectedName));
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
      const failure = centerCell(row.failure, "is-fail-col");
      if (row.failure > 0) failure.classList.add("is-fail");
      const rateTd = centerCell(`${rate}%`, "is-rate");
      if (rate === 100) rateTd.classList.add("is-ok");
      else if (row.failure > 0) rateTd.classList.add("is-fail");

      tr.append(name, calls, failure, rateTd);

      const select = () => {
        if (this.selectedName === row.name) return;
        this.selectedName = row.name;
        for (const other of tbody.querySelectorAll(".tool-stats-tool-row")) {
          other.classList.toggle(
            "is-selected",
            other === tr,
          );
          other.setAttribute("aria-pressed", String(other === tr));
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
    this.applyToolSort();
  }

  private applyToolSort(): void {
    const table = this.toolsHost.querySelector("table");
    if (!table) return;
    const value = (row: ToolStatsSummaryRow): number => this.sortKey === "rate"
      ? (row.calls > 0 ? row.success / row.calls : 0)
      : this.sortKey === "failure" ? row.failure : row.calls;
    const direction = this.sortDirection === "asc" ? 1 : -1;
    const sorted = [...this.toolsRows].sort((a, b) => {
      const delta = this.sortKey === "name"
        ? a.name.localeCompare(b.name) : value(a) - value(b);
      return delta * direction || a.name.localeCompare(b.name);
    });
    const tbody = table.querySelector("tbody")!;
    const elements = new Map(Array.from(
      tbody.querySelectorAll<HTMLTableRowElement>("tr"),
      row => [row.dataset.toolName, row],
    ));
    for (const row of sorted) {
      const element = elements.get(row.name);
      if (element) tbody.append(element);
    }
    for (const th of table.querySelectorAll<HTMLElement>("th[data-sort-key]")) {
      const key = th.dataset.sortKey;
      const active = key === this.sortKey;
      th.setAttribute("aria-sort", active
        ? (this.sortDirection === "asc" ? "ascending" : "descending") : "none");
      const button = th.querySelector("button")!;
      const next = active ? (this.sortDirection === "asc" ? "descending" : "ascending")
        : key === "name" ? "ascending" : "descending";
      button.title = `${button.dataset.label}: sort ${next}`;
      button.setAttribute("aria-label", button.title);
      th.querySelector(".tool-stats-sort-icon")!.replaceChildren(createLucideIcon(
        active ? (this.sortDirection === "asc" ? ChevronUp : ChevronDown) : ChevronsUpDown,
        { size: 10 },
      ));
    }
  }

  getViewMode(): ToolStatsViewMode {
    return this.viewMode;
  }

  setViewMode(mode: ToolStatsViewMode): void {
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    this.renderInvocations();
    this.viewModeHandler?.(mode);
  }

  onViewModeChange(handler: (mode: ToolStatsViewMode) => void): void {
    this.viewModeHandler = handler;
  }

  setInvocations(
    toolName: string,
    rows: ToolStatsInvocationRow[],
    daily: ToolStatsDayRow[] = [],
  ): void {
    this.invocationToolName = toolName;
    this.invocationRows = rows;
    this.chartModel = buildChartModel(daily);
    this.renderInvocations();
  }

  private renderInvocations(): void {
    this.chartObserver?.disconnect();
    this.chartObserver = undefined;
    this.chartTip?.remove();
    this.chartTip = undefined;
    const toolName = this.invocationToolName;
    this.invocationsSection.setAttribute(
      "aria-label",
      toolName ? `${toolName} invocations` : "Invocations",
    );
    for (const [button, mode] of [
      [this.listViewButton, "list"],
      [this.chartViewButton, "chart"],
    ] as const) {
      const active = this.viewMode === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    this.invocationsHost.replaceChildren();

    if (!toolName) {
      this.invocationsMeta.textContent = "";
      this.renderLegend();
      this.invocationsHost.append(emptyState("Select a tool on the left."));
      return;
    }
    if (this.viewMode === "chart") {
      this.renderChart(toolName);
      return;
    }
    this.invocationsMeta.textContent = "";
    this.renderLegend();
    this.renderInvocationList(toolName, this.invocationRows);
  }

  private renderInvocationList(
    toolName: string,
    rows: ToolStatsInvocationRow[],
  ): void {
    if (rows.length === 0) {
      this.invocationsHost.append(emptyState("No invocations for this tool."));
      return;
    }

    const table = document.createElement("table");
    table.className = "tool-stats-table tool-stats-table-invocations";
    table.setAttribute("aria-label", `${toolName} invocations`);
    const thead = document.createElement("thead");
    thead.append(
      headerRow([
        { label: "When", className: "is-center is-time" },
        { label: "Status", className: "is-center is-status" },
        { label: "Rev", className: "is-center is-rev" },
        { label: "Reason", className: "is-center is-reason" },
        { label: "ms", className: "is-center is-ms" },
        { label: "Task", className: "is-center is-session" },
        { label: "", className: "is-details", ariaLabel: "Details" },
      ]),
    );
    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.className = "tool-stats-invocation-row";
      const canExpand = Boolean(row.sceneJson) || row.status !== "success";

      const when = document.createElement("td");
      when.className = "is-center is-time";
      when.textContent = formatWhen(row.startedAt);
      when.title = new Date(row.startedAt).toLocaleString();

      const status = document.createElement("td");
      status.className = "is-center is-status";
      const badge = document.createElement("span");
      badge.className = `tool-stats-badge is-${sanitizeToken(row.status)}`;
      badge.textContent = row.status;
      badge.title = `${row.status}: ${row.reason}${row.returnCode != null ? ` (rc=${row.returnCode})` : ""}`;
      status.append(badge);

      const revision = centerCell(revisionLabel(row.docRevision ?? 0), "is-rev");
      revision.title =
        "Tool description revision: r0 = the code-built-in wording";

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

      tr.append(when, status, revision, reason, duration, session);

      const details = document.createElement("td");
      details.className = "is-details";
      tr.append(details);
      tbody.append(tr);
      if (!canExpand) continue;

      const sceneTr = document.createElement("tr");
      sceneTr.className = "tool-stats-scene-row";
      sceneTr.id = `tool-stats-scene-${++nextSceneId}`;
      sceneTr.hidden = true;
      const sceneTd = document.createElement("td");
      sceneTd.colSpan = 7;
      const scene = document.createElement("pre");
      scene.className = "tool-stats-failure-scene";
      scene.textContent = formatScene(row.sceneJson);
      sceneTd.append(scene);
      sceneTr.append(sceneTd);

      const expand = document.createElement("button");
      expand.type = "button";
      expand.className = "tool-stats-expand-button";
      expand.setAttribute("aria-controls", sceneTr.id);
      const update = () => {
        const open = !sceneTr.hidden;
        expand.setAttribute("aria-expanded", String(open));
        expand.title = open ? "Collapse details" : "Expand details";
        expand.setAttribute("aria-label", expand.title);
        expand.replaceChildren(createLucideIcon(open ? ChevronUp : ChevronDown, { size: 12 }));
        tr.classList.toggle("is-open", open);
      };
      expand.addEventListener("click", () => {
        sceneTr.hidden = !sceneTr.hidden;
        update();
      });
      update();
      details.append(expand);
      tbody.append(sceneTr);
    }
    table.append(thead, tbody);
    this.invocationsHost.append(table);
  }

  private renderChart(toolName: string): void {
    const totals = this.chartModel.totals;
    this.invocationsMeta.textContent =
      `${toolName} · ${totals.calls} calls · ${formatRate(totals.rate)}`;
    this.renderLegend();
    if (this.chartModel.days.length === 0) {
      this.invocationsHost.append(emptyState("No invocations in this range."));
      return;
    }

    const host = document.createElement("div");
    host.className = "tool-stats-chart";
    this.invocationsHost.append(host);
    const draw = (): void => {
      this.drawChart(host, this.chartModel);
    };
    draw();
    if (typeof ResizeObserver !== "undefined") {
      this.chartObserver = new ResizeObserver(() => draw());
      this.chartObserver.observe(host);
    }
  }

  private renderLegend(): void {
    this.legendHost.replaceChildren();
    const show = this.viewMode === "chart" && this.chartModel.series.length > 1;
    this.legendHost.hidden = !show;
    if (!show) return;
    this.chartModel.series.forEach((series, index) => {
      const chip = document.createElement("span");
      chip.className = `tool-stats-legend-chip s${seriesBucket(index)}`;
      chip.title =
        `${series.label} · ${series.totals.calls} calls · ${formatRate(series.totals.rate)}`;
      const dot = document.createElement("i");
      dot.className = "tool-stats-legend-dot";
      const label = document.createElement("span");
      label.textContent = series.label;
      chip.append(dot, label);
      this.legendHost.append(chip);
    });
  }

  private drawChart(host: HTMLElement, model: ToolStatsChartModel): void {
    const width = host.clientWidth;
    const height = host.clientHeight;
    host.replaceChildren();
    if (width < 60 || height < 60) return;

    const layer = document.createElement("div");
    layer.className = "tool-stats-chart-layer";
    host.append(layer);

    const svg = svgNode("svg", {
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
    });
    layer.append(svg);

    const { top, right, bottom, left } = CHART_PADDING;
    const plotW = Math.max(10, width - left - right);
    const plotH = Math.max(10, height - top - bottom);
    const count = model.days.length;
    const slot = plotW / Math.max(1, count);
    const yOf = (rate: number): number => top + plotH * (1 - rate);
    const xOf = (index: number): number => count === 1
      ? left + plotW / 2
      : left + slot * (index + 0.5);

    for (const rate of [0, 0.25, 0.5, 0.75, 1]) {
      const y = yOf(rate);
      svg.append(svgNode("line", {
        class: `grid${rate === 0 ? " is-base" : ""}`,
        x1: left,
        x2: left + plotW,
        y1: y.toFixed(2),
        y2: y.toFixed(2),
      }));
    }
    for (const rate of [0, 0.5, 1]) {
      svg.append(svgNode("text", {
        class: "axis-label",
        x: left - 6,
        y: (yOf(rate) + 3.5).toFixed(2),
        "text-anchor": "end",
      }, `${Math.round(rate * 100)}%`));
    }

    const labelStride = Math.max(
      1,
      Math.ceil(count / Math.max(2, Math.floor(plotW / 46))),
    );
    model.labels.forEach((label, index) => {
      const isLast = index === count - 1;
      if (!isLast && index % labelStride !== 0) return;
      svg.append(svgNode("text", {
        class: `day-label${isLast ? " is-edge" : ""}`,
        x: xOf(index).toFixed(2),
        y: (top + plotH + 14).toFixed(2),
        "text-anchor": "middle",
      }, label));
    });

    const multi = model.series.length > 1;
    let gradientId = "";
    if (!multi) {
      gradientId = `tool-stats-rate-area-${++nextChartId}`;
      const defs = svgNode("defs", {});
      const gradient = svgNode("linearGradient", {
        id: gradientId,
        x1: "0",
        y1: "0",
        x2: "0",
        y2: "1",
      });
      for (const [offset, opacity] of [[0, 0.24], [1, 0]] as const) {
        gradient.append(svgNode("stop", {
          offset: String(offset),
          "stop-color": "var(--accent)",
          "stop-opacity": String(opacity),
        }));
      }
      defs.append(gradient);
      svg.append(defs);
    }
    const baseY = (top + plotH).toFixed(2);
    model.series.forEach((series, seriesIndex) => {
      const bucket = seriesBucket(seriesIndex);
      const runs = lineRuns(series.points, xOf, yOf);
      if (!multi) {
        for (const segment of runs) {
          const first = segment[0]!;
          const last = segment[segment.length - 1]!;
          const d = [
            `M ${first.x.toFixed(2)} ${baseY}`,
            ...segment.map((p) => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`),
            `L ${last.x.toFixed(2)} ${baseY}`,
            "Z",
          ].join(" ");
          svg.append(svgNode("path", {
            class: "series-area",
            d,
            fill: `url(#${gradientId})`,
          }));
        }
      }
      for (const segment of runs) {
        svg.append(svgNode("path", {
          class: `series-line s${bucket}`,
          d: segment
            .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
            .join(" "),
        }));
      }
      series.points.forEach((point, index) => {
        if (point.rate == null) return;
        svg.append(svgNode("circle", {
          class: `series-dot s${bucket}`,
          cx: xOf(index).toFixed(2),
          cy: yOf(point.rate).toFixed(2),
          r: count > 24 ? "1.8" : "2.4",
        }));
      });
    });

    model.days.forEach((_day, index) => {
      const calls = model.series.reduce(
        (sum, series) => sum + (series.points[index]?.calls ?? 0),
        0,
      );
      if (calls > 0) return;
      svg.append(svgNode("circle", {
        class: "zero-mark",
        cx: xOf(index).toFixed(2),
        cy: (top + plotH - 2).toFixed(2),
        r: "1.4",
      }));
    });

    const guide = svgNode("line", {
      class: "hover-guide",
      y1: top,
      y2: top + plotH,
      visibility: "hidden",
    });
    const hoverDots = model.series.map((_series, seriesIndex) => svgNode("circle", {
      class: `hover-dot s${seriesBucket(seriesIndex)}`,
      r: "3",
      visibility: "hidden",
    }));
    const overlay = svgNode("rect", {
      x: left,
      y: top,
      width: plotW,
      height: plotH,
      fill: "transparent",
    });
    svg.append(guide, ...hoverDots, overlay);

    this.chartTip?.remove();
    const tip = document.createElement("div");
    tip.className = "tool-stats-chart-tip";
    tip.setAttribute("popover", "manual");
    tip.setAttribute("role", "tooltip");
    this.chartTip = tip;
    const popoverTip = tip as HTMLElement & {
      showPopover?: () => void;
      hidePopover?: () => void;
    };
    (document.body ?? layer).append(tip);
    let tipOpen = false;
    const showTip = (): void => {
      tip.classList.add("is-visible");
      if (tipOpen || typeof popoverTip.showPopover !== "function") return;
      popoverTip.showPopover();
      tipOpen = true;
    };
    const hideTip = (): void => {
      tip.classList.remove("is-visible");
      if (!tipOpen) return;
      popoverTip.hidePopover?.();
      tipOpen = false;
    };

    overlay.addEventListener("mousemove", (event) => {
      const box = svg.getBoundingClientRect();
      const x = event.clientX - box.left;
      const index = Math.max(
        0,
        Math.min(count - 1, Math.floor((x - left) / slot)),
      );
      const cx = xOf(index);
      guide.setAttribute("x1", cx.toFixed(2));
      guide.setAttribute("x2", cx.toFixed(2));
      guide.setAttribute("visibility", "visible");
      let anchorY = top + plotH - 6;
      hoverDots.forEach((dot, seriesIndex) => {
        const point = model.series[seriesIndex]!.points[index]!;
        if (point.rate == null) {
          dot.setAttribute("visibility", "hidden");
          return;
        }
        const cy = yOf(point.rate);
        anchorY = Math.min(anchorY, cy);
        dot.setAttribute("cx", cx.toFixed(2));
        dot.setAttribute("cy", cy.toFixed(2));
        dot.setAttribute("visibility", "visible");
      });
      tip.replaceChildren();
      const title = document.createElement("b");
      title.textContent = model.labels[index]!;
      tip.append(title);
      model.series.forEach((series, seriesIndex) => {
        const point = series.points[index]!;
        const row = document.createElement("div");
        row.className = multi
          ? `tool-stats-chart-tip-row s${seriesBucket(seriesIndex)}`
          : "tool-stats-chart-tip-row";
        if (multi) {
          const name = document.createElement("b");
          name.textContent = series.label;
          row.append(name);
        }
        if (point.calls > 0) {
          row.append(
            spanText("tip-rate", formatRate(point.rate)),
            spanText(
              "tip-sub",
              `${point.success} ok · ${point.failure} failed · ${point.calls} calls`,
            ),
          );
        } else {
          row.append(spanText("tip-sub", "no calls"));
        }
        tip.append(row);
      });
      const viewWidth = window.innerWidth || width;
      tip.style.left = `${Math.max(58, Math.min(viewWidth - 58, box.left + cx))}px`;
      tip.style.top = `${box.top + anchorY - 10}px`;
      showTip();
    });
    overlay.addEventListener("mouseleave", () => {
      guide.setAttribute("visibility", "hidden");
      for (const dot of hoverDots) dot.setAttribute("visibility", "hidden");
      hideTip();
    });
  }

  destroy(): void {
    this.chartObserver?.disconnect();
    this.chartObserver = undefined;
    this.chartTip?.remove();
    this.chartTip = undefined;
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
      overviewStat("calls", String(totals.calls)),
      overviewStat(
        "failed",
        String(totals.failure),
        totals.failure > 0 ? "is-fail" : undefined,
      ),
      overviewStat(
        "success",
        rate == null ? "—" : `${rate}%`,
      ),
    );
  }
}

const CHART_PADDING = { top: 12, right: 14, bottom: 24, left: 34 } as const;
const SERIES_BUCKETS = 6;

function seriesBucket(index: number): number {
  return (index % SERIES_BUCKETS) + 1;
}

function emptyChartModel(): ToolStatsChartModel {
  return {
    days: [],
    labels: [],
    series: [],
    totals: { calls: 0, success: 0, failure: 0, rate: null },
  };
}

function lineRuns(
  points: ToolStatsChartPoint[],
  xOf: (index: number) => number,
  yOf: (rate: number) => number,
): Array<Array<{ x: number; y: number }>> {
  const runs: Array<Array<{ x: number; y: number }>> = [];
  let run: Array<{ x: number; y: number }> = [];
  points.forEach((point, index) => {
    if (point.rate == null) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push({ x: xOf(index), y: yOf(point.rate) });
  });
  if (run.length) runs.push(run);
  return runs;
}

function viewToggleButton(
  icon: Parameters<typeof createLucideIcon>[0],
  label: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(createLucideIcon(icon, { size: 14 }));
  return button;
}

function formatRate(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

function spanText(className: string, text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

function svgNode(
  tag: string,
  attrs: Record<string, string | number>,
  text?: string,
): SVGElement {
  const node = document.createElementNS(
    "http://www.w3.org/2000/svg",
    tag,
  ) as SVGElement;
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  if (text !== undefined) node.textContent = text;
  return node;
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
  cols: Array<{ label: string; className?: string; ariaLabel?: string }>,
): HTMLTableRowElement {
  const tr = document.createElement("tr");
  for (const col of cols) {
    const th = document.createElement("th");
    th.scope = "col";
    if (col.ariaLabel) th.setAttribute("aria-label", col.ariaLabel);
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

function formatWhen(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${date} ${clock}`;
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
