import {
  BrushCleaning,
  Check,
  Copy,
  createLucideIcon,
} from "../ui/originalIcons.js";
import { paneHeadIcon } from "./paneHeadIcons.js";
import { measureMono, visualColumns, wrappedRows, type MonoMetrics } from "./monoMetrics.js";
import { VirtualList } from "./virtualList.js";

const INSET_TOP = 5;
const INSET_BOTTOM = 12;
const TIME_COLUMNS = 12;
const ROW_CHROME_PX = 6 + 14 + 7 * 2;
const ROW_PADDING_Y = 2;
const FALLBACK_METRICS: MonoMetrics = { charWidth: 7, lineHeight: 17.25 };

export type DebugConsoleRow = {
  timestamp: number;
  direction: "send" | "receive" | "error";
  text: string;
};

export class DebugConsoleView {
  readonly root = document.createElement("div");
  readonly filterInput = document.createElement("input");
  readonly copyButton = this.iconButton("Copy all", Copy);
  readonly clearButton = this.iconButton("Clear output", BrushCleaning);
  private readonly count = document.createElement("span");
  private readonly output = document.createElement("div");
  private readonly empty = document.createElement("div");
  private readonly list: VirtualList;
  private readonly columns = new WeakMap<DebugConsoleRow, number>();
  private data: DebugConsoleRow[] = [];
  private ids: number[] = [];
  private nextId = 1;
  private metrics = FALLBACK_METRICS;
  private copyFlash: ReturnType<typeof setTimeout> | null = null;
  private readonly copyIdleTitle = "Copy all";

  onFilterChange: ((value: string) => void) | null = null;
  onCopy: (() => void) | null = null;
  onClear: (() => void) | null = null;

  constructor() {
    this.root.className = "devmode-debug-console";

    const toolbar = document.createElement("div");
    toolbar.className = "devmode-debug-console-toolbar";
    this.filterInput.type = "search";
    this.filterInput.placeholder = "Filter debug output…";
    this.filterInput.setAttribute("aria-label", "Filter Debug Console");
    this.filterInput.addEventListener("input", () => {
      this.onFilterChange?.(this.filterInput.value);
    });
    this.count.className = "devmode-debug-console-count";
    this.copyButton.addEventListener("click", () => this.onCopy?.());
    this.clearButton.addEventListener("click", () => this.onClear?.());
    toolbar.append(
      this.filterInput,
      this.count,
      this.copyButton,
      this.clearButton,
    );

    this.output.className = "devmode-debug-console-output";
    this.output.setAttribute("role", "log");
    this.output.setAttribute("aria-live", "off");
    this.empty.className = "devmode-debug-console-empty";
    this.output.append(this.empty);
    this.root.append(toolbar, this.output);
    this.list = new VirtualList(this.output, {
      count: () => this.data.length,
      key: (i) => this.ids[i],
      type: () => "row",
      create: () => this.createRow(),
      bind: (el, i) => this.bindRow(el, this.data[i]!),
      estimate: (i, width) => this.estimate(this.data[i]!, width),
      remeasure: () => {
        this.metrics = measureMono(this.output, FALLBACK_METRICS);
      },
    }, { followTail: true, tailSlack: 24, insetTop: INSET_TOP, insetBottom: INSET_BOTTOM });
    this.setRows([], 0);
  }

  destroy(): void {
    this.list.destroy();
  }

  flashCopied(): void {
    if (this.copyFlash) clearTimeout(this.copyFlash);
    this.copyButton.replaceChildren(paneHeadIcon(Check));
    this.copyButton.classList.add("is-copied");
    this.copyButton.title = "Copied";
    this.copyButton.setAttribute("aria-label", "Copied");
    this.copyFlash = setTimeout(() => {
      this.copyFlash = null;
      this.copyButton.replaceChildren(paneHeadIcon(Copy));
      this.copyButton.classList.remove("is-copied");
      this.copyButton.title = this.copyIdleTitle;
      this.copyButton.setAttribute("aria-label", this.copyIdleTitle);
    }, 1_200);
  }

  get renderedRowCount(): number {
    return this.list.renderedCount;
  }

  appendRows(rows: DebugConsoleRow[], total: number, maxRows: number): void {
    if (rows.length > 0) {
      for (const row of rows) {
        this.data.push(row);
        this.ids.push(this.nextId++);
      }
      if (this.data.length > maxRows) {
        const drop = this.data.length - maxRows;
        this.data.splice(0, drop);
        this.ids.splice(0, drop);
      }
      this.syncEmpty(total);
      this.list.refresh();
    }
    this.count.textContent = this.countText(this.data.length, total);
  }

  setRows(rows: DebugConsoleRow[], total: number): void {
    const known = new Map<DebugConsoleRow, number>();
    for (let i = 0; i < this.data.length; i++) known.set(this.data[i]!, this.ids[i]!);
    this.data = rows.slice();
    this.ids = this.data.map((row) => {
      const id = known.get(row);
      if (id === undefined) return this.nextId++;
      known.delete(row);
      return id;
    });
    this.syncEmpty(total);
    this.list.refresh();
    this.count.textContent = this.countText(rows.length, total);
  }

  private syncEmpty(total: number): void {
    this.empty.hidden = this.data.length !== 0;
    this.empty.textContent =
      total === 0
        ? "Program output and debugger messages will appear here"
        : "No entries match the filter";
  }

  private countText(shown: number, total: number): string {
    return shown === total ? `${total}` : `${shown} / ${total}`;
  }

  private createRow(): HTMLElement {
    const row = document.createElement("div");
    const time = document.createElement("time");
    const direction = document.createElement("span");
    direction.className = "devmode-debug-console-direction";
    const text = document.createElement("span");
    text.className = "devmode-debug-console-text";
    row.append(time, direction, text);
    return row;
  }

  private bindRow(row: HTMLElement, entry: DebugConsoleRow): void {
    row.className = `devmode-debug-console-row is-${entry.direction}`;
    const [time, direction, text] = [...row.children] as [HTMLTimeElement, HTMLElement, HTMLElement];
    time.dateTime = new Date(entry.timestamp).toISOString();
    time.textContent = formatTime(entry.timestamp);
    direction.textContent =
      entry.direction === "send"
        ? "→"
        : entry.direction === "receive"
          ? "←"
          : "!";
    text.textContent = entry.text;
  }

  private estimate(entry: DebugConsoleRow, width: number): number {
    let cols = this.columns.get(entry);
    if (cols === undefined) {
      cols = visualColumns(entry.text);
      this.columns.set(entry, cols);
    }
    const { charWidth, lineHeight } = this.metrics;
    const textWidth = width - ROW_CHROME_PX - TIME_COLUMNS * charWidth;
    return wrappedRows(cols, textWidth, charWidth) * lineHeight + ROW_PADDING_Y;
  }

  private iconButton(title: string, icon: Parameters<typeof createLucideIcon>[0]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "devmode-debug-console-action";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.append(paneHeadIcon(icon));
    return button;
  }
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${date.toLocaleTimeString("en-GB", { hour12: false })}.${ms}`;
}
