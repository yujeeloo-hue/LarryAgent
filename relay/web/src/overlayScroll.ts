/**
 * macOS-style overlay scrollbars for the Remote console.
 *
 * Windows Chrome draws classic always-on scrollbars that claim ~17px of
 * layout; the Mac client rides the system overlay `NSScroller` — a floating
 * capsule that appears on scroll and fades out. Ported from the proven
 * JNote web solution (lib/ui/overlayScroll.ts), adapted for this vanilla-TS
 * app whose DOM is rebuilt wholesale via `replaceChildren`:
 *
 *   1. A wired scroller's native scrollbar is hidden (`.ob-native-hidden`).
 *   2. A capsule thumb (`.ob-thumb`) is appended to the scroller's parent
 *      (the host), which becomes `position: relative` when static. The thumb
 *      fades in on scroll, fades out `IDLE_DELAY_MS` after the last scroll
 *      event, and is draggable.
 *   3. `initOverlayScrollbars()` watches the whole document with a
 *      MutationObserver and wires every scroller automatically — no
 *      per-render call sites to maintain. Removed scrollers are disposed on
 *      the next mutation batch.
 *
 * Positioning uses bounding-rect deltas between scroller and host rather
 * than offset chains or a CSS `right` anchor: auto-wired hosts don't always
 * bound their scroller exactly (e.g. `.sidebar` inside `.layout`), and rect
 * deltas are immune to that.
 */

import { CONVERSATION_SCROLL_INTENT } from "../../../src/renderer/src/ui/ConversationAutoScroll.js";

/** Capsule thickness, in px. */
const THUMB_SIZE = 7;
/** Gap between the capsule and the scroller edge, in px. */
const THUMB_INSET = 3;
/** Shortest capsule allowed, so huge lists stay grabbable. */
const THUMB_MIN_LENGTH = 28;
/** Idle time after scrolling stops before the capsule fades out. */
const IDLE_DELAY_MS = 700;

export type ScrollAxis = "x" | "y";

/** Pure thumb geometry so the maths stays unit-testable without a DOM. */
export interface ThumbGeometry {
  /** Capsule length along the axis, px. */
  length: number;
  /** Capsule offset from the track origin, px. */
  offset: number;
}

/**
 * Computes capsule length/offset for a track of `viewportLen` showing
 * `contentLen` of content at `scrollPos`. Mirrors NSScroller knob math:
 * length is proportional to the visible fraction (clamped to
 * `THUMB_MIN_LENGTH` and to the viewport itself), offset divides the
 * leftover travel by the scroll ratio.
 */
export function computeThumbGeometry(
  viewportLen: number,
  contentLen: number,
  scrollPos: number,
): ThumbGeometry {
  const maxScroll = Math.max(0, contentLen - viewportLen);
  const raw = viewportLen * (viewportLen / Math.max(1, contentLen));
  const length = Math.min(viewportLen, Math.max(THUMB_MIN_LENGTH, Math.round(raw)));
  const travel = Math.max(0, viewportLen - length);
  const clamped = Math.min(Math.max(scrollPos, 0), maxScroll);
  const offset = maxScroll > 0 ? Math.round((clamped / maxScroll) * travel) : 0;
  return { length, offset };
}

interface AxisThumb {
  axis: ScrollAxis;
  el: HTMLElement;
  hideTimer: ReturnType<typeof setTimeout> | null;
  /** Track start along the axis, in host coordinates. */
  origin: number;
  /** Capsule line position on the cross axis, in host coordinates. */
  edge: number;
  trackLen: number;
  thumbLen: number;
  maxScroll: number;
}

/**
 * Wires one scroller to one host element (the thumb is appended there).
 * Handles both axes; a thumb stays `display: none` while its axis has
 * nothing to scroll. Idempotent per element pair; returns a dispose
 * function that removes thumbs, listeners and observers.
 */
export function attachOverlayScrollbar(
  scroller: HTMLElement,
  host: HTMLElement,
  axes: readonly ScrollAxis[] = ["y"],
): () => void {
  const thumbs: AxisThumb[] = [];
  for (const axis of axes) {
    const el = document.createElement("div");
    el.className = "ob-thumb";
    el.setAttribute("data-axis", axis);
    el.setAttribute("aria-hidden", "true");
    el.style.display = "none";
    thumbs.push({ axis, el, hideTimer: null, origin: 0, edge: 0, trackLen: 1, thumbLen: 0, maxScroll: 0 });
  }

  let disposed = false;
  scroller.classList.add("ob-native-hidden");
  for (const t of thumbs) host.appendChild(t.el);

  function measure(t: AxisThumb): void {
    const vertical = t.axis === "y";
    const hostRect = host.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const trackLen = vertical ? scroller.clientHeight : scroller.clientWidth;
    const contentLen = vertical ? scroller.scrollHeight : scroller.scrollWidth;
    t.maxScroll = Math.max(0, contentLen - trackLen);
    if (hostRect.width === 0 || hostRect.height === 0 || t.maxScroll <= 1) {
      // Hidden view or nothing to scroll: keep the capsule out of the way.
      if (t.hideTimer) clearTimeout(t.hideTimer);
      t.hideTimer = null;
      t.el.classList.remove("ob-show");
      t.el.style.display = "none";
      return;
    }
    t.el.style.display = "";
    t.trackLen = trackLen;
    // Track box in host coordinates (rect deltas survive padded/oversized
    // hosts and transformed ancestors alike).
    t.origin = vertical ? scrollerRect.top - hostRect.top : scrollerRect.left - hostRect.left;
    t.edge = vertical
      ? scrollerRect.left - hostRect.left + scrollerRect.width - THUMB_INSET - THUMB_SIZE
      : scrollerRect.top - hostRect.top + scrollerRect.height - THUMB_INSET - THUMB_SIZE;
    position(t);
  }

  function position(t: AxisThumb): void {
    const vertical = t.axis === "y";
    const scrollPos = vertical ? scroller.scrollTop : scroller.scrollLeft;
    const { length, offset } = computeThumbGeometry(t.trackLen, t.trackLen + t.maxScroll, scrollPos);
    t.thumbLen = length;
    if (vertical) {
      t.el.style.width = `${THUMB_SIZE}px`;
      t.el.style.height = `${length}px`;
      t.el.style.transform = `translate(${t.edge}px, ${t.origin + offset}px)`;
    } else {
      t.el.style.width = `${length}px`;
      t.el.style.height = `${THUMB_SIZE}px`;
      t.el.style.transform = `translate(${t.origin + offset}px, ${t.edge}px)`;
    }
  }

  function remeasureAll(): void {
    for (const t of thumbs) measure(t);
  }

  function show(t: AxisThumb): void {
    if (t.maxScroll <= 0) return;
    t.el.classList.add("ob-show");
    if (t.hideTimer) clearTimeout(t.hideTimer);
    t.hideTimer = setTimeout(() => {
      if (!disposed) t.el.classList.remove("ob-show");
    }, IDLE_DELAY_MS);
  }

  function onScroll(): void {
    remeasureAll();
    for (const t of thumbs) show(t);
  }

  /** Thumb drag: maps pointer travel to scroll via the knob ratio. */
  function onPointerDown(t: AxisThumb, event: PointerEvent): void {
    event.preventDefault();
    // Thumbs can be siblings of their scrollport, so pointer events alone
    // cannot tell the conversation that the reader took over scrolling.
    scroller.dispatchEvent(new Event(CONVERSATION_SCROLL_INTENT, { bubbles: true }));
    const vertical = t.axis === "y";
    t.el.setPointerCapture(event.pointerId);
    t.el.classList.add("ob-drag");
    if (t.hideTimer) {
      clearTimeout(t.hideTimer);
      t.hideTimer = null;
    }
    const startPos = vertical ? event.clientY : event.clientX;
    const startScroll = vertical ? scroller.scrollTop : scroller.scrollLeft;
    const travel = Math.max(0, t.trackLen - t.thumbLen);

    function onMove(move: PointerEvent): void {
      if (travel <= 0 || t.maxScroll <= 0) return;
      scroller.dispatchEvent(new Event(CONVERSATION_SCROLL_INTENT, { bubbles: true }));
      const delta = (vertical ? move.clientY : move.clientX) - startPos;
      const ratio = Math.min(1, Math.max(0, startScroll / t.maxScroll + delta / travel));
      if (vertical) scroller.scrollTop = ratio * t.maxScroll;
      else scroller.scrollLeft = ratio * t.maxScroll;
    }

    function onUp(): void {
      t.el.classList.remove("ob-drag");
      t.el.removeEventListener("pointermove", onMove);
      t.el.removeEventListener("pointerup", onUp);
      t.el.removeEventListener("pointercancel", onUp);
      show(t);
    }

    t.el.addEventListener("pointermove", onMove);
    t.el.addEventListener("pointerup", onUp);
    t.el.addEventListener("pointercancel", onUp);
  }

  function onInput(): void {
    // Typing changes scrollHeight line by line; re-measure, don't flash.
    remeasureAll();
  }

  scroller.addEventListener("scroll", onScroll, { passive: true });
  for (const t of thumbs) {
    t.el.addEventListener("pointerdown", (e) => onPointerDown(t, e));
  }
  if (scroller instanceof HTMLTextAreaElement || scroller instanceof HTMLInputElement) {
    scroller.addEventListener("input", onInput);
  }
  // Container and content resizes (window resize, view swaps, flex reflow)
  // recompute the track; typing re-measures via the input listener above.
  const observer =
    typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => remeasureAll()) : null;
  observer?.observe(scroller);
  observer?.observe(host);

  remeasureAll();

  return function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const t of thumbs) {
      if (t.hideTimer) clearTimeout(t.hideTimer);
    }
    scroller.removeEventListener("scroll", onScroll);
    scroller.removeEventListener("input", onInput);
    observer?.disconnect();
    scroller.classList.remove("ob-native-hidden");
    for (const t of thumbs) t.el.remove();
  };
}

/* ── auto-wiring ─────────────────────────────────────────────── */

const SCROLLABLE_OVERFLOW = new Set(["auto", "scroll", "overlay"]);
/** All wired scrollers → dispose (strong refs; the set is pruned per batch). */
const wired = new Map<HTMLElement, () => void>();
let observer: MutationObserver | null = null;
let scanScheduled = false;
const pendingRoots = new Set<ParentNode>();

function isScroller(node: Node): node is HTMLElement {
  if (!(node instanceof HTMLElement)) return false;
  if (node === document.body || node === document.documentElement) return false;
  if (node.classList.contains("ob-thumb")) return false;
  const cs = getComputedStyle(node);
  return SCROLLABLE_OVERFLOW.has(cs.overflowY) || SCROLLABLE_OVERFLOW.has(cs.overflowX);
}

function hostFor(scroller: HTMLElement): HTMLElement | null {
  const host = scroller.parentElement;
  if (!host || host === document.body) return null;
  // Only flip static hosts to `position: relative`; an already-positioned
  // host is a containing block already and must keep its own positioning.
  if (getComputedStyle(host).position === "static") host.classList.add("ob-host");
  return host;
}

function maybeWire(node: Node): void {
  if (!(node instanceof HTMLElement)) return;
  if (wired.has(node)) return;
  if (!isScroller(node)) return;
  const host = hostFor(node);
  if (!host) return;
  wired.set(node, attachOverlayScrollbar(node, host, ["x", "y"]));
}

/** Wire `root` itself plus every element beneath it. */
function scanRoot(root: ParentNode): void {
  if (root instanceof Element) maybeWire(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  // TreeWalker.nextNode() skips the root, hence maybeWire(root) above.
  while (walker.nextNode()) maybeWire(walker.currentNode);
}

function pruneRemoved(): void {
  for (const [scroller, dispose] of wired) {
    if (!scroller.isConnected) {
      dispose();
      wired.delete(scroller);
    }
  }
}

function processBatch(): void {
  scanScheduled = false;
  const roots = [...pendingRoots];
  pendingRoots.clear();
  pruneRemoved();
  for (const root of roots) {
    scanRoot(root);
    // Content growth can make an ANCESTOR scrollable (e.g. `.col-body`
    // filling up) — the added-node subtree alone would miss it.
    let up = root instanceof Element ? root.parentElement : null;
    while (up && up !== document.body) {
      maybeWire(up);
      up = up.parentElement;
    }
  }
}

function scheduleScan(root: ParentNode): void {
  pendingRoots.add(root);
  if (scanScheduled) return;
  scanScheduled = true;
  requestAnimationFrame(processBatch);
}

/**
 * Wires every scroller already in the document and observes the DOM so
 * future scrollers (rendered views, tool cards, streamed messages) are
 * wired automatically. Call once at boot; safe to call twice.
 */
export function initOverlayScrollbars(): void {
  if (observer || typeof MutationObserver === "undefined") return;
  scanRoot(document.body);
  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "childList") {
        // Removals re-scan the surviving parent (drives the prune pass);
        // additions scan the added nodes themselves so streaming appends
        // stay O(delta) instead of re-walking the whole transcript.
        if (record.removedNodes.length > 0) scheduleScan(record.target as ParentNode);
        for (const node of record.addedNodes) {
          scheduleScan(node instanceof Element ? node : (node.parentNode ?? record.target) as ParentNode);
        }
      } else {
        // Attribute flips can turn a plain div into a scroller.
        scheduleScan(record.target as ParentNode);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
}
