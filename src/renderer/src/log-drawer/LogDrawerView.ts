/* Detail panes draw the original Lucide artwork (ui/originalIcons), not the
 * re-drawn shell set — Timeline's export and Tool Stats' reset buttons set
 * that precedent, so the toolbar glyphs stay in the same stroke language. */
import {
  Braces,
  createLucideIcon,
  Download,
  Filter,
  Folder,
  Trash2,
} from "../ui/originalIcons.js";
import { AppDropdown } from "../ui/appDropdown.js";
import "./log-drawer.css";

export type LogDrawerLine = {
  id: string;
  ts: number;
  level: string;
  source: string;
  message: string;
};

export type LogDrawerMetrics = {
  cpuPercent: number;
  memoryMB: number;
};

export type LogLevelName = "debug" | "info" | "warn" | "error";
export type LogSourceFilter = "all" | "main" | "renderer";

const LOG_LEVELS: readonly LogLevelName[] = [
  "debug",
  "info",
  "warn",
  "error",
] as const;

/**
 * Presentation for the bottom Log drawer: one toolbar row (process metrics,
 * level chips, source filter, keyword, actions) above the log list. The row
 * stays a single line and sheds its lowest-priority items as the pane narrows
 * (see the container queries in log-drawer.css) instead of wrapping.
 */
export class LogDrawerView {
  readonly root: HTMLElement;
  readonly clearButton: HTMLButtonElement;
  readonly saveButton: HTMLButtonElement;
  readonly openFolderButton: HTMLButtonElement;
  readonly sourceDropdown: AppDropdown;
  readonly keywordInput: HTMLInputElement;
  readonly fullRequestButton: HTMLButtonElement;
  readonly levelButtons: Record<LogLevelName, HTMLButtonElement>;
  private readonly cpuValue: HTMLElement;
  private readonly memoryValue: HTMLElement;
  private readonly list: HTMLElement;
  private stickToBottom = true;

  constructor() {
    this.root = document.createElement("section");
    this.root.className = "log-drawer";
    this.root.setAttribute("aria-label", "Logs");

    const toolbar = document.createElement("div");
    toolbar.className = "log-drawer-toolbar";

    // Metrics sit first: they are read-only, so the eye lands on them before
    // the controls it has to hunt for.
    const metrics = document.createElement("div");
    metrics.className = "log-drawer-metrics";

    const cpu = document.createElement("div");
    cpu.className = "log-drawer-metric";
    const cpuLabel = document.createElement("span");
    cpuLabel.className = "log-drawer-metric-label";
    cpuLabel.textContent = "CPU";
    this.cpuValue = document.createElement("span");
    this.cpuValue.className = "log-drawer-metric-value";
    this.cpuValue.textContent = "—";
    cpu.append(cpuLabel, this.cpuValue);

    const memory = document.createElement("div");
    memory.className = "log-drawer-metric";
    const memoryLabel = document.createElement("span");
    memoryLabel.className = "log-drawer-metric-label";
    memoryLabel.textContent = "MEM";
    this.memoryValue = document.createElement("span");
    this.memoryValue.className = "log-drawer-metric-value";
    this.memoryValue.textContent = "—";
    memory.append(memoryLabel, this.memoryValue);

    metrics.append(cpu, memory);

    const divider = document.createElement("span");
    divider.className = "log-drawer-divider";
    divider.setAttribute("aria-hidden", "true");

    const levelGroup = document.createElement("div");
    levelGroup.className = "log-drawer-level-toggles";
    levelGroup.setAttribute("role", "group");
    levelGroup.setAttribute("aria-label", "Levels");

    this.levelButtons = {} as Record<LogLevelName, HTMLButtonElement>;
    for (const level of LOG_LEVELS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `log-drawer-level-toggle level-${level} is-on`;
      button.dataset.level = level;
      button.setAttribute("aria-pressed", "true");
      button.title = `Toggle ${level}`;
      button.textContent = level;
      this.levelButtons[level] = button;
      levelGroup.append(button);
    }

    this.sourceDropdown = new AppDropdown(
      [
        { value: "all", label: "All" },
        { value: "main", label: "Main" },
        { value: "renderer", label: "Renderer" },
      ],
      "all",
      { leadingIcon: Filter, className: "log-drawer-source-filter" },
    );
    this.sourceDropdown.el.title = "Source";
    this.sourceDropdown.el
      .querySelector("button")
      ?.setAttribute("aria-label", "Source");

    this.keywordInput = document.createElement("input");
    this.keywordInput.type = "search";
    this.keywordInput.className = "log-drawer-filter-input";
    this.keywordInput.placeholder = "Filter keyword";
    this.keywordInput.setAttribute("aria-label", "Filter keyword");
    this.keywordInput.autocomplete = "off";
    this.keywordInput.spellcheck = false;

    this.fullRequestButton = createIconButton({
      className: "log-drawer-icon-btn log-drawer-full-request-toggle",
      label: "Full request",
      title:
        "Write full LLM request bodies to logs/llm-requests-YYYY-MM-DD.jsonl (process only)",
      icon: Braces,
    });
    this.fullRequestButton.setAttribute("aria-pressed", "false");

    const actions = document.createElement("div");
    actions.className = "log-drawer-actions";

    this.saveButton = createIconButton({
      className: "log-drawer-icon-btn",
      label: "Save logs",
      title: "Save logs to file",
      icon: Download,
    });
    this.openFolderButton = createIconButton({
      className: "log-drawer-icon-btn",
      label: "Open log folder",
      title: "Open log folder",
      icon: Folder,
    });
    this.clearButton = createIconButton({
      className: "log-drawer-icon-btn log-drawer-icon-btn-danger",
      label: "Clear logs",
      title: "Clear logs",
      icon: Trash2,
    });
    actions.append(
      this.saveButton,
      this.openFolderButton,
      this.clearButton,
    );

    toolbar.append(
      metrics,
      divider,
      levelGroup,
      this.sourceDropdown.el,
      this.keywordInput,
      this.fullRequestButton,
      actions,
    );

    this.list = document.createElement("div");
    this.list.className = "log-drawer-list";
    this.list.setAttribute("role", "log");
    this.list.addEventListener("scroll", () => {
      const distance =
        this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight;
      this.stickToBottom = distance < 40;
    });

    this.root.append(toolbar, this.list);
  }

  setLevelEnabled(level: LogLevelName, enabled: boolean): void {
    const button = this.levelButtons[level];
    button.classList.toggle("is-on", enabled);
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
  }

  setFullRequestEnabled(enabled: boolean): void {
    this.fullRequestButton.classList.toggle("is-on", enabled);
    this.fullRequestButton.setAttribute(
      "aria-pressed",
      enabled ? "true" : "false",
    );
  }

  getSourceFilter(): LogSourceFilter {
    return this.sourceDropdown.value as LogSourceFilter;
  }

  getKeyword(): string {
    return this.keywordInput.value;
  }

  setMetrics(metrics: LogDrawerMetrics): void {
    this.cpuValue.textContent = `${Math.round(metrics.cpuPercent)}%`;
    this.memoryValue.textContent = `${formatMemoryMb(metrics.memoryMB)} MB`;
  }

  setSaveBusy(busy: boolean): void {
    this.saveButton.disabled = busy;
    this.saveButton.setAttribute("aria-busy", String(busy));
  }

  setEntries(entries: LogDrawerLine[]): void {
    this.list.replaceChildren();
    for (const entry of entries) {
      this.list.append(this.createRow(entry));
    }
    this.scrollIfNeeded();
  }

  appendEntry(entry: LogDrawerLine): void {
    this.list.append(this.createRow(entry));
    this.scrollIfNeeded();
  }

  clearEntries(): void {
    this.list.replaceChildren();
    this.stickToBottom = true;
  }

  private createRow(entry: LogDrawerLine): HTMLElement {
    const row = document.createElement("div");
    row.className = `log-drawer-row level-${entry.level}`;
    row.dataset.id = entry.id;

    const time = document.createElement("span");
    time.className = "log-drawer-time";
    time.textContent = formatTime(entry.ts);

    const level = document.createElement("span");
    level.className = "log-drawer-level";
    level.textContent = entry.level;

    const source = document.createElement("span");
    source.className = "log-drawer-source";
    source.textContent = entry.source;

    const message = document.createElement("span");
    message.className = "log-drawer-message";
    message.textContent = entry.message;

    row.append(time, level, source, message);
    return row;
  }

  private scrollIfNeeded(): void {
    if (!this.stickToBottom) return;
    this.list.scrollTop = this.list.scrollHeight;
  }
}

export { LOG_LEVELS };

type IconButtonOptions = {
  className: string;
  label: string;
  title: string;
  icon: Parameters<typeof createLucideIcon>[0];
};

function createIconButton(opts: IconButtonOptions): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = opts.className;
  button.setAttribute("aria-label", opts.label);
  button.title = opts.title;
  button.append(createLucideIcon(opts.icon, { size: 14 }));
  return button;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatMemoryMb(mb: number): string {
  if (!Number.isFinite(mb)) return "—";
  if (mb >= 100) return String(Math.round(mb));
  return mb.toFixed(1);
}
