import type { Session, SessionPlan, PlanStep } from "../../session/types.js";
import type { StreamEvent } from "../../llm/streamEvents.js";
import {
  applyStepInProgress,
  finalizeIncompleteSteps,
  getBlockedSteps,
  getReadySteps,
  inProgressSteps,
  isActivePlan,
} from "../../session/plan.js";

/**
 * Controlled access to Session.plan — Roles must not fork a second step list.
 */
export class PlanFacade {
  constructor(
    private readonly session: Session,
    private readonly onEvent?: (event: StreamEvent) => void,
  ) {}

  get(): SessionPlan | null {
    return this.session.plan ?? null;
  }

  set(plan: SessionPlan | null): void {
    this.session.plan = plan;
    this.emit();
  }

  emit(): void {
    this.onEvent?.({ type: "plan", plan: this.session.plan ?? null });
  }

  isActiveIncomplete(): boolean {
    const plan = this.get();
    if (!isActivePlan(plan) || !plan) return false;
    return plan.steps.some(
      (s) => s.status === "pending" || s.status === "in_progress",
    );
  }

  /** First in_progress step (legacy single-step callers). */
  currentStep(): PlanStep | null {
    return inProgressSteps(this.get()?.steps ?? [])[0] ?? null;
  }

  inProgressSteps(): PlanStep[] {
    const plan = this.get();
    if (!isActivePlan(plan) || !plan) return [];
    return inProgressSteps(plan.steps);
  }

  readySteps(): PlanStep[] {
    const plan = this.get();
    if (!isActivePlan(plan) || !plan) return [];
    return getReadySteps(plan.steps);
  }

  blockedSteps(): Array<{ step: PlanStep; waitingOn: string[] }> {
    const plan = this.get();
    if (!isActivePlan(plan) || !plan) return [];
    return getBlockedSteps(plan.steps);
  }

  /** Start one ready step when none are active (kick-off for linear / first frontier). */
  ensureInProgress(stepId?: string): void {
    const plan = this.get();
    if (!isActivePlan(plan) || !plan) return;
    if (inProgressSteps(plan.steps).length > 0) return;

    const target =
      (stepId
        ? plan.steps.find((s) => s.id === stepId && s.status === "pending")
        : undefined) ?? getReadySteps(plan.steps)[0];
    if (!target) return;

    const applied = applyStepInProgress(
      plan.steps.map((s) => ({
        ...s,
        ...(s.dependsOn ? { dependsOn: [...s.dependsOn] } : {}),
      })),
      target.id,
    );
    if (!applied.ok) return;

    this.set({
      ...plan,
      steps: applied.steps,
      updatedAt: Date.now(),
    });
  }

  /**
   * Close an active leftover checklist (e.g. before plan_writer or Direct).
   * Remaining pending / in_progress steps take the same fill as complete_plan.
   */
  completeIfActive(
    status: "completed" | "cancelled" = "completed",
  ): boolean {
    const plan = this.get();
    if (!isActivePlan(plan) || !plan) return false;
    this.set({
      ...plan,
      status,
      steps: finalizeIncompleteSteps(plan.steps, status),
      updatedAt: Date.now(),
    });
    return true;
  }

  /** Illegal completed claim — patch back to in_progress for model retry. */
  revertStepToInProgress(stepId: string): boolean {
    const plan = this.get();
    if (!isActivePlan(plan) || !plan) return false;
    const idx = plan.steps.findIndex((s) => s.id === stepId);
    if (idx < 0) return false;
    const prev = plan.steps[idx]!;
    if (prev.status !== "completed") return false;

    const steps = plan.steps.map((s, i) => {
      const base = {
        ...s,
        ...(s.dependsOn ? { dependsOn: [...s.dependsOn] } : {}),
      };
      if (i !== idx) return base;
      return { ...base, status: "in_progress" as const };
    });

    this.set({
      ...plan,
      steps,
      updatedAt: Date.now(),
    });
    return true;
  }
}
