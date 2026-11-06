/**
 * Multi-step plan cards — DOM port of the desktop PlanCardView.ts +
 * content-cards-plan.css. Plan snapshots are rebuilt with the *same*
 * logic the Mac conversation view uses (planSnapshots.ts imported from the
 * main source tree), so console cards match Mac rendering 1:1.
 */
import { el } from "./render.js";
import { icon } from "./icons.js";
import {
  buildPlansByCreateToolCallId,
  type PlanProgressDisplay,
  type PlanSnapshot,
  type PlanStepStatus,
} from "../../../src/renderer/src/screens/conversation/planSnapshots.js";

export { buildPlansByCreateToolCallId };
export type { PlanSnapshot, PlanProgressDisplay };

import { checkBadge } from "./checkBadge.js";

function statusLabel(status: PlanSnapshot["status"]): string {
  switch (status) {
    case "active": return "In progress";
    case "completed": return "Completed";
    case "cancelled": return "Cancelled";
    default: return status;
  }
}

function stepIcon(status: PlanStepStatus): HTMLElement {
  if (status === "completed") return checkBadge(14);
  if (status === "in_progress") {
    // Ring spinner matching the Session list running indicator.
    return el("span", { class: "content-card-plan-step-spinner" });
  }
  if (status === "cancelled") {
    return el("span", { class: "content-card-plan-step-icon" }, icon("x", 14));
  }
  return el("span", { class: "content-card-plan-step-icon" }, icon("circle", 14));
}

/** Rich multi-step card for an activated create_plan call. */
export function createPlanCard(plan: PlanSnapshot): HTMLElement {
  const card = el("div", { class: "content-card content-card-plan" });
  card.dataset.planCreateToolCallId = plan.createToolCallId;
  // Same id so live-stream tool cards can be reconciled with this node.
  card.dataset.toolCallId = plan.createToolCallId;
  card.dataset.planStatus = plan.status;

  const done = plan.steps.filter((s) => s.status === "completed").length;
  card.append(
    el("div", { class: "content-card-plan-header" },
      el("div", { class: "content-card-plan-title-row" },
        el("span", { class: "content-card-plan-icon" }, icon("listTodo", 15)),
        el("div", { class: "content-card-plan-title", title: plan.title }, plan.title),
      ),
      el("div", { class: "content-card-plan-meta" }, `${done}/${plan.steps.length} · ${statusLabel(plan.status)}`),
    ),
  );

  const list = el("ol", { class: "content-card-plan-steps" });
  // Focus step: first running, else newest resolved (scroll target parity).
  const running = plan.steps.findIndex((s) => s.status === "in_progress");
  let resolved = -1;
  plan.steps.forEach((s, i) => {
    if (s.status === "completed" || s.status === "cancelled") resolved = i;
  });
  const activeIndex = running >= 0 ? running : resolved;
  plan.steps.forEach((step, index) => {
    const item = el("li", { class: `content-card-plan-step is-${step.status}` });
    item.dataset.stepId = step.id;
    if (index === activeIndex) item.dataset.planStepActive = "1";
    const iconEl = stepIcon(step.status);
    iconEl.classList.add("content-card-plan-step-icon");
    item.append(iconEl, el("span", { class: "content-card-plan-step-title", title: step.title }, step.title));
    list.append(item);
  });
  card.append(list);

  if (plan.summary) {
    card.append(el("div", { class: "content-card-plan-summary" }, plan.summary));
  }
  return card;
}

function progressIcon(kind: PlanProgressDisplay["kind"]): HTMLElement {
  switch (kind) {
    case "completed": {
      const badge = checkBadge(14);
      badge.classList.add("content-card-plan-tool-status-icon", "is-completed");
      return badge;
    }
    case "in_progress": {
      const spinner = el("span", { class: "content-card-plan-step-spinner" });
      spinner.style.setProperty("margin-top", "0");
      spinner.classList.add("content-card-plan-tool-status-icon", "is-in-progress");
      return spinner;
    }
    case "cancelled":
      return el("span", { class: "content-card-plan-tool-status-icon is-cancelled" }, icon("x", 13));
    default:
      return el("span", { class: "content-card-plan-tool-status-icon" }, icon("circle", 13));
  }
}

/** Compact one-liner for update_plan / complete_plan (label + status icon). */
export function createPlanToolCard(
  part: { id: string; name: string },
  display: PlanProgressDisplay,
): HTMLElement {
  const iconEl = progressIcon(display.kind);
  return el("div", {
    class: "content-card content-card-tool-invocation is-compact content-card-plan-tool",
    "data-tool-call-id": part.id,
  },
    el("div", { class: "content-card-tool-result-summary" },
      el("div", { class: "content-card-tool-result-left" },
        el("span", { class: "content-card-tool-icon" }, icon(part.name === "complete_plan" ? "circleCheck" : "listChecks", 13)),
        el("span", { class: "content-card-plan-tool-title", title: display.label }, display.label),
        iconEl,
      ),
    ),
  );
}

