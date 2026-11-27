import { createFunctionalIcon } from "../ui/icons.js";
import { BrushCleaning } from "../ui/originalIcons.js";
import { paneHeadIcon } from "./paneHeadIcons.js";
import { baseNameOf } from "./slnPaths.js";
import type { BuildDiagnostic } from "./buildDiagnostics.js";
import { BuildProblemsModel } from "./buildProblemsModel.js";
import { VirtualList } from "./virtualList.js";

const ROW_HEIGHT = 48;

type RowParts = {
  icon: Element | null;
  severity: string;
  copy: HTMLElement;
  message: HTMLElement;
  file: HTMLElement;
  location: HTMLElement;
};

export class BuildProblemsView {
  readonly root = document.createElement("aside");
  private readonly errors = document.createElement("span");
  private readonly warnings = document.createElement("span");
  private readonly list = document.createElement("div");
  private readonly empty = document.createElement("div");
  private readonly model = new BuildProblemsModel();
  private readonly parts = new WeakMap<HTMLElement, RowParts>();
  private readonly rows: VirtualList;
  onOpen: ((item: BuildDiagnostic) => void) | null = null;
  onClear: (() => void) | null = null;

  constructor() {
    this.root.className = "devmode-build-problems";
    this.root.setAttribute("aria-label", "Build problems");
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
    clear.title = "Clear build log and problems";
    clear.setAttribute("aria-label", "Clear build log and problems");
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
    this.rows = new VirtualList(this.list, {
      count: () => this.model.size,
      key: (i) => this.model.at(i).id,
      version: (i) => (this.model.at(i).id === this.model.selectedId ? 1 : 0),
      type: (i) => (this.located(this.model.at(i)) ? "button" : "div"),
      create: (type) => this.createRow(type),
      bind: (el, i) => this.bindRow(el, this.model.at(i)),
    }, { rowHeight: ROW_HEIGHT });
    this.updateCounts();
  }

  append(items: readonly BuildDiagnostic[]): void {
    if (!items.length || !this.model.add(items)) return;
    this.updateCounts();
    this.rows.invalidate();
  }

  clear(): void {
    this.model.clear();
    this.updateCounts();
    this.rows.invalidate();
  }

  destroy(): void {
    this.rows.destroy();
  }

  private updateCounts(): void {
    this.errors.textContent = String(this.model.errorCount);
    this.warnings.textContent = String(this.model.warningCount);
    this.errors.parentElement!.setAttribute("aria-label", `${this.model.errorCount} errors`);
    this.warnings.parentElement!.setAttribute("aria-label", `${this.model.warningCount} warnings`);
    this.empty.hidden = this.model.size !== 0;
  }

  private located(item: BuildDiagnostic): boolean {
    return item.path !== null && item.line !== null;
  }

  private createRow(type: string): HTMLElement {
    const row = document.createElement(type === "button" ? "button" : "div");
    row.className = "devmode-build-problem";
    const copy = document.createElement("span");
    copy.className = "devmode-build-problem-copy";
    const message = document.createElement("span");
    message.className = "devmode-build-problem-message";
    const meta = document.createElement("span");
    meta.className = "devmode-build-problem-meta";
    const file = document.createElement("span");
    file.className = "devmode-build-problem-file";
    const location = document.createElement("span");
    location.className = "devmode-build-problem-location";
    meta.append(file, location); copy.append(message, meta); row.append(copy);
    this.parts.set(row, { icon: null, severity: "", copy, message, file, location });
    if (type === "button") {
      (row as HTMLButtonElement).type = "button";
      row.addEventListener("click", () => this.open(row.dataset.diagnosticId ?? ""));
    }
    return row;
  }

  private bindRow(row: HTMLElement, item: BuildDiagnostic): void {
    const parts = this.parts.get(row)!;
    const located = this.located(item);
    row.dataset.severity = item.severity;
    row.dataset.diagnosticId = item.id;
    const description = `${item.severity}${item.code ? ` ${item.code}` : ""}: ${item.message}`;
    row.title = `${description}\n${located ? `${item.path}:${item.line}${item.column ? `:${item.column}` : ""}` : "No source location reported"}`;
    if (parts.severity !== item.severity) {
      const icon = createFunctionalIcon(item.severity === "error" ? "CircleX" : "TriangleAlert", 13);
      icon.classList.add("devmode-build-problem-icon", `is-${item.severity}`);
      icon.setAttribute("aria-hidden", "true");
      if (parts.icon) parts.icon.replaceWith(icon);
      else row.insertBefore(icon, parts.copy);
      parts.icon = icon;
      parts.severity = item.severity;
    }
    parts.message.textContent = item.message;
    parts.file.textContent = item.path ? baseNameOf(item.path) : "Build";
    parts.location.textContent = item.line ? `${item.line}${item.column ? `:${item.column}` : ""}` : "";
    if (located) {
      row.setAttribute("aria-label", `${description}, ${item.path}, line ${item.line}${item.column ? `, column ${item.column}` : ""}`);
    }
    const selected = item.id === this.model.selectedId;
    row.classList.toggle("is-selected", selected);
    if (selected) row.setAttribute("aria-current", "location");
    else row.removeAttribute("aria-current");
  }

  private open(id: string): void {
    const item = this.model.get(id);
    if (!item) return;
    if (this.model.select(id)) this.rows.refresh();
    this.onOpen?.(item);
  }
}
