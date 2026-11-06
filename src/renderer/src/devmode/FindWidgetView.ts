/**
 * Dev Mode find / replace overlay — presentation only.
 * Frosted panel matching Quick Open / context menus. Controller owns search.
 */
import {
  ArrowDown,
  ArrowUp,
  CaseSensitive,
  ChevronRight,
  Regex,
  Replace,
  ReplaceAll,
  WholeWord,
  X,
  createLucideIcon,
} from "../ui/originalIcons.js";

export class FindWidgetView {
  readonly root: HTMLElement;
  readonly findInput: HTMLInputElement;
  readonly replaceInput: HTMLInputElement;
  private readonly countEl: HTMLElement;
  private readonly revealBtn: HTMLButtonElement;
  private readonly replaceRow: HTMLElement;
  private readonly replaceBtn: HTMLButtonElement;
  private readonly replaceAllBtn: HTMLButtonElement;
  private readonly caseBtn: HTMLButtonElement;
  private readonly wordBtn: HTMLButtonElement;
  private readonly regexBtn: HTMLButtonElement;

  onFindInput: ((value: string) => void) | null = null;
  onReplaceInput: ((value: string) => void) | null = null;
  onFindKeydown: ((event: KeyboardEvent) => void) | null = null;
  onReplaceKeydown: ((event: KeyboardEvent) => void) | null = null;
  onPrev: (() => void) | null = null;
  onNext: (() => void) | null = null;
  onClose: (() => void) | null = null;
  onToggleCase: ((on: boolean) => void) | null = null;
  onToggleWord: ((on: boolean) => void) | null = null;
  onToggleRegex: ((on: boolean) => void) | null = null;
  onToggleReplace: (() => void) | null = null;
  onReplace: (() => void) | null = null;
  onReplaceAll: (() => void) | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "devmode-find";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "Find");
    this.root.hidden = true;

    const findRow = document.createElement("div");
    findRow.className = "devmode-find-row";

    this.revealBtn = this.iconButton(
      "Toggle replace",
      ChevronRight,
      "devmode-find-btn devmode-find-reveal",
    );
    this.revealBtn.setAttribute("aria-expanded", "false");
    this.revealBtn.addEventListener("click", () => this.onToggleReplace?.());

    this.findInput = document.createElement("input");
    this.findInput.type = "text";
    this.findInput.className = "devmode-find-input";
    this.findInput.placeholder = "Find…";
    this.findInput.spellcheck = false;
    this.findInput.autocomplete = "off";
    this.findInput.setAttribute("aria-label", "Find in file");
    this.findInput.addEventListener("input", () => {
      this.onFindInput?.(this.findInput.value);
    });
    this.findInput.addEventListener("keydown", (event) => {
      this.onFindKeydown?.(event);
    });

    this.countEl = document.createElement("span");
    this.countEl.className = "devmode-find-count";

    const prevBtn = this.iconButton("Previous match", ArrowUp, "devmode-find-btn");
    prevBtn.addEventListener("click", () => this.onPrev?.());
    const nextBtn = this.iconButton("Next match", ArrowDown, "devmode-find-btn");
    nextBtn.addEventListener("click", () => this.onNext?.());

    this.caseBtn = this.toggleButton("Match case", CaseSensitive);
    this.caseBtn.addEventListener("click", () => {
      this.onToggleCase?.(this.flipToggle(this.caseBtn));
    });
    this.wordBtn = this.toggleButton("Match whole word", WholeWord);
    this.wordBtn.addEventListener("click", () => {
      this.onToggleWord?.(this.flipToggle(this.wordBtn));
    });
    this.regexBtn = this.toggleButton("Use regular expression", Regex);
    this.regexBtn.addEventListener("click", () => {
      this.onToggleRegex?.(this.flipToggle(this.regexBtn));
    });
    const toggles = document.createElement("div");
    toggles.className = "devmode-find-toggles";
    toggles.append(this.caseBtn, this.wordBtn, this.regexBtn);

    const closeBtn = this.iconButton("Close", X, "devmode-find-btn");
    closeBtn.setAttribute("aria-label", "Close find");
    closeBtn.addEventListener("click", () => this.onClose?.());

    findRow.append(
      this.revealBtn,
      this.findInput,
      this.countEl,
      prevBtn,
      nextBtn,
      toggles,
      closeBtn,
    );

    this.replaceRow = document.createElement("div");
    this.replaceRow.className = "devmode-find-row devmode-find-replace";
    this.replaceRow.hidden = true;

    const gutter = document.createElement("span");
    gutter.className = "devmode-find-gutter";
    gutter.setAttribute("aria-hidden", "true");

    this.replaceInput = document.createElement("input");
    this.replaceInput.type = "text";
    this.replaceInput.className = "devmode-find-input";
    this.replaceInput.placeholder = "Replace…";
    this.replaceInput.spellcheck = false;
    this.replaceInput.autocomplete = "off";
    this.replaceInput.setAttribute("aria-label", "Replace with");
    this.replaceInput.tabIndex = -1;
    this.replaceInput.addEventListener("input", () => {
      this.onReplaceInput?.(this.replaceInput.value);
    });
    this.replaceInput.addEventListener("keydown", (event) => {
      this.onReplaceKeydown?.(event);
    });

    this.replaceBtn = this.iconButton("Replace", Replace, "devmode-find-btn");
    this.replaceBtn.addEventListener("click", () => this.onReplace?.());
    this.replaceAllBtn = this.iconButton(
      "Replace All",
      ReplaceAll,
      "devmode-find-btn",
    );
    this.replaceAllBtn.addEventListener("click", () => this.onReplaceAll?.());
    this.setReplaceEnabled(false);

    this.replaceRow.append(
      gutter,
      this.replaceInput,
      this.replaceBtn,
      this.replaceAllBtn,
    );

    this.root.append(findRow, this.replaceRow);
  }

  setHidden(hidden: boolean): void {
    this.root.hidden = hidden;
  }

  setReplaceOpen(open: boolean): void {
    this.root.classList.toggle("is-replace", open);
    this.replaceRow.hidden = !open;
    this.revealBtn.setAttribute("aria-expanded", String(open));
    this.replaceInput.tabIndex = open ? 0 : -1;
    this.root.setAttribute("aria-label", open ? "Find and replace" : "Find");
  }

  setCount(text: string): void {
    this.countEl.textContent = text;
  }

  setFindValue(value: string): void {
    this.findInput.value = value;
  }

  setReplaceEnabled(enabled: boolean): void {
    this.replaceBtn.disabled = !enabled;
    this.replaceAllBtn.disabled = !enabled;
  }

  focusFind(select = false): void {
    this.findInput.focus();
    if (select) this.findInput.select?.();
  }

  focusReplace(select = false): void {
    this.replaceInput.focus();
    if (select) this.replaceInput.select?.();
  }

  get inWidget(): boolean {
    const active = document.activeElement;
    return active === this.findInput || active === this.replaceInput;
  }

  private flipToggle(btn: HTMLButtonElement): boolean {
    const on = !btn.classList.contains("is-on");
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-pressed", String(on));
    return on;
  }

  private toggleButton(label: string, icon: Parameters<typeof createLucideIcon>[0]): HTMLButtonElement {
    const btn = this.iconButton(label, icon, "devmode-find-toggle");
    btn.setAttribute("aria-pressed", "false");
    return btn;
  }

  private iconButton(
    label: string,
    icon: Parameters<typeof createLucideIcon>[0],
    className: string,
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.append(createLucideIcon(icon, { size: 12, strokeWidth: 2 }));
    return btn;
  }
}
