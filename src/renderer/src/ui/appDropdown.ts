import { Check, ChevronDown, type IconNode } from "lucide";
import { createLucideIcon } from "./icons.js";
import "./appDropdown.css";

export interface AppDropdownOption {
  value: string;
  label: string;
  /** Secondary right-aligned description (theme tagline, provider id, …). */
  hint?: string;
}

/** Gap between the trigger and the portaled menu (px). */
const MENU_GAP = 6;
/** Breathing room kept between the menu and the viewport edges (px). */
const MENU_MARGIN = 8;
/** Menus taller than this scroll internally instead of stretching. */
const MENU_MAX_HEIGHT = 300;
/** Never collapse below this even when the viewport is nearly full. */
const MENU_MIN_HEIGHT = 120;

export interface AppDropdownOptions {
  /** Decorative icon rendered before the value (toolbar filters). */
  leadingIcon?: IconNode;
  /** Extra class on the root, for context-specific sizing. */
  className?: string;
  /** Accessible name for the trigger (the old `select`'s aria-label). */
  ariaLabel?: string;
}

/**
 * App-styled dropdown — the single implementation used everywhere a
 * `<select>` would otherwise be. Native `<select>` popups render with OS
 * chrome on Windows and cannot be themed, so this mirrors the relevant
 * `HTMLSelectElement` surface instead: `.value` get/set plus a `change`
 * event, letting controller wiring stay close to the old select code.
 * All colors come from theme tokens, so the popup follows Dark/Light.
 */
export class AppDropdown extends EventTarget {
  /** Root element — pass this where a `<select>` used to be appended. */
  readonly el: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly valueLabel: HTMLElement;
  private readonly menu: HTMLElement;
  private rows: HTMLElement[] = [];
  private options: readonly AppDropdownOption[];
  private readonly onDocPointerDown = (event: PointerEvent): void => {
    // The menu lives in <body> while open (portal), so it must count as
    // "inside" even though it is outside this.el — and a scrollbar drag there
    // can report the page as the target, hence the geometry fallback.
    if (!this.ownsEvent(event)) this.closeMenu();
  };
  /** Keep the portaled menu glued to the button on scroll/resize. */
  private readonly onReposition = (event?: Event): void => {
    if (!this.el.isConnected) {
      this.closeMenu();
      return;
    }
    // Capture-phase listener, so a scroll *inside* the capped menu lands here
    // too. The anchor has not moved in that case, and re-placing would fight
    // the user's wheel/scrollbar (it used to snap the list back to the top).
    if (event?.target === this.menu) return;
    this.placeMenu();
  };
  private _value: string;
  private open = false;
  private activeIndex = -1;

  constructor(
    options: readonly AppDropdownOption[],
    initialValue: string,
    config: AppDropdownOptions = {},
  ) {
    super();
    this.options = options;
    this._value = options.some((o) => o.value === initialValue)
      ? initialValue
      : (options[0]?.value ?? "");

    this.el = document.createElement("div");
    this.el.className = "app-dropdown";
    if (config.className) this.el.classList.add(config.className);

    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "app-dropdown-btn";
    this.button.setAttribute("aria-haspopup", "listbox");
    this.button.setAttribute("aria-expanded", "false");
    if (config.ariaLabel) this.button.setAttribute("aria-label", config.ariaLabel);
    if (config.leadingIcon) {
      const leading = document.createElement("span");
      leading.className = "app-dropdown-leading";
      leading.append(createLucideIcon(config.leadingIcon, { size: 14 }));
      this.button.append(leading);
    }
    this.valueLabel = document.createElement("span");
    this.valueLabel.className = "app-dropdown-value";
    const chevron = document.createElement("span");
    chevron.className = "app-dropdown-chevron";
    chevron.append(createLucideIcon(ChevronDown, { size: 14 }));
    this.button.append(this.valueLabel, chevron);

    this.menu = document.createElement("div");
    this.menu.className = "app-dropdown-menu";
    this.menu.setAttribute("role", "listbox");
    this.menu.hidden = true;
    this.options.forEach((option, index) => {
      const row = document.createElement("div");
      row.className = "app-dropdown-option";
      row.setAttribute("role", "option");
      row.tabIndex = -1;
      const check = document.createElement("span");
      check.className = "app-dropdown-check";
      check.append(createLucideIcon(Check, { size: 13 }));
      const label = document.createElement("span");
      label.className = "app-dropdown-option-label";
      label.textContent = option.label;
      row.append(check, label);
      if (option.hint) {
        const hint = document.createElement("span");
        hint.className = "app-dropdown-option-hint";
        hint.textContent = option.hint;
        row.append(hint);
      }
      row.addEventListener("click", () => this.selectIndex(index));
      row.addEventListener("pointerenter", () => this.setActive(index));
      this.rows.push(row);
      this.menu.append(row);
    });

    this.button.addEventListener("click", () => {
      if (this.open) this.closeMenu();
      else this.openMenu();
    });
    this.button.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.openMenu(Math.max(0, this.optionIndex(this._value)));
      } else if (event.key === "Escape") {
        this.closeMenu();
      }
    });
    this.menu.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.openMenu(Math.min(this.activeIndex + 1, this.rows.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        this.openMenu(Math.max(this.activeIndex - 1, 0));
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (this.activeIndex >= 0) this.selectIndex(this.activeIndex);
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.closeMenu();
      }
    });

    this.el.append(this.button, this.menu);
    this.renderSelection();
  }

  get value(): string {
    return this._value;
  }

  /** Programmatic set mirrors `select.value`: updates UI, fires nothing. */
  set value(next: string) {
    if (!this.options.some((o) => o.value === next) || next === this._value) {
      return;
    }
    this._value = next;
    this.renderSelection();
  }

  focus(): void {
    this.button.focus();
  }

  get disabled(): boolean {
    return this.button.disabled;
  }

  /** Mirrors `select.disabled` (busy cards grey out their controls). */
  set disabled(next: boolean) {
    this.button.disabled = next;
    if (next) this.closeMenu();
  }

  /**
   * Does `event` belong to the trigger or to the open menu? The menu is
   * portaled to `<body>`, so hosts that dismiss themselves on an outside
   * pointerdown have to ask the dropdown instead of testing `contains()`
   * themselves. Pointer coordinates cover scrollbar drags, where the target
   * can be the surrounding page rather than the menu node.
   */
  ownsEvent(event: Event): boolean {
    const target = event.target as Node | null;
    if (target && (this.el.contains(target) || this.menu.contains(target))) {
      return true;
    }
    if (!this.open) return false;
    const { clientX, clientY } = event as MouseEvent;
    if (typeof clientX !== "number" || typeof clientY !== "number") return false;
    const rect = this.menu.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right
      && clientY >= rect.top && clientY <= rect.bottom;
  }

  /**
   * Replace the option list in place — for dropdowns whose choices are built
   * from live data (provider lists, provider-host-dependent modes). `value`
   * forces the selection; otherwise the current one is kept when it is still
   * offered, falling back to the first option (mirrors rebuilding a
   * `<select>`'s options and re-applying `.value`).
   */
  update(options: readonly AppDropdownOption[], value?: string): void {
    this.options = options;
    const keep = value ?? this._value;
    this._value = options.some((o) => o.value === keep)
      ? keep
      : (options[0]?.value ?? "");
    if (this.open) this.closeMenu();
    this.menu.replaceChildren();
    this.rows = [];
    this.options.forEach((option, index) => {
      const row = document.createElement("div");
      row.className = "app-dropdown-option";
      row.setAttribute("role", "option");
      row.tabIndex = -1;
      const check = document.createElement("span");
      check.className = "app-dropdown-check";
      check.append(createLucideIcon(Check, { size: 13 }));
      const label = document.createElement("span");
      label.className = "app-dropdown-option-label";
      label.textContent = option.label;
      row.append(check, label);
      if (option.hint) {
        const hint = document.createElement("span");
        hint.className = "app-dropdown-option-hint";
        hint.textContent = option.hint;
        row.append(hint);
      }
      row.addEventListener("click", () => this.selectIndex(index));
      row.addEventListener("pointerenter", () => this.setActive(index));
      this.rows.push(row);
      this.menu.append(row);
    });
    this.renderSelection();
  }

  private optionIndex(value: string): number {
    return this.options.findIndex((o) => o.value === value);
  }

  private renderSelection(): void {
    const selected = this.optionIndex(this._value);
    const option = this.options[selected];
    this.valueLabel.textContent = option ? option.label : this._value;
    this.rows.forEach((row, index) => {
      row.setAttribute("aria-selected", index === selected ? "true" : "false");
    });
  }

  private openMenu(
    activeIndex = Math.max(0, this.optionIndex(this._value)),
  ): void {
    if (!this.open) {
      this.open = true;
      this.menu.hidden = false;
      // Portal to <body>: ancestors like .setting-card or the drawer's own
      // overflow would cut the popup off at their boundary.
      this.menu.style.position = "fixed";
      document.body.append(this.menu);
      this.placeMenu();
      this.button.setAttribute("aria-expanded", "true");
      // Listener lives only while the menu is open — no lifecycle to manage.
      document.addEventListener("pointerdown", this.onDocPointerDown, true);
      window.addEventListener("scroll", this.onReposition, true);
      window.addEventListener("resize", this.onReposition);
    }
    this.setActive(activeIndex, true);
    this.rows[activeIndex]?.focus();
  }

  private closeMenu(): void {
    if (!this.open) return;
    this.open = false;
    this.menu.hidden = true;
    this.menu.style.position = "";
    this.menu.style.maxHeight = "";
    this.el.append(this.menu);
    this.button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", this.onDocPointerDown, true);
    window.removeEventListener("scroll", this.onReposition, true);
    window.removeEventListener("resize", this.onReposition);
    this.button.focus();
  }

  /** Position the portaled menu under (or above) the button. */
  private placeMenu(): void {
    const rect = this.button.getBoundingClientRect();
    this.menu.style.minWidth = `${Math.round(rect.width)}px`;
    this.menu.style.left = `${Math.round(rect.left)}px`;
    // Natural height decides which side to open on. Read it from scrollHeight
    // and keep the cap applied: clearing maxHeight collapses the scroll box,
    // which resets scrollTop and would yank a scrolled list back to the top.
    const natural = this.menu.scrollHeight
      + (this.menu.offsetHeight - this.menu.clientHeight);
    const spaceBelow = window.innerHeight - rect.bottom - MENU_MARGIN;
    const spaceAbove = rect.top - MENU_MARGIN;
    const openUp = spaceBelow < natural + MENU_GAP && spaceAbove > spaceBelow;
    const available = openUp ? spaceAbove : spaceBelow;
    // Long option lists (e.g. every Unreal build target) would otherwise run
    // off the viewport: cap the menu and scroll inside it instead.
    const capped = Math.min(
      natural,
      MENU_MAX_HEIGHT,
      Math.max(available, MENU_MIN_HEIGHT),
    );
    this.menu.style.maxHeight = `${Math.round(capped)}px`;
    const height = this.menu.offsetHeight;
    this.menu.style.top = openUp
      ? `${Math.round(rect.top - height - MENU_GAP)}px`
      : `${Math.round(rect.bottom + MENU_GAP)}px`;
  }

  /**
   * Highlight a row. Only keyboard/opening walks reveal it: revealing on hover
   * would fight the user's own wheel/scrollbar movement inside a long list.
   */
  private setActive(index: number, reveal = false): void {
    this.activeIndex = index;
    this.rows.forEach((row, i) =>
      row.classList.toggle("is-active", i === index),
    );
    const row = this.rows[index];
    if (reveal && this.open && row) this.revealRow(row);
  }

  /** Keep the active row inside the scrollable menu (keyboard navigation). */
  private revealRow(row: HTMLElement): void {
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < this.menu.scrollTop) {
      this.menu.scrollTop = Math.max(0, top - 4);
    } else if (bottom > this.menu.scrollTop + this.menu.clientHeight) {
      this.menu.scrollTop = bottom - this.menu.clientHeight + 4;
    }
  }

  private selectIndex(index: number): void {
    const option = this.options[index];
    if (!option) return;
    this._value = option.value;
    this.renderSelection();
    this.dispatchEvent(new Event("change"));
    this.closeMenu();
  }
}
