
let scrimEl: HTMLElement | null = null;
let closeFn: (() => void) | null = null;
let scrimOwner: HTMLElement | null = null;

function ensureScrim(): HTMLElement {
  if (scrimEl?.isConnected) return scrimEl;
  scrimEl = document.createElement("div");
  scrimEl.className = "sheet-scrim";
  scrimEl.addEventListener("click", () => {
    const fn = closeFn;
    closeFn = null;
    scrimOwner = null;
    scrimEl!.classList.remove("is-open");
    fn?.();
  });
  document.body.append(scrimEl);
  return scrimEl;
}

export function syncMenuScrim(open: boolean, close?: () => void, owner?: HTMLElement): void {
  if (!open && owner && owner !== scrimOwner) return;
  const scrim = ensureScrim();
  if (open) {
    if (closeFn && owner && owner !== scrimOwner) {
      const previous = closeFn;
      closeFn = null;
      previous();
    }
    closeFn = close ?? null;
    scrimOwner = owner ?? null;
    scrim.classList.add("is-open");
  } else {
    closeFn = null;
    scrimOwner = null;
    scrim.classList.remove("is-open");
  }
}

export function openSheetPanel(sheet: HTMLElement, trigger?: HTMLElement | null): void {
  sheet.classList.add("is-open");
  trigger?.classList.add("is-open");
  trigger?.setAttribute("aria-expanded", "true");
  syncMenuScrim(true, () => {
    sheet.classList.remove("is-open");
    trigger?.classList.remove("is-open");
    trigger?.setAttribute("aria-expanded", "false");
  }, sheet);
}

const mobileBreakpoint = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(max-width: 768px)")
  : null;

const mountedMenus = new Map<HTMLElement, HTMLElement>();

function syncMenuMounts(): void {
  const phone = mobileBreakpoint?.matches === true;
  for (const [menu, home] of mountedMenus) {
    if (!menu.isConnected) {
      mountedMenus.delete(menu);
      continue;
    }
    const want = phone ? document.body : home;
    if (menu.parentElement !== want) want.append(menu);
  }
}

if (mobileBreakpoint && typeof mobileBreakpoint.addEventListener === "function") {
  mobileBreakpoint.addEventListener("change", () => syncMenuMounts());
}

export function mountPopoverMenu(menu: HTMLElement, home: HTMLElement): void {
  mountedMenus.set(menu, home);
  syncMenuMounts();
}
