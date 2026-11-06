import { Circle, ListTodo, X } from "lucide";
import { createLucideIcon } from "../../../ui/originalIcons.js";
import { createCheckBadge } from "../../../ui/checkBadge.js";
import type { PlanSnapshot, PlanStepStatus } from "../planSnapshots.js";

function stepIcon(status: PlanStepStatus): SVGElement | HTMLElement {
  if (status === "completed") {
    return createCheckBadge({ size: 14 }, createLucideIcon);
  }
  if (status === "in_progress") {
    // Ring spinner matching the Session list running indicator (styled in CSS).
    const spinner = document.createElement("span");
    spinner.className = "content-card-plan-step-spinner";
    return spinner;
  }
  if (status === "cancelled") {
    return createLucideIcon(X, { size: 14 });
  }
  return createLucideIcon(Circle, { size: 14 });
}

function statusLabel(status: PlanSnapshot["status"]): string {
  switch (status) {
    case "active":
      return "In progress";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

const STEPS_SELECTOR = ".content-card-plan-steps";
const ACTIVE_STEP_SELECTOR = "[data-plan-step-active='1']";

/** Step the card scrolls to: first running, else newest resolved. */
function activeStepIndex(plan: PlanSnapshot): number {
  const running = plan.steps.findIndex((s) => s.status === "in_progress");
  if (running >= 0) return running;
  let resolved = -1;
  plan.steps.forEach((s, i) => {
    if (s.status === "completed" || s.status === "cancelled") resolved = i;
  });
  return resolved;
}

/** Returns the step id the card is currently focused on, if any. */
export function getPlanCardActiveStepId(card: HTMLElement): string | undefined {
  return card.querySelector<HTMLElement>(ACTIVE_STEP_SELECTOR)?.dataset.stepId;
}

export function getPlanCardStepsScrollTop(card: HTMLElement): number {
  return card.querySelector<HTMLElement>(STEPS_SELECTOR)?.scrollTop ?? 0;
}

export function setPlanCardStepsScrollTop(card: HTMLElement, scrollTop: number): void {
  const list = card.querySelector<HTMLElement>(STEPS_SELECTOR);
  if (list) list.scrollTop = scrollTop;
}

/** Scroll the active step to the vertical middle of the (capped-height) step list. */
export function centerPlanCardActiveStep(
  card: HTMLElement,
  behavior: ScrollBehavior = "auto",
): void {
  const list = card.querySelector<HTMLElement>(STEPS_SELECTOR);
  const step = list?.querySelector<HTMLElement>(ACTIVE_STEP_SELECTOR);
  if (!list || !step) return;
  const maxTop = list.scrollHeight - list.clientHeight;
  if (maxTop <= 0) return;
  const centered = step.offsetTop - (list.clientHeight - step.offsetHeight) / 2;
  const top = Math.max(0, Math.min(maxTop, centered));
  if (Math.abs(top - list.scrollTop) < 1) return;
  list.scrollTo({ top, behavior });
}

/** Presentation-only rich card for create_plan (live-updated via plan snapshot). */
export function createPlanCard(
  plan: PlanSnapshot,
  options?: { autoCenter?: boolean },
): HTMLElement {
  const card = document.createElement("div");
  card.className = "content-card content-card-plan";
  card.dataset.planCreateToolCallId = plan.createToolCallId;
  // Same id so upsertFinishedToolCard can find this card after syncPlanCards
  // replaces a generic tool-call node with a rich Plan card.
  card.dataset.toolCallId = plan.createToolCallId;
  card.dataset.planStatus = plan.status;

  const header = document.createElement("div");
  header.className = "content-card-plan-header";

  const titleRow = document.createElement("div");
  titleRow.className = "content-card-plan-title-row";

  const icon = createLucideIcon(ListTodo, { size: 15 });
  icon.classList.add("content-card-plan-icon");

  const title = document.createElement("div");
  title.className = "content-card-plan-title";
  title.textContent = plan.title;
  title.title = plan.title;

  titleRow.append(icon, title);

  const meta = document.createElement("div");
  meta.className = "content-card-plan-meta";
  const done = plan.steps.filter((s) => s.status === "completed").length;
  meta.textContent = `${done}/${plan.steps.length} · ${statusLabel(plan.status)}`;

  header.append(titleRow, meta);
  card.append(header);

  const list = document.createElement("ol");
  list.className = "content-card-plan-steps";

  const activeIndex = activeStepIndex(plan);

  plan.steps.forEach((step, index) => {
    const item = document.createElement("li");
    item.className = `content-card-plan-step is-${step.status}`;
    item.dataset.stepId = step.id;
    if (index === activeIndex) item.dataset.planStepActive = "1";

    const stepIconEl = stepIcon(step.status);
    stepIconEl.classList.add("content-card-plan-step-icon");

    const label = document.createElement("span");
    label.className = "content-card-plan-step-title";
    label.textContent = step.title;
    label.title = step.title;

    item.append(stepIconEl, label);
    list.append(item);
  });

  card.append(list);

  if (options?.autoCenter !== false) {
    // offsetTop / clientHeight need layout, so wait until the card is attached.
    requestAnimationFrame(() => centerPlanCardActiveStep(card));
  }

  if (plan.summary) {
    const summary = document.createElement("div");
    summary.className = "content-card-plan-summary";
    summary.textContent = plan.summary;
    card.append(summary);
  }

  return card;
}
