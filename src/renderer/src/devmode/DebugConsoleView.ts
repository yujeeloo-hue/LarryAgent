import {
  Check,
  Copy,
  createLucideIcon,
} from "../ui/originalIcons.js";

export type DebugConsoleRow = {
  timestamp: number;
  direction: "send" | "receive" | "error";
  text: string;
};

/** Presentation-only console for debug target / debugger output. */
export class DebugConsoleView {
  readonly root = document.createElement("div");
  readonly filterInput = document.createElement("input");
  readonly copyButton = this.iconButton("Copy all", Copy);
  private readonly count = document.createElement("span");
  private readonly output = document.createElement("div");
  private renderedRows = 0;
  private copyFlash: ReturnType<typeof setTimeout> | null = null;
  private readonly copyIdleTitle = "Copy all";

  onFilterChange: ((value: string) => void) | null = null;
  onCopy: (() => void) | null = null;

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
    toolbar.append(
      this.filterInput,
      this.count,
      this.copyButton,
    );

    this.output.className = "devmode-debug-console-output";
    this.output.setAttribute("role", "log");
    this.output.setAttribute("aria-live", "off");
    this.root.append(toolbar, this.output);
    this.setRows([], 0);
  }

  /** Swap the Copy glyph for a check, then restore — same cue as other copy buttons. */
  flashCopied(): void {
    if (this.copyFlash) clearTimeout(this.copyFlash);
    this.copyButton.replaceChildren(createLucideIcon(Check, { size: 12 }));
    this.copyButton.classList.add("is-copied");
    this.copyButton.title = "Copied";
    this.copyButton.setAttribute("aria-label", "Copied");
    this.copyFlash = setTimeout(() => {
      this.copyFlash = null;
      this.copyButton.replaceChildren(createLucideIcon(Copy, { size: 12 }));
      this.copyButton.classList.remove("is-copied");
      this.copyButton.title = this.copyIdleTitle;
      this.copyButton.setAttribute("aria-label", this.copyIdleTitle);
    }, 1_200);
  }

  /**
   * Append without touching existing rows. Rebuilding the whole list on every
   * trace row is quadratic; Unreal attach reports thousands of them and the
   * renderer stops answering clicks entirely.
   */
  appendRows(rows: DebugConsoleRow[], total: number, maxRows: number): void {
    if (rows.length === 0) {
      this.count.textContent = this.countText(this.renderedRows, total);
      return;
    }
    const wasAtBottom = this.isScrolledToBottom();
    if (this.renderedRows === 0) this.output.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const row of rows) fragment.append(this.row(row));
    this.output.append(fragment);
    this.renderedRows += rows.length;
    while (this.renderedRows > maxRows && this.output.firstChild) {
      this.output.removeChild(this.output.firstChild);
      this.renderedRows -= 1;
    }
    this.count.textContent = this.countText(this.renderedRows, total);
    if (wasAtBottom) this.output.scrollTop = this.output.scrollHeight;
  }

  setRows(rows: DebugConsoleRow[], total: number): void {
    const wasAtBottom = this.isScrolledToBottom();
    this.output.replaceChildren();
    this.renderedRows = rows.length;
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "devmode-debug-console-empty";
      empty.textContent =
        total === 0
          ? "Program output and debugger messages will appear here"
          : "No entries match the filter";
      this.output.append(empty);
    } else {
      const fragment = document.createDocumentFragment();
      for (const row of rows) fragment.append(this.row(row));
      this.output.append(fragment);
    }
    this.count.textContent = this.countText(rows.length, total);
    if (wasAtBottom) this.output.scrollTop = this.output.scrollHeight;
  }

  private countText(shown: number, total: number): string {
    return shown === total ? `${total}` : `${shown} / ${total}`;
  }

  private isScrolledToBottom(): boolean {
    return (
      this.output.scrollHeight - this.output.scrollTop - this.output.clientHeight <
      24
    );
  }

  private row(entry: DebugConsoleRow): HTMLElement {
    const row = document.createElement("div");
    row.className = `devmode-debug-console-row is-${entry.direction}`;
    const time = document.createElement("time");
    time.dateTime = new Date(entry.timestamp).toISOString();
    time.textContent = formatTime(entry.timestamp);
    const direction = document.createElement("span");
    direction.className = "devmode-debug-console-direction";
    direction.textContent =
      entry.direction === "send"
        ? "→"
        : entry.direction === "receive"
          ? "←"
          : "!";
    const text = document.createElement("span");
    text.className = "devmode-debug-console-text";
    text.textContent = entry.text;
    row.append(time, direction, text);
    return row;
  }

  private iconButton(title: string, icon: Parameters<typeof createLucideIcon>[0]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "devmode-debug-console-action";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.append(createLucideIcon(icon, { size: 12 }));
    return button;
  }
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${date.toLocaleTimeString("en-GB", { hour12: false })}.${ms}`;
}
