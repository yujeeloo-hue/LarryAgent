/**
 * Document Outline — left-pane list of symbols in the active editor file.
 * Presentation only: the controller owns scan, cursor follow, and resize.
 */
import {
  Braces,
  ChevronRight,
  Search,
  SquareFunction,
  Summary,
  Variable,
  X,
  createLucideIcon,
} from "../ui/originalIcons.js";
import {
  outlineSignatureText,
  type DocumentSymbolKind,
} from "./documentSymbols.js";

export type DocumentOutlineRow = {
  name: string;
  kind: DocumentSymbolKind;
  depth: number;
  line: number;
  active: boolean;
  params?: string;
  returnType?: string;
};

export class DocumentOutlineView {
  readonly root: HTMLElement;
  readonly resizeHandle: HTMLButtonElement;
  readonly filterInput: HTMLInputElement;
  private readonly header: HTMLButtonElement;
  private readonly chevronWrap: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly filterRow: HTMLElement;
  private readonly filterClear: HTMLButtonElement;
  private readonly body: HTMLElement;

  onToggleCollapse: (() => void) | null = null;
  onSelectLine: ((line: number) => void) | null = null;
  onFilterChange: ((query: string) => void) | null = null;
  onFilterSubmit: (() => void) | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "devmode-doc-outline";
    this.root.setAttribute("role", "region");
    this.root.setAttribute("aria-label", "Outline");

    this.resizeHandle = document.createElement("button");
    this.resizeHandle.type = "button";
    this.resizeHandle.className = "devmode-doc-outline-resize";
    this.resizeHandle.setAttribute("aria-label", "Resize outline");
    this.resizeHandle.title = "Drag to resize";
    this.resizeHandle.tabIndex = 0;

    this.header = document.createElement("button");
    this.header.type = "button";
    this.header.className = "devmode-doc-outline-head";
    this.header.setAttribute("aria-expanded", "true");
    this.chevronWrap = document.createElement("span");
    this.chevronWrap.className = "devmode-doc-outline-tw";
    this.chevronWrap.append(
      createLucideIcon(ChevronRight, { size: 12, strokeWidth: 1.75 }),
    );
    const titleIcon = document.createElement("span");
    titleIcon.className = "devmode-doc-outline-head-icon";
    titleIcon.append(createLucideIcon(Summary, { size: 13 }));
    const title = document.createElement("span");
    title.className = "devmode-doc-outline-title";
    title.textContent = "Outline";
    this.countEl = document.createElement("span");
    this.countEl.className = "devmode-doc-outline-count";
    this.header.append(this.chevronWrap, titleIcon, title, this.countEl);
    this.header.addEventListener("click", () => this.onToggleCollapse?.());

    this.filterRow = document.createElement("div");
    this.filterRow.className = "devmode-doc-outline-filter";
    const filterIcon = document.createElement("span");
    filterIcon.className = "devmode-doc-outline-filter-icon";
    filterIcon.append(createLucideIcon(Search, { size: 12 }));
    this.filterInput = document.createElement("input");
    this.filterInput.type = "search";
    this.filterInput.className = "devmode-doc-outline-filter-input";
    this.filterInput.placeholder = "Filter symbols…";
    this.filterInput.setAttribute("aria-label", "Filter symbols");
    this.filterInput.autocomplete = "off";
    this.filterInput.spellcheck = false;
    this.filterInput.addEventListener("input", () => {
      this.syncFilterClear();
      this.onFilterChange?.(this.filterInput.value);
    });
    this.filterInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (this.filterInput.value) {
          this.filterInput.value = "";
          this.syncFilterClear();
          this.onFilterChange?.("");
        } else {
          this.filterInput.blur();
        }
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        this.onFilterSubmit?.();
      }
    });
    this.filterClear = document.createElement("button");
    this.filterClear.type = "button";
    this.filterClear.className = "devmode-doc-outline-filter-clear";
    this.filterClear.setAttribute("aria-label", "Clear outline filter");
    this.filterClear.title = "Clear filter";
    this.filterClear.hidden = true;
    this.filterClear.append(createLucideIcon(X, { size: 12 }));
    this.filterClear.addEventListener("click", () => {
      this.filterInput.value = "";
      this.syncFilterClear();
      this.filterInput.focus();
      this.onFilterChange?.("");
    });
    this.filterRow.append(filterIcon, this.filterInput, this.filterClear);

    this.body = document.createElement("div");
    this.body.className = "devmode-doc-outline-body";

    this.root.append(
      this.resizeHandle,
      this.header,
      this.filterRow,
      this.body,
    );
  }

  setCollapsed(collapsed: boolean): void {
    this.root.classList.toggle("is-collapsed", collapsed);
    this.header.setAttribute("aria-expanded", collapsed ? "false" : "true");
    this.resizeHandle.hidden = collapsed;
  }

  setHeight(px: number): void {
    this.root.style.setProperty("--devmode-doc-outline-height", `${px}px`);
    this.resizeHandle.setAttribute("aria-valuenow", String(px));
  }

  setRows(rows: DocumentOutlineRow[], countText?: string): void {
    const count =
      countText ??
      String(rows.filter((row) => row.kind !== "access").length || "");
    this.countEl.textContent = count === "0" ? "" : count;
    this.body.replaceChildren();
    if (rows.length === 0) return;
    for (const row of rows) {
      this.body.append(this.renderRow(row));
    }
    const active = this.body.querySelector<HTMLElement>(
      ".devmode-doc-outline-row.is-active",
    );
    active?.scrollIntoView?.({ block: "nearest" });
  }

  setEmpty(message: string, countText = ""): void {
    this.countEl.textContent = countText;
    const el = document.createElement("div");
    el.className = "devmode-doc-outline-empty";
    el.textContent = message;
    this.body.replaceChildren(el);
  }

  private syncFilterClear(): void {
    this.filterClear.hidden = this.filterInput.value.length === 0;
  }

  private renderRow(row: DocumentOutlineRow): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "devmode-doc-outline-row";
    if (row.active) btn.classList.add("is-active");
    if (row.kind === "access") btn.classList.add("is-access");
    btn.style.setProperty("--depth", String(row.depth));
    const sig = outlineSignatureText(row);
    btn.title =
      row.kind === "access"
        ? `${row.name}  L${row.line}`
        : `${row.name}${sig}  L${row.line}`;
    const icon = document.createElement("span");
    icon.className = "devmode-doc-outline-icon";
    icon.dataset.kind = row.kind;
    const lucide =
      row.kind === "function"
        ? SquareFunction
        : row.kind === "variable"
          ? Variable
          : row.kind === "access"
            ? null
            : Braces;
    if (lucide) icon.append(createLucideIcon(lucide, { size: 12 }));
    const text = document.createElement("span");
    text.className = "devmode-doc-outline-text";
    const label = document.createElement("span");
    label.className = "devmode-doc-outline-label";
    label.textContent = row.name;
    text.append(label);
    if (sig) {
      const detail = document.createElement("span");
      detail.className = "devmode-doc-outline-sig";
      detail.textContent = sig;
      text.append(detail);
    }
    btn.append(icon, text);
    btn.addEventListener("click", () => this.onSelectLine?.(row.line));
    return btn;
  }
}
