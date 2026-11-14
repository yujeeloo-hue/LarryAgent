import { Check, TriangleAlert } from "lucide";
import { createLucideIcon } from "../../../ui/originalIcons.js";
import { onCardDispose } from "./cardResources.js";

/** How long live success marks stay visible before fading out. */
const OUTCOME_HOLD_MS = 3000;
/** Pop-out tween length (was a 550ms CSS keyframes animation). */
const OUTCOME_POP_OUT_MS = 550;

/** Compact outcome badge: green check / red warning with native tooltip. */
export function createToolOutcomeBadge(input: {
  ok: boolean;
  /** Shown on hover (title). */
  tip: string;
}): HTMLElement {
  const badge = document.createElement("span");
  // Success marks start dormant: they only show (then fade) on cards armed by
  // the live finished-card swap. History renders keep them hidden for good.
  badge.className = `content-card-tool-outcome ${
    input.ok ? "is-ok is-dormant" : "is-fail"
  }`;
  badge.title = input.tip;
  badge.setAttribute("aria-label", input.tip);
  badge.append(
    createLucideIcon(input.ok ? Check : TriangleAlert, {
      size: 14,
      strokeWidth: 2.25,
    }),
  );
  return badge;
}

/**
 * Arm one-shot success marks inside a freshly finished tool card.
 * Success marks fade in place; failure cards and badges stay visible.
 */
export function armLiveOutcomeFade(scope: HTMLElement): void {
  const marks = scope.querySelectorAll<HTMLElement>(
    ".content-card-tool-outcome.is-ok.is-dormant, " +
      ".content-card-subagent-status-icon.is-completed.is-dormant",
  );
  for (const mark of Array.from(marks)) {
    mark.classList.remove("is-dormant");
    const timer = setTimeout(() => {
      unregister();
      playOutcomePopOut(mark);
    }, OUTCOME_HOLD_MS);
    const unregister = onCardDispose(mark, () => clearTimeout(timer));
  }
}

function prefersReducedMotion(): boolean {
  return Boolean(
    typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
}

/**
 * Pop the mark away with a Web Animations tween instead of a CSS animation.
 * layoutTurns() re-parents transcript rows while a turn streams, and
 * re-parenting restarts CSS animations from frame 0 — an already-popped
 * badge would reappear (scale 1 / opacity 1) and pop out again whenever a
 * sibling tool card finished. Script animations survive the re-parent
 * (same reasoning as enterAnimations.ts).
 *
 * Besides the transform/opacity pop, the tween collapses the mark's layout
 * slot (width → 0, margin-left → -10px cancelling the right-container gap)
 * so the row content left of it expands smoothly into the freed space.
 * The `is-faded` class carries only the terminal styles, applied once the
 * tween settles — or immediately when there is no animate support (tests /
 * reduced motion).
 */
function playOutcomePopOut(mark: HTMLElement): void {
  if (typeof mark.animate !== "function" || prefersReducedMotion()) {
    mark.classList.add("is-faded");
    return;
  }
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    mark.classList.add("is-faded");
  };
  // Slot geometry comes from the live computed style: both mark kinds
  // (.content-card-tool-outcome, .content-card-subagent-status-icon) are
  // 14px wide with no explicit margin. -10px cancels the trailing gap of
  // .content-card-tool-result-right — the mark is always its last child.
  const computed =
    typeof getComputedStyle === "function" ? getComputedStyle(mark) : null;
  const slotWidth = computed?.width || "14px";
  const slotMargin = computed?.marginLeft || "0px";
  try {
    const anim = mark.animate(
      [
        {
          transform: "scale(1)",
          opacity: "1",
          width: slotWidth,
          marginLeft: slotMargin,
        },
        {
          transform: "scale(1.3)",
          opacity: "1",
          width: slotWidth,
          marginLeft: slotMargin,
          offset: 0.3,
        },
        {
          transform: "scale(0)",
          opacity: "0",
          width: "0px",
          marginLeft: "-10px",
        },
      ],
      { duration: OUTCOME_POP_OUT_MS, easing: "ease" },
    );
    void anim.finished.then(settle, settle);
  } catch {
    settle();
  }
}
