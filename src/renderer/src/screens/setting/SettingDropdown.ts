import { Check, ChevronDown } from "lucide";
import { createLucideIcon } from "../../ui/icons.js";

export interface SettingDropdownOption {
  value: string;
  label: string;
  /** Secondary right-aligned description (theme tagline, provider id, …). */
  hint?: string;
}

/**
 * App-styled dropdown. Native `<select>` popups render with OS chrome on
 * Windows and cannot be themed, so this component mirrors the relevant
 * `HTMLSelectElement` surface instead: `.value` get/set plus a `change`
 * event, letting existing controller wiring keep working unchanged.
 * All colors come from theme tokens, so the popup follows Dark/Light.
 */
export class SettingDropdown extends EventTarget {
  /** Root element — pass this where a `<select>` used to be appended. */
  readonly el: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly valueLabel: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly rows: HTMLElement[] = [];
  private readonly options: readonly SettingDropdownOption[];
  private readonly onDocPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node;
    // The menu lives in <body> while open (portal), so it must count as
    // "inside" even though it is outside this.el.
    if (!this.el.contains(target) && !this.menu.contains(target)) {
      this.closeMenu();
    }
  };
  /** Keep the portaled menu glued to the button on scroll/resize. */
  private readonly onReposition = (): void => {
    if (!this.el.isConnected) {
      this.closeMenu();
      return;
    }
    this.placeMenu();
  };
  private _value: string;
  private open = false;
  private activeIndex = -1;

  constructor(
    options: readonly SettingDropdownOption[],
    initialValue: string,
  ) {
    super();
    this.options = options;
    this._value = options.some((o) => o.value === initialValue)
      ? initialValue
      : (options[0]?.value ?? "");

    this.el = document.createElement("div");
    this.el.className = "setting-dropdown";

    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "setting-dropdown-btn";
    this.button.setAttribute("aria-haspopup", "listbox");
    this.button.setAttribute("aria-expanded", "false");
    this.valueLabel = document.createElement("span");
    this.valueLabel.className = "setting-dropdown-value";
    const chevron = document.createElement("span");
    chevron.className = "setting-dropdown-chevron";
    chevron.append(createLucideIcon(ChevronDown, { size: 14 }));
    this.button.append(this.valueLabel, chevron);

    this.menu = document.createElement("div");
    this.menu.className = "setting-dropdown-menu";
    this.menu.setAttribute("role", "listbox");
    this.menu.hidden = true;
    this.options.forEach((option, index) => {
      const row = document.createElement("div");
      row.className = "setting-dropdown-option";
      row.setAttribute("role", "option");
      row.tabIndex = -1;
      const check = document.createElement("span");
      check.className = "setting-dropdown-check";
      check.append(createLucideIcon(Check, { size: 13 }));
      const label = document.createElement("span");
      label.className = "setting-dropdown-option-label";
      label.textContent = option.label;
      row.append(check, label);
      if (option.hint) {
        const hint = document.createElement("span");
        hint.className = "setting-dropdown-option-hint";
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

  private openMenu(activeIndex = Math.max(0, this.optionIndex(this._value))): void {
    if (!this.open) {
      this.open = true;
      this.menu.hidden = false;
      // Portal to <body>: ancestors like .setting-card clip overflow, which
      // would cut the popup off at the card boundary.
      this.menu.style.position = "fixed";
      document.body.append(this.menu);
      this.placeMenu();
      this.button.setAttribute("aria-expanded", "true");
      // Listener lives only while the menu is open — no lifecycle to manage.
      document.addEventListener("pointerdown", this.onDocPointerDown, true);
      window.addEventListener("scroll", this.onReposition, true);
      window.addEventListener("resize", this.onReposition);
    }
    this.setActive(activeIndex);
    this.rows[activeIndex]?.focus();
  }

  private closeMenu(): void {
    if (!this.open) return;
    this.open = false;
    this.menu.hidden = true;
    this.menu.style.position = "";
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
    const height = this.menu.offsetHeight;
    const below = window.innerHeight - rect.bottom;
    if (below < height + 8 && rect.top > height + 8) {
      this.menu.style.top = `${Math.round(rect.top - height - 6)}px`;
    } else {
      this.menu.style.top = `${Math.round(rect.bottom + 6)}px`;
    }
  }

  private setActive(index: number): void {
    this.activeIndex = index;
    this.rows.forEach((row, i) => row.classList.toggle("is-active", i === index));
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
