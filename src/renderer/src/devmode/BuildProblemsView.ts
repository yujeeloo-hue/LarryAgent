import { createFunctionalIcon } from "../ui/icons.js";
import { BrushCleaning } from "../ui/originalIcons.js";
import { paneHeadIcon } from "./paneHeadIcons.js";
import { baseNameOf } from "./slnPaths.js";
import type { BuildDiagnostic } from "./buildDiagnostics.js";

export class BuildProblemsView {
  readonly root = document.createElement("aside");
  private readonly errors = document.createElement("span");
  private readonly warnings = document.createElement("span");
  private readonly list = document.createElement("div");
  private readonly empty = document.createElement("div");
  private readonly rows = new Map<string, HTMLElement>();
  private selected: HTMLElement | null = null;
  private errorCount = 0;
  private warningCount = 0;
  onOpen: ((item: BuildDiagnostic) => void) | null = null;
  onClear: (() => void) | null = null;

  constructor() {
    this.root.className = "devmode-build-problems";
    this.root.setAttribute("aria-label", "Build errors and warnings");
    const head = document.createElement("div");
    head.className = "devmode-build-problems-head";
    const title = document.createElement("span");
    title.textContent = "Problems";
    const counts = document.createElement("span");
    counts.className = "devmode-build-problems-counts";
    for (const [severity, name, count] of [
      ["error", "CircleX", this.errors],
      ["warning", "TriangleAlert", this.warnings],
    ] as const) {
      const total = document.createElement("span");
      total.className = `devmode-build-problems-count is-${severity}`;
      const icon = createFunctionalIcon(name, 12);
      icon.setAttribute("aria-hidden", "true");
      total.append(icon, count); counts.append(total);
    }
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "devmode-build-problems-clear";
    clear.title = "Clear build output";
    clear.setAttribute("aria-label", "Clear build output");
    clear.append(paneHeadIcon(BrushCleaning));
    clear.addEventListener("click", () => this.onClear?.());
    const tools = document.createElement("span");
    tools.className = "devmode-build-problems-tools";
    tools.append(counts, clear);
    head.append(title, tools);
    this.list.className = "devmode-build-problems-list";
    this.empty.className = "devmode-build-problems-empty";
    this.empty.textContent = "Waiting for compiler output…";
    this.list.append(this.empty);
    this.root.append(head, this.list);
    this.updateCounts();
  }

  private updateCounts(): void {
    this.errors.textContent = String(this.errorCount);
    this.warnings.textContent = String(this.warningCount);
    this.errors.parentElement!.setAttribute("aria-label", `${this.errorCount} errors`);
    this.warnings.parentElement!.setAttribute("aria-label", `${this.warningCount} warnings`);
    this.empty.hidden = this.rows.size !== 0;
  }

  append(items: readonly BuildDiagnostic[]): void {
    if (!items.length) return;
    for (const item of items) {
      if (this.rows.has(item.id)) continue;
      const located = item.path !== null && item.line !== null;
      const row = document.createElement(located ? "button" : "div");
      row.className = "devmode-build-problem";
      row.dataset.severity = item.severity;
      row.dataset.diagnosticId = item.id;
      const description = `${item.severity}${item.code ? ` ${item.code}` : ""}: ${item.message}`;
      row.title = `${description}\n${located ? `${item.path}:${item.line}${item.column ? `:${item.column}` : ""}` : "No source location reported"}`;
      const icon = createFunctionalIcon(item.severity === "error" ? "CircleX" : "TriangleAlert", 13);
      icon.classList.add("devmode-build-problem-icon", `is-${item.severity}`);
      icon.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span");
      copy.className = "devmode-build-problem-copy";
      const message = document.createElement("span");
      message.className = "devmode-build-problem-message";
      message.textContent = item.message;
      const meta = document.createElement("span");
      meta.className = "devmode-build-problem-meta";
      const file = document.createElement("span");
      file.className = "devmode-build-problem-file";
      file.textContent = item.path ? baseNameOf(item.path) : "Build";
      const location = document.createElement("span");
      location.className = "devmode-build-problem-location";
      location.textContent = item.line ? `${item.line}${item.column ? `:${item.column}` : ""}` : "";
      meta.append(file, location); copy.append(message, meta); row.append(icon, copy);
      if (located) {
        const button = row as HTMLButtonElement;
        button.type = "button";
        button.setAttribute("aria-label", `${description}, ${item.path}, line ${item.line}${item.column ? `, column ${item.column}` : ""}`);
        button.addEventListener("click", () => {
          this.selected?.classList.remove("is-selected");
          this.selected?.removeAttribute("aria-current");
          this.selected = button;
          button.classList.add("is-selected");
          button.setAttribute("aria-current", "location");
          this.onOpen?.(item);
        });
      }
      this.rows.set(item.id, row);
      if (item.severity === "error") {
        this.errorCount++;
        this.list.insertBefore(row, this.list.querySelector('[data-severity="warning"]'));
      } else {
        this.warningCount++;
        this.list.append(row);
      }
    }
    this.updateCounts();
  }

  clear(): void {
    this.rows.clear(); this.selected = null;
    this.errorCount = 0; this.warningCount = 0;
    this.list.replaceChildren(this.empty);
    this.updateCounts();
  }
}
