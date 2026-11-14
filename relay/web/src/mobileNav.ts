/**
 * Mobile navigation layer (≤768px breakpoint): one shared sheet scrim for
 * every popover that becomes a bottom sheet on phones — the composer plus /
 * provider menus (composerControls.ts), the New Task workspace picker
 * (render.ts) and the device / project selector sheets (main.ts).
 *
 * Desktop keeps its absolute popovers; the scrim element is created lazily
 * but styled `display:none` outside the mobile media query, so wiring it
 * unconditionally is a no-op there.
 */

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

/**
 * Show the scrim (registering who knows how to close the owning sheet) or
 * hide it. Menu close paths call this with `open=false` after resetting
 * their own UI. An owner lets inactive menus close without dismissing
 * another sheet's backdrop; omitting it retains explicit close-all behavior.
 */
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

/**
 * Exclusive sheet opener: dismisses whatever sheet currently owns the scrim
 * (another selector sheet, a composer menu…) before opening this one.
 */
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

// ── popover menu mounting (stacking-context escape) ─────────────
// The pushed mobile .main is `position: absolute; z-index: 20` — a stacking
// context. Popover menus that restyle into bottom sheets (fixed, z 82) but
// live inside .main can never rise above the body-level scrim (z 80): the
// ancestor context clamps them. So on phones the open menu is re-parented
// to <body>; desktop (and breakpoint crossings) put it back on its anchor
// wrap so the absolute positioning works again.
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

/** Register a popover menu for phone/desktop mount coordination. */
export function mountPopoverMenu(menu: HTMLElement, home: HTMLElement): void {
  mountedMenus.set(menu, home);
  syncMenuMounts();
}
