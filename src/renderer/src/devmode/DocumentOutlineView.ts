/**
 * Document Outline — left-pane list of symbols in the active editor file.
 * Presentation only: the controller owns scan, cursor follow, and resize.
 */
import {
  Braces,
  ChevronRight,
  SquareFunction,
  Variable,
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
  private readonly header: HTMLButtonElement;
  private readonly chevronWrap: HTMLElement;
  private readonly body: HTMLElement;

  onToggleCollapse: (() => void) | null = null;
  onSelectLine: ((line: number) => void) | null = null;

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
    const title = document.createElement("span");
    title.className = "devmode-doc-outline-title";
    title.textContent = "Outline";
    this.header.append(this.chevronWrap, title);
    this.header.addEventListener("click", () => this.onToggleCollapse?.());

    this.body = document.createElement("div");
    this.body.className = "devmode-doc-outline-body";

    // The outline is its own card, so the resize handle lives in the gutter
    // between the tree card and this one — the owner (DevModeController)
    // mounts it as a sibling, never inside the clipped card body.
    this.root.append(this.header, this.body);
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

  setRows(rows: DocumentOutlineRow[]): void {
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

  setEmpty(message: string): void {
    const el = document.createElement("div");
    el.className = "devmode-doc-outline-empty";
    el.textContent = message;
    this.body.replaceChildren(el);
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
