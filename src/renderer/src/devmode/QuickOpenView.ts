import {
  Braces,
  FileText,
  Search,
  SquareFunction,
  TextSearch,
  X,
  createLucideIcon,
} from "../ui/originalIcons.js";
import { QUICK_OPEN_CATEGORIES, type QuickOpenCategory } from "./quickOpenMerge.js";

export type QuickOpenRowIcon = "file" | "type" | "symbol" | "text";

export type QuickOpenRow = {
  kind: "file" | "symbol" | "text";
  icon: QuickOpenRowIcon;
  name: string;
  detail: string;
  project: string;
  title: string;
  group: string | null;
};

export type QuickOpenViewHandlers = {
  onQueryChange: (text: string) => void;
  onClear: () => void;
  onCategoryChange: (category: QuickOpenCategory) => void;
  onEngineScopeChange: (checked: boolean) => void;
  onMove: (delta: number) => void;
  onAccept: () => void;
  onDismiss: () => void;
  onRowActivate: (index: number) => void;
  onRowHover: (index: number) => void;
};

const ICONS = {
  file: FileText,
  type: Braces,
  symbol: SquareFunction,
  text: TextSearch,
} as const;

let quickOpenViewId = 0;

export class QuickOpenView {
  private readonly root: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly listEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly metaNoteEl: HTMLElement;
  private readonly categoryButtons = new Map<QuickOpenCategory, HTMLButtonElement>();
  private readonly engineCheckbox: HTMLInputElement;
  private readonly engineScope: HTMLLabelElement;
  private lastPointer = { x: Number.NaN, y: Number.NaN };
  private readonly outsideClick = (event: PointerEvent): void => {
    if (!this.root.hidden && !this.root.contains(event.target as Node)) this.handlers.onDismiss();
  };

  constructor(private readonly handlers: QuickOpenViewHandlers) {
    this.root = document.createElement("div");
    this.root.className = "devmode-quickopen";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "Search Everywhere");
    this.root.hidden = true;

    const header = document.createElement("div");
    header.className = "devmode-quickopen-header";
    const tabs = document.createElement("div");
    tabs.className = "devmode-quickopen-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Search category");
    for (const category of QUICK_OPEN_CATEGORIES) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = category;
      button.dataset.category = category;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(category === "All"));
      button.addEventListener("click", () => handlers.onCategoryChange(category));
      button.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const buttons = [...this.categoryButtons.values()];
        const step = event.key === "ArrowRight" ? 1 : -1;
        const next = buttons[(buttons.indexOf(button) + step + buttons.length) % buttons.length]!;
        next.click();
        next.focus();
      });
      this.categoryButtons.set(category, button);
      tabs.append(button);
    }
    this.engineScope = document.createElement("label");
    this.engineScope.className = "devmode-quickopen-scope";
    this.engineScope.hidden = true;
    this.engineCheckbox = document.createElement("input");
    this.engineCheckbox.type = "checkbox";
    this.engineCheckbox.checked = true;
    this.engineCheckbox.addEventListener("change", () =>
      handlers.onEngineScopeChange(this.engineCheckbox.checked),
    );
    this.engineScope.append(this.engineCheckbox, document.createTextNode("Include Engine"));
    header.append(tabs, this.engineScope);

    const inputRow = document.createElement("div");
    inputRow.className = "devmode-quickopen-row";
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "devmode-quickopen-input";
    this.input.placeholder = "Search everywhere";
    this.input.setAttribute("aria-label", "Search everywhere");
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-autocomplete", "list");
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    this.input.addEventListener("input", () => handlers.onQueryChange(this.input.value));
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        handlers.onMove(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        handlers.onMove(-1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        handlers.onAccept();
      } else if (event.key === "Escape") {
        event.preventDefault();
        handlers.onDismiss();
      }
    });
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "devmode-quickopen-clear";
    clear.setAttribute("aria-label", "Clear search");
    clear.append(createLucideIcon(X, { size: 14 }));
    clear.addEventListener("click", () => handlers.onClear());
    inputRow.append(createLucideIcon(Search, { size: 14 }), this.input, clear);

    this.listEl = document.createElement("div");
    this.listEl.className = "devmode-quickopen-list";
    this.listEl.setAttribute("role", "listbox");
    this.listEl.id = `devmode-quickopen-results-${++quickOpenViewId}`;
    this.listEl.setAttribute("aria-label", "Search results");
    this.input.setAttribute("aria-controls", this.listEl.id);

    const meta = document.createElement("div");
    meta.className = "devmode-quickopen-meta";
    this.countEl = document.createElement("span");
    this.countEl.className = "devmode-quickopen-count";
    this.countEl.setAttribute("role", "status");
    this.metaNoteEl = document.createElement("span");
    this.metaNoteEl.className = "devmode-quickopen-note";
    const hints = document.createElement("div");
    hints.className = "devmode-quickopen-keys";
    for (const [keys, text] of [[["Up", "Dn"], "Navigate"], [["Enter"], "Open"], [["Esc"], "Close"]] as const) {
      const hint = document.createElement("span");
      for (const key of keys) {
        const kbd = document.createElement("kbd");
        kbd.textContent = key;
        hint.append(kbd);
      }
      hint.append(document.createTextNode(text));
      hints.append(hint);
    }
    meta.append(hints, this.countEl, this.metaNoteEl);

    this.root.append(header, inputRow, this.listEl, meta);
    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handlers.onDismiss();
      }
    });
    window.addEventListener("pointerdown", this.outsideClick);
  }

  mount(host: HTMLElement): void {
    host.append(this.root);
  }

  destroy(): void {
    window.removeEventListener("pointerdown", this.outsideClick);
    this.root.remove();
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
    this.input.setAttribute("aria-expanded", String(visible));
  }

  setQuery(text: string): void {
    this.input.value = text;
  }

  focusInput(caret?: number): void {
    this.input.focus();
    if (caret !== undefined && typeof this.input.setSelectionRange === "function") {
      this.input.setSelectionRange(caret, caret);
    }
  }

  setCategory(category: QuickOpenCategory): void {
    this.categoryButtons.forEach((button, kind) =>
      button.setAttribute("aria-selected", String(kind === category)),
    );
  }

  setEngineScopeVisible(visible: boolean): void {
    this.engineScope.hidden = !visible;
  }

  setEngineChecked(checked: boolean): void {
    this.engineCheckbox.checked = checked;
  }

  renderRows(input: {
    rows: readonly QuickOpenRow[];
    selected: number;
    highlight: string;
    preserveScroll: boolean;
    revealSelected: boolean;
  }): void {
    const scrollTop = input.preserveScroll ? this.listEl.scrollTop : 0;
    this.listEl.replaceChildren();
    this.input.removeAttribute("aria-activedescendant");
    let lastGroup: string | null = null;
    input.rows.forEach((row, index) => {
      if (row.group !== null && row.group !== lastGroup) {
        const label = document.createElement("div");
        label.className = "devmode-quickopen-label";
        label.textContent = row.group;
        this.listEl.append(label);
        lastGroup = row.group;
      }
      this.listEl.append(this.renderRow(row, index, input.highlight));
    });
    this.setSelected(input.selected);
    this.listEl.scrollTop = scrollTop;
    if (input.revealSelected) this.revealSelected(input.selected);
  }

  setSelected(selected: number): void {
    for (const el of this.listEl.querySelectorAll<HTMLElement>(".devmode-quickopen-item")) {
      const active = el.dataset.idx === String(selected);
      el.classList.toggle("is-sel", active);
      el.setAttribute("aria-selected", String(active));
      if (active) this.input.setAttribute("aria-activedescendant", el.id);
    }
  }

  revealSelected(selected: number): void {
    this.listEl
      .querySelector<HTMLElement>(`.devmode-quickopen-item[data-idx="${selected}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }

  showHint(text: string): void {
    const row = document.createElement("div");
    row.className = "devmode-quickopen-hint";
    row.textContent = text;
    this.input.removeAttribute("aria-activedescendant");
    this.listEl.replaceChildren(row);
  }

  setMeta(count: string, note: string): void {
    this.countEl.textContent = count;
    this.metaNoteEl.textContent = note;
  }

  private renderRow(row: QuickOpenRow, index: number, highlight: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "devmode-quickopen-item";
    el.setAttribute("role", "option");
    el.setAttribute("data-kind", row.kind);
    el.setAttribute("data-idx", String(index));
    el.id = `${this.listEl.id}-${index}`;
    el.title = row.title;
    const icon = document.createElement("span");
    icon.className = "devmode-quickopen-icon";
    icon.append(createLucideIcon(ICONS[row.icon], { size: 14, strokeWidth: 1.75 }));
    const name = document.createElement("span");
    name.className = "devmode-quickopen-name";
    appendHighlighted(name, row.name, highlight);
    const detail = document.createElement("span");
    detail.className = "devmode-quickopen-detail";
    appendHighlighted(detail, row.detail, highlight);
    const project = document.createElement("span");
    project.className = "devmode-quickopen-project";
    project.textContent = row.project;
    const content = document.createElement("span");
    content.className = "devmode-quickopen-content";
    content.append(name, detail);
    el.append(icon, content, project);
    el.addEventListener("click", () => this.handlers.onRowActivate(index));
    el.addEventListener("pointermove", (event) => {
      const moved = event.clientX !== this.lastPointer.x || event.clientY !== this.lastPointer.y;
      this.lastPointer = { x: event.clientX, y: event.clientY };
      if (moved) this.handlers.onRowHover(index);
    });
    return el;
  }
}

function appendHighlighted(element: HTMLElement, text: string, query: string): void {
  const lowerQuery = query.toLowerCase();
  const lower = text.toLowerCase();
  const contiguous = lowerQuery ? lower.indexOf(lowerQuery) : -1;
  const positions = new Set<number>();
  if (contiguous >= 0) {
    for (let i = contiguous; i < contiguous + lowerQuery.length; i++) positions.add(i);
  } else if (lowerQuery) {
    let cursor = 0;
    for (const char of lowerQuery) {
      const index = lower.indexOf(char, cursor);
      if (index < 0) {
        positions.clear();
        break;
      }
      positions.add(index);
      cursor = index + 1;
    }
  }
  let start = 0;
  while (start < text.length) {
    const matched = positions.has(start);
    let end = start + 1;
    while (end < text.length && positions.has(end) === matched) end++;
    if (matched) {
      const mark = document.createElement("mark");
      mark.textContent = text.slice(start, end);
      element.append(mark);
    } else {
      element.append(document.createTextNode(text.slice(start, end)));
    }
    start = end;
  }
}
