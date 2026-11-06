import type { SessionPlan, PlanStep } from "../../session/types.js";
import {
  applyStepInProgress,
  getReadySteps,
  inProgressSteps,
  isActivePlan,
} from "../../session/plan.js";

function formatStepLine(step: PlanStep): string {
  return `${step.id} — ${step.title}`;
}

function appendPlanFrontierLines(lines: string[], plan: SessionPlan): void {
  const running = inProgressSteps(plan.steps);
  if (running.length > 0) {
    lines.push(`Now: ${running.map(formatStepLine).join("; ")}`);
  }
  const currentId = running[0]?.id;
  const start = currentId
    ? plan.steps.findIndex((s) => s.id === currentId) + 1
    : 0;
  const next = plan.steps
    .slice(Math.max(0, start))
    .find((s) => s.status === "pending");
  if (next) {
    lines.push(`Next: ${formatStepLine(next)}`);
  }
}

/**
 * Compact live checklist for the executor trailing overlay.
 */
export function planFrontierLines(
  plan: SessionPlan | null | undefined,
): string[] {
  if (!isActivePlan(plan) || !plan) return [];

  const completed = plan.steps.filter((s) => s.status === "completed").length;
  const cancelled = plan.steps.filter((s) => s.status === "cancelled").length;
  const remaining = plan.steps.length - completed - cancelled;
  const lines = [
    `Plan: "${plan.title}"`,
    `Progress: ${completed}/${plan.steps.length} completed` +
      (remaining > 0 ? `, ${remaining} remaining` : ""),
  ];
  appendPlanFrontierLines(lines, plan);
  return lines;
}
