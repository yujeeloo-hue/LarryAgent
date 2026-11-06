/**
 * Native <select> popup windows follow the OS appearance on some Electron
 * platforms, even when the closed control uses `color-scheme: light`. Keep the
 * native control and its existing value/change wiring, but show an app-drawn
 * popup for Light. Scopes marked with data-app-select use the same popup in
 * every theme and platform, keeping graph editor menus on the app palette.
 * Popups opened for selects inside a [data-dark-island] scope carry the same
 * marker so they render with the island's Dark tokens (state/theme.ts).
 */

type OpenPopup = {
  select: HTMLSelectElement;
  menu: HTMLDivElement;
  options: HTMLOptionElement[];
  rows: HTMLDivElement[];
  activeIndex: number;
};

let nextPopupId = 0;

export function installSelectPopups(doc: Document = document): () => void {
  const win = doc.defaultView ?? window;
  let openPopup: OpenPopup | null = null;

  const isLight = (): boolean => doc.documentElement.dataset.theme === "light";
  const usesAppPopup = (select: HTMLSelectElement): boolean =>
    isLight() || select.closest("[data-app-select]") !== null;
  const asSelect = (target: EventTarget | null): HTMLSelectElement | null => {
    const element = target as Element | null;
    return element?.tagName === "SELECT" ? (element as HTMLSelectElement) : null;
  };
  const canSkin = (select: HTMLSelectElement): boolean =>
    !select.disabled && !select.multiple && (select.size || 0) <= 1;
  const isEnabled = (option: HTMLOptionElement): boolean =>
    !option.disabled && !(option.parentElement?.tagName === "OPTGROUP" &&
      (option.parentElement as HTMLOptGroupElement).disabled);

  const close = (restoreFocus = false): void => {
    const current = openPopup;
    if (!current) return;
    openPopup = null;
    current.menu.remove();
    current.select.removeAttribute("aria-expanded");
    current.select.removeAttribute("aria-controls");
    if (restoreFocus && current.select.isConnected) {
      current.select.focus({ preventScroll: true });
    }
  };

  const position = (): void => {
    const current = openPopup;
    if (!current) return;
    if (!current.select.isConnected || !usesAppPopup(current.select)) {
      close();
      return;
    }
    const rect = current.select.getBoundingClientRect();
    const menu = current.menu;
    const viewportWidth = win.innerWidth || doc.documentElement.clientWidth || 1024;
    const viewportHeight = win.innerHeight || doc.documentElement.clientHeight || 768;
    menu.style.minWidth = `${Math.round(Math.max(0, Math.min(rect.width, 420, viewportWidth - 16)))}px`;
    const menuWidth = menu.offsetWidth;
    const inset = 8;
    const left = Math.max(inset, Math.min(rect.left, viewportWidth - menuWidth - inset));
    const below = viewportHeight - rect.bottom - inset;
    const above = rect.top - inset;
    const placeAbove = below < menu.offsetHeight && above > below;
    menu.style.maxHeight = `${Math.max(32, Math.min(320, (placeAbove ? above : below) - 5))}px`;
    const top = placeAbove ? rect.top - menu.offsetHeight - 5 : rect.bottom + 5;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(Math.max(inset, top))}px`;
  };

  const focusRow = (current: OpenPopup, index: number): void => {
    if (index < 0 || index >= current.rows.length) return;
    const option = current.options[index];
    const row = current.rows[index];
    if (!option || !row || !isEnabled(option)) return;
    current.activeIndex = index;
    current.rows.forEach((row, i) => row.classList.toggle("is-active", i === index));
    row.focus({ preventScroll: true });
    row.scrollIntoView?.({ block: "nearest" });
  };

  const choose = (current: OpenPopup, index: number): void => {
    if (openPopup !== current) return;
    const option = current.options[index];
    if (!option || !isEnabled(option)) return;
    const changed = current.select.value !== option.value;
    current.select.value = option.value;
    close(true);
    if (changed) {
      current.select.dispatchEvent(new Event("input", { bubbles: true }));
      current.select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  const open = (select: HTMLSelectElement): void => {
    if (!canSkin(select)) return;
    close();
    const options = Array.from(select.options).filter((option) => !option.hidden);
    if (options.length === 0) return;
    const menu = doc.createElement("div");
    menu.className = "app-select-popup";
    menu.id = `app-select-popup-${++nextPopupId}`;
    if (select.closest("[data-dark-island]")) {
      menu.setAttribute("data-dark-island", "");
    }
    menu.setAttribute("role", "listbox");
    const label = select.getAttribute("aria-label") ?? select.name;
    if (label) menu.setAttribute("aria-label", label);
    const rows: HTMLDivElement[] = [];
    const current: OpenPopup = { select, menu, options, rows, activeIndex: -1 };

    options.forEach((option, index) => {
      const row = doc.createElement("div");
      row.className = "app-select-popup-option";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", option.selected ? "true" : "false");
      row.tabIndex = -1;
      row.textContent = option.label || option.textContent || "";
      if (!isEnabled(option)) {
        row.classList.add("is-disabled");
        row.setAttribute("aria-disabled", "true");
      }
      row.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        choose(current, index);
      });
      // Keyboard-generated clicks do not always emit pointerdown.
      row.addEventListener("click", (event) => {
        event.preventDefault();
        choose(current, index);
      });
      rows.push(row);
      menu.append(row);
    });

    doc.body.append(menu);
    openPopup = current;
    select.setAttribute("aria-expanded", "true");
    select.setAttribute("aria-controls", menu.id);
    position();
    const selected = options.findIndex((option) => option.selected && isEnabled(option));
    const firstEnabled = options.findIndex(isEnabled);
    focusRow(current, selected >= 0 ? selected : firstEnabled);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button != null && event.button !== 0) return;
    const select = asSelect(event.target);
    if (select && usesAppPopup(select) && canSkin(select)) {
      event.preventDefault();
      event.stopPropagation();
      if (openPopup?.select === select) close(true);
      else open(select);
      return;
    }
    if (openPopup && !openPopup.menu.contains(event.target as Node)) close();
  };

  // Chromium's platform picker opens on mousedown on some hosts. Cancelling
  // pointerdown alone is not sufficient on every Electron/macOS version.
  const preventNative = (event: MouseEvent): void => {
    if (event.button != null && event.button !== 0) return;
    const select = asSelect(event.target);
    if (select && usesAppPopup(select) && canSkin(select)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const current = openPopup;
    if (current && current.menu.contains(event.target as Node)) {
      const enabled = current.options
        .map((option, index) => isEnabled(option) ? index : -1)
        .filter((index) => index >= 0);
      let next = current.activeIndex;
      if (event.key === "ArrowDown") next = enabled.find((i) => i > next) ?? enabled[0] ?? -1;
      else if (event.key === "ArrowUp") next = [...enabled].reverse().find((i) => i < next) ?? enabled.at(-1) ?? -1;
      else if (event.key === "Home") next = enabled[0] ?? -1;
      else if (event.key === "End") next = enabled.at(-1) ?? -1;
      else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        choose(current, current.activeIndex);
        return;
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      } else if (event.key === "Tab") {
        close();
        return;
      } else return;
      event.preventDefault();
      event.stopPropagation();
      focusRow(current, next);
      return;
    }
    const select = asSelect(event.target);
    if (select && usesAppPopup(select) && canSkin(select) &&
      ["ArrowDown", "ArrowUp", "Enter", " ", "F4"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      open(select);
    } else if (current && event.key === "Escape") {
      close(true);
    }
  };

  const onThemeChange = (): void => {
    if (openPopup && !usesAppPopup(openPopup.select)) close();
  };
  const observer = typeof MutationObserver === "undefined" ? null :
    new MutationObserver(onThemeChange);
  observer?.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class"],
  });

  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("mousedown", preventNative, true);
  doc.addEventListener("click", preventNative, true);
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("scroll", position, true);
  win.addEventListener("resize", position);

  return () => {
    close();
    observer?.disconnect();
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("mousedown", preventNative, true);
    doc.removeEventListener("click", preventNative, true);
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("scroll", position, true);
    win.removeEventListener("resize", position);
  };
}
