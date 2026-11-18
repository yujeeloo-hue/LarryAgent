import { Check, TriangleAlert } from "lucide";
import { createLucideIcon } from "../../../ui/originalIcons.js";
import { onCardDispose } from "./cardResources.js";

const OUTCOME_HOLD_MS = 3000;
const OUTCOME_POP_OUT_MS = 550;

export function createToolOutcomeBadge(input: {
  ok: boolean;
  tip: string;
}): HTMLElement {
  const badge = document.createElement("span");
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
