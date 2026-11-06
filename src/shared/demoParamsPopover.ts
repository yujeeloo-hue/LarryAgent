/** The same non-modal parameter popover for desktop and Relay demo cards. */

/**
 * lucide v1.33 sliders-horizontal, paths verbatim from the desktop app's
 * bundled lucide (ISC) — the FAB glyph matches Mac rendering 1:1.
 */
const PARAMS_TOGGLE_ICON =
  '<svg class="content-card-demo-params-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/></svg>';

let nextPopoverId = 0;

/** Visible listbox rows before it scrolls (user-confirmed 2026-10-27). */
const DEMO_SELECT_MAX_ROWS = 6;

let openDemoSelect: { close: () => void } | null = null;
let nextDemoSelectId = 0;

/** Close the app-drawn select list, if one is open (popover close hook). */
function closeOpenDemoSelect(): void {
  openDemoSelect?.close();
}

export type DemoSelectControl = {
  el: HTMLButtonElement;
  /** Silent value sync (no onChange) — used when a panel rebuilds. */
  setValue: (value: string) => void;
  setDisabled: (disabled: boolean) => void;
  close: () => void;
};

/**
 * Select-type demo param rendered as an app-drawn combobox + listbox.
 * Chromium paints native <select> popups BELOW the top layer, so inside the
 * params popover the native dropdown opened behind the panel and nothing
 * could be picked. The listbox is parented to the popover itself (same top
 * layer → always above it) and position: fixed (escapes the form's scroll
 * clipping). Keyboard: arrows / Home / End / Enter / Esc / type-ahead;
 * Esc closes the list FIRST (capture + preventDefault) so the auto popover
 * survives. Design user-confirmed 2026-10-27 (max 6 rows, flip-up, check +
 * accent tint marker, 120ms open motion under prefers-reduced-motion).
 */
export function createDemoSelectControl(opts: {
  label: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
}): DemoSelectControl {
  const options = opts.options;
  let current = options.includes(opts.value) ? opts.value : options[0] ?? "";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "content-card-demo-control content-card-demo-select";
  btn.setAttribute("role", "combobox");
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  const valueSpan = document.createElement("span");
  valueSpan.className = "content-card-demo-select-value";
  valueSpan.textContent = current;
  btn.append(valueSpan);
  const listId = `demo-select-${++nextDemoSelectId}`;

  let list: HTMLUListElement | null = null;
  let rows: HTMLLIElement[] = [];
  let active = -1;

  const setActive = (index: number, scroll: boolean): void => {
    if (rows.length === 0) return;
    active = ((index % rows.length) + rows.length) % rows.length;
    rows.forEach((row, i) => row.classList.toggle("is-active", i === active));
    const row = rows[active];
    if (!row) return;
    btn.setAttribute("aria-activedescendant", row.id);
    if (scroll) row.scrollIntoView?.({ block: "nearest" });
  };

  const place = (): void => {
    if (!list) return;
    const rect = btn.getBoundingClientRect();
    list.style.width = `${Math.max(rect.width, 140)}px`;
    const rowH = rows[0]?.offsetHeight || 30;
    const maxH = DEMO_SELECT_MAX_ROWS * rowH + 8;
    list.style.maxHeight = `${maxH}px`;
    const box = list.getBoundingClientRect();
    const needed = Math.min(box.height > 0 ? box.height : maxH, maxH);
    const margin = 8;
    const below = window.innerHeight - rect.bottom - margin;
    const above = rect.top - margin;
    const flip = below < Math.min(needed, rowH * 3) && above > below;
    const top = flip ? rect.top - needed - 6 : rect.bottom + 6;
    list.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - needed - margin))}px`;
    list.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin))}px`;
  };

  const onDocKeyDown = (event: Event): void => {
    if (!list || (event as KeyboardEvent).key !== "Escape") return;
    if ((event as KeyboardEvent).defaultPrevented) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  };
  const onDocPointerDown = (event: Event): void => {
    if (!list) return;
    const target = event.target;
    if (target instanceof Node && !list.contains(target) && !btn.contains(target)) close();
  };
  const onDocScroll = (event: Event): void => {
    if (!list) return;
    if (event.target instanceof Node && list.contains(event.target)) return;
    place();
  };
  const onViewportChange = (): void => place();

  const bind = (): void => {
    document.addEventListener("keydown", onDocKeyDown, true);
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("scroll", onDocScroll, true);
    window.addEventListener("resize", onViewportChange);
    window.visualViewport?.addEventListener("resize", onViewportChange);
    window.visualViewport?.addEventListener("scroll", onViewportChange);
  };
  const unbind = (): void => {
    document.removeEventListener("keydown", onDocKeyDown, true);
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("scroll", onDocScroll, true);
    window.removeEventListener("resize", onViewportChange);
    window.visualViewport?.removeEventListener("resize", onViewportChange);
    window.visualViewport?.removeEventListener("scroll", onViewportChange);
  };

  const open = (): void => {
    if (list || btn.disabled || options.length === 0) return;
    closeOpenDemoSelect();
    const popup = document.createElement("ul");
    popup.id = listId;
    popup.className = "content-card-demo-listbox";
    popup.setAttribute("role", "listbox");
    popup.setAttribute("aria-label", opts.label);
    rows = options.map((option, i) => {
      const row = document.createElement("li");
      row.id = `${listId}-opt-${i}`;
      row.className = "content-card-demo-option";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(option === current));
      row.textContent = option;
      row.insertAdjacentHTML(
        "beforeend",
        '<svg class="content-card-demo-option-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
      );
      row.addEventListener("pointerenter", () => setActive(i, false));
      row.addEventListener("click", () => pick(i));
      return row;
    });
    popup.append(...rows);
    // Parent to the popover (top layer) — never document.body, which the
    // popover itself would cover.
    (btn.closest(".content-card-demo-params-popover") ?? document.body).append(popup);
    list = popup;
    openDemoSelect = api;
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-controls", listId);
    setActive(Math.max(0, options.indexOf(current)), true);
    bind();
    place();
    requestAnimationFrame(place);
  };

  const close = (): void => {
    if (!list) return;
    if (openDemoSelect === api) openDemoSelect = null;
    unbind();
    list.remove();
    list = null;
    rows = [];
    active = -1;
    btn.setAttribute("aria-expanded", "false");
    btn.removeAttribute("aria-controls");
    btn.removeAttribute("aria-activedescendant");
  };

  const pick = (index: number): void => {
    const option = options[index];
    if (option === undefined) return;
    current = option;
    valueSpan.textContent = option;
    close();
    opts.onChange(option);
  };

  const typeahead = (ch: string): void => {
    const needle = ch.toLowerCase();
    for (let k = 0; k < options.length; k++) {
      const i = (active + 1 + k) % options.length;
      if (options[i]!.toLowerCase().startsWith(needle)) {
        if (list) setActive(i, true);
        else pick(i);
        return;
      }
    }
  };

  btn.addEventListener("click", (event) => {
    event.preventDefault();
    if (list) close();
    else open();
  });
  btn.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!list) open();
        else setActive(active + 1, true);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!list) open();
        else setActive(active - 1, true);
        break;
      case "Home":
        if (list) {
          event.preventDefault();
          setActive(0, true);
        }
        break;
      case "End":
        if (list) {
          event.preventDefault();
          setActive(rows.length - 1, true);
        }
        break;
      case "Enter":
      case " ":
        if (list) {
          event.preventDefault();
          pick(active);
        }
        break;
      case "Escape":
        if (list) {
          event.preventDefault();
          event.stopImmediatePropagation();
          close();
        }
        break;
      default:
        if (event.key.length === 1) typeahead(event.key);
    }
  });

  const api: DemoSelectControl = {
    el: btn,
    setValue(value: string): void {
      if (!options.includes(value)) return;
      current = value;
      valueSpan.textContent = value;
    },
    setDisabled(disabled: boolean): void {
      btn.disabled = disabled;
      if (disabled) close();
    },
    close,
  };
  return api;
}

/**
 * Circular params toggle floating inside the preview window (host) + the
 * non-modal popover (user-confirmed 2026-10-27: bottom-right anchor, icon
 * only — the count lives in the aria-label and the CSS tooltip).
 * Returns the toggle so callers can disable it once the card settles
 * (null when there are no params to show).
 */
export function appendDemoParamsPopover(
  root: HTMLElement,
  host: HTMLElement,
  form: HTMLElement,
  count: number,
): HTMLButtonElement | null {
  form.hidden = true;
  if (count === 0) {
    root.append(form);
    return null;
  }

  const id = `demo-params-${++nextPopoverId}`;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "content-card-demo-params-toggle";
  toggle.innerHTML = PARAMS_TOGGLE_ICON;
  toggle.setAttribute("aria-label", `Parameters (${count})`);
  toggle.setAttribute("aria-haspopup", "dialog");
  toggle.setAttribute("aria-controls", id);
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("popovertarget", id);

  const popup = document.createElement("div");
  popup.id = id;
  popup.className = "content-card-demo-params-popover";
  popup.setAttribute("popover", "auto");
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-labelledby", `${id}-title`);
  const header = document.createElement("div");
  header.className = "content-card-demo-params-head";
  const title = document.createElement("span");
  title.id = `${id}-title`;
  title.textContent = "Parameters";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "content-card-demo-params-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close parameters");
  close.setAttribute("autofocus", "");
  header.append(title, close);
  popup.append(header, form);
  host.append(toggle);
  root.append(popup);

  let open = false;
  const dismiss = (): void => popup.hidePopover();
  const onScroll = (event: Event): void => {
    // Keep the popup open when its own parameter list scrolls.
    if (event.target instanceof Node && popup.contains(event.target)) return;
    position();
  };
  popup.addEventListener("beforetoggle", (event) => {
    open = (event as ToggleEvent).newState === "open";
    form.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      document.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", position);
      window.visualViewport?.addEventListener("resize", position);
      window.visualViewport?.addEventListener("scroll", position);
    } else {
      // Popover light-dismissed — drop any open app-drawn select list too.
      closeOpenDemoSelect();
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    }
  });

  const position = (): void => {
    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const x = viewport?.offsetLeft ?? 0;
    const y = viewport?.offsetTop ?? 0;
    const margin = 12;
    popup.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
    popup.style.maxHeight = `${Math.min(360, Math.max(0, height - margin * 2))}px`;
    const anchor = toggle.getBoundingClientRect();
    const box = popup.getBoundingClientRect();
    const above = anchor.top - y - margin;
    const below = y + height - anchor.bottom - margin;
    const top = above >= box.height + 8 || above > below
      ? anchor.top - box.height - 8
      : anchor.bottom + 8;
    const clamp = (value: number, min: number, max: number): number =>
      Math.max(min, Math.min(value, max));
    popup.style.left = `${clamp(anchor.left, x + margin, x + width - box.width - margin)}px`;
    popup.style.top = `${clamp(top, y + margin, y + height - box.height - margin)}px`;
  };
  toggle.addEventListener("click", (event) => {
    event.preventDefault();
    if (open) {
      dismiss();
    } else {
      popup.showPopover();
      position();
    }
  });
  close.addEventListener("click", () => {
    dismiss();
    toggle.focus({ preventScroll: true });
  });
  return toggle;
}
