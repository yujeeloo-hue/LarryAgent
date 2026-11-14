/** Hover tip that escapes inspector overflow by living on `document.body`.
 *  Body-level island floaters carry [data-dark-island] so they keep the
 *  editor's Dark tokens under the Light app theme (see state/theme.ts). */

let tipEl: HTMLDivElement | null = null;

/** Rich details tip (title + subtitle + scrollable body, pointer can enter). */
let richTip: {
  root: HTMLDivElement;
  title: HTMLDivElement;
  subtitle: HTMLDivElement;
  body: HTMLDivElement;
} | null = null;

let richHideTimer: number | null = null;
/** Pinned float: shown by a [?] click, stays until explicitly dismissed. */
let richPinned = false;
let richAnchor: HTMLElement | null = null;

function ensureTip(): HTMLDivElement {
  if (tipEl) return tipEl;
  tipEl = document.createElement("div");
  tipEl.className = "graph-editor-float-tip";
  tipEl.setAttribute("data-dark-island", "");
  tipEl.setAttribute("role", "tooltip");
  tipEl.hidden = true;
  document.body.append(tipEl);
  return tipEl;
}

function ensureRichTip() {
  if (richTip) return richTip;
  const root = document.createElement("div");
  root.className = "graph-editor-details-tip";
  root.setAttribute("data-dark-island", "");
  root.setAttribute("role", "tooltip");
  const title = document.createElement("div");
  title.className = "graph-editor-details-tip-title";
  const subtitle = document.createElement("div");
  subtitle.className = "graph-editor-details-tip-subtitle";
  const body = document.createElement("div");
  body.className = "graph-editor-details-tip-body";
  root.append(title, subtitle, body);
  root.addEventListener("pointerenter", cancelRichHide);
  root.addEventListener("pointerleave", hideDetailsTip);
  // Click outside dismisses a pinned float.
  document.addEventListener("pointerdown", (ev) => {
    const node = ev.target;
    if (!(node instanceof Element)) return;
    if (richTip?.root.contains(node)) return;
    if (richAnchor?.contains(node)) return;
    hideDetailsTip();
  });
  document.body.append(root);
  richTip = { root, title, subtitle, body };
  return richTip;
}

export function bindInspectorTip(
  target: HTMLElement,
  text: string | null | undefined,
): void {
  const body = text?.trim();
  if (!body) return;
  target.classList.add("graph-editor-has-tip");
  target.addEventListener("pointerenter", () => showInspectorTip(target, body));
  target.addEventListener("pointerleave", hideInspectorTip);
}

/**
 * Action-details hover: rich card with a short delay before hiding so the
 * pointer can move onto the tip and scroll long text. With `pinOnClick`,
 * clicking the target pins the float open (same look) until it is dismissed
 * by another click on the target, a click outside, or leaving the float.
 */
export function bindDetailsTip(
  target: HTMLElement,
  options: { title: string; subtitle?: string | null; body: string | null },
  pinOptions?: { pinOnClick?: boolean },
): void {
  const body = options.body?.trim();
  if (!body) return;
  target.addEventListener("pointerenter", () => {
    if (!(richPinned && richAnchor === target)) {
      richPinned = false;
    }
    showDetailsTipOn(target, options);
  });
  target.addEventListener("pointerleave", () => {
    if (richPinned && richAnchor === target) return;
    scheduleRichHide();
  });
  if (pinOptions?.pinOnClick) {
    target.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (richPinned && richAnchor === target) {
        hideDetailsTip();
        return;
      }
      showDetailsTipOn(target, options);
      richPinned = true;
    });
  }
}

function showDetailsTipOn(
  target: HTMLElement,
  options: { title: string; subtitle?: string | null; body: string | null },
): void {
  const tip = ensureRichTip();
  tip.title.textContent = options.title;
  tip.subtitle.textContent = options.subtitle?.trim() ?? "";
  tip.subtitle.hidden = !options.subtitle?.trim();
  tip.body.replaceChildren(
    ...detailParagraphsOf(options.body?.trim() ?? "").map((text) => {
      const p = document.createElement("p");
      p.textContent = text;
      return p;
    }),
  );
  if (richHideTimer !== null) {
    window.clearTimeout(richHideTimer);
    richHideTimer = null;
  }
  richAnchor = target;
  positionDetailsTip(target);
  tip.root.classList.add("is-visible");
}

function detailParagraphsOf(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function positionDetailsTip(target: HTMLElement): void {
  const tip = ensureRichTip();
  tip.root.style.left = "0px";
  tip.root.style.top = "0px";
  const rect = target.getBoundingClientRect();
  const width = tip.root.offsetWidth;
  const height = tip.root.offsetHeight;
  // Prefer the inspector side (tips are bound inside the inspector or the
  // action overlay, both left-docked); flip left when clipped.
  let left = rect.right + 8;
  if (left + width > window.innerWidth - 8) {
    left = Math.max(8, rect.left - width - 8);
  }
  let top = rect.top;
  if (top + height > window.innerHeight - 8) {
    top = Math.max(8, window.innerHeight - height - 8);
  }
  tip.root.style.left = `${left}px`;
  tip.root.style.top = `${top}px`;
}

function scheduleRichHide(): void {
  if (richHideTimer !== null) window.clearTimeout(richHideTimer);
  richHideTimer = window.setTimeout(hideDetailsTip, 180);
}

function cancelRichHide(): void {
  if (richHideTimer !== null) {
    window.clearTimeout(richHideTimer);
    richHideTimer = null;
  }
}

export function hideDetailsTip(): void {
  cancelRichHide();
  richPinned = false;
  richAnchor = null;
  richTip?.root.classList.remove("is-visible");
}

export function hideInspectorTip(): void {
  hideDetailsTip();
  if (!tipEl) return;
  tipEl.hidden = true;
}

export function disposeInspectorTip(): void {
  hideInspectorTip();
  tipEl?.remove();
  tipEl = null;
  richTip?.root.remove();
  richTip = null;
}

function showInspectorTip(target: HTMLElement, text: string): void {
  const el = ensureTip();
  el.textContent = text;
  el.hidden = false;
  el.style.left = "8px";
  el.style.top = "8px";
  const rect = target.getBoundingClientRect();
  const tipRect = el.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + 6;
  if (left + tipRect.width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - tipRect.width - 8);
  }
  if (top + tipRect.height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - tipRect.height - 6);
  }
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${top}px`;
}
