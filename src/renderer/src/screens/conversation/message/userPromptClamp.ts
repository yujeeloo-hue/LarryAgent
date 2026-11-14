/**
 * Long user prompts collapse to a 3-line preview with an animated toggle.
 * Presentation only — no session/message knowledge.
 */

import { ChevronDown, ChevronUp } from "lucide";
import { createLucideIcon } from "../../../ui/originalIcons.js";
import { animateFold, settleFold } from "../foldAnimation.js";

const MAX_LINES = 3;
/** Sub-pixel line heights make an exactly-3-line prompt look overflowing. */
const OVERFLOW_SLOP_PX = 2;
/** Chips/cards that stay outside the 3-line prose clamp: attachment chips
 * and demo confirm summary cards (plan §4 — cards are not prose). */
const PINNED_SELECTOR = ".content-card-attachment, .content-card-demo-confirm";
const clampCleanups = new WeakMap<HTMLElement, () => void>();

/**
 * Wrap the prompt body in a clamp region. Measurement needs layout, so the
 * decision is made once the row is attached and re-checked on resize (wrapping
 * changes with the window width).
 */
export function applyUserPromptClamp(body: HTMLElement): void {
  clampCleanups.get(body)?.();
  // Attachments stay visible: they are chips, not prose, and hiding them would
  // make a collapsed prompt look like it lost its files.
  const pinned = Array.from(
    body.querySelectorAll<HTMLElement>(`:scope > ${PINNED_SELECTOR}`),
  );
  const prose = Array.from(body.childNodes).filter(
    (node) => !pinned.includes(node as HTMLElement),
  );
  if (prose.length === 0) return;

  const content = document.createElement("div");
  content.className = "conversation-prompt-clamp-content";
  content.append(...prose);

  const clamp = document.createElement("div");
  clamp.className = "conversation-prompt-clamp";
  clamp.append(content);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "conversation-prompt-clamp-toggle";
  toggle.hidden = true;

  body.replaceChildren(clamp, toggle, ...pinned);

  let expanded = false;
  let collapsedHeight = 0;
  let overflowing = false;

  function syncToggle(): void {
    toggle.replaceChildren(
      createLucideIcon(expanded ? ChevronUp : ChevronDown, { size: 13 }),
      document.createTextNode(expanded ? "Show less" : "Show more"),
    );
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  function measure(): void {
    if (!content.isConnected) return;
    const lineHeight =
      Number.parseFloat(window.getComputedStyle(content).lineHeight) || 0;
    if (lineHeight <= 0) return;
    collapsedHeight = Math.round(lineHeight * MAX_LINES);
    overflowing = content.scrollHeight - collapsedHeight > OVERFLOW_SLOP_PX;
    toggle.hidden = !overflowing;
    clamp.classList.toggle("is-clamped", overflowing && !expanded);
    if (!overflowing || expanded) {
      clamp.style.maxHeight = "none";
      return;
    }
    settleFold(clamp, false, { fade: false, collapsedHeight });
  }

  toggle.addEventListener("click", () => {
    if (!overflowing) return;
    expanded = !expanded;
    clamp.classList.toggle("is-clamped", !expanded);
    syncToggle();
    void animateFold(clamp, expanded, { fade: false, collapsedHeight });
  });

  syncToggle();

  let rafId = 0;
  function scheduleMeasure(): void {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      measure();
    });
  }

  scheduleMeasure();

  if (typeof ResizeObserver === "function") {
    // Only *width* changes can change wrapping. Reacting to height would feed
    // our own max-height write back in, which Chromium reports as a
    // ResizeObserver loop; the write is also deferred out of the callback.
    let lastWidth = -1;
    const observer = new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect.width ?? 0;
      if (Math.abs(width - lastWidth) < 1) return;
      lastWidth = width;
      scheduleMeasure();
    });
    observer.observe(content);
    clampCleanups.set(body, () => {
      observer.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      clampCleanups.delete(body);
    });
  } else {
    clampCleanups.set(body, () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      clampCleanups.delete(body);
    });
  }
}

/** Disconnect prompt observers before a conversation DOM tree is discarded. */
export function disposeUserPromptClamps(root: ParentNode): void {
  for (const body of root.querySelectorAll<HTMLElement>(
    ".conversation-msg-user .conversation-msg-body",
  )) {
    clampCleanups.get(body)?.();
  }
}
