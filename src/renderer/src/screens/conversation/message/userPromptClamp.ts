
import { ChevronDown, ChevronUp } from "lucide";
import { createLucideIcon } from "../../../ui/originalIcons.js";
import { animateFold, settleFold } from "../foldAnimation.js";

const MAX_LINES = 3;
const OVERFLOW_SLOP_PX = 2;
const PINNED_SELECTOR = ".content-card-attachment, .content-card-demo-confirm";
const clampCleanups = new WeakMap<HTMLElement, () => void>();

export function applyUserPromptClamp(body: HTMLElement): void {
  clampCleanups.get(body)?.();
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

export function disposeUserPromptClamps(root: ParentNode): void {
  for (const body of root.querySelectorAll<HTMLElement>(
    ".conversation-msg-user .conversation-msg-body",
  )) {
    clampCleanups.get(body)?.();
  }
}
