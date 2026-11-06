/**
 * Multi-step plan helpers shared by tools, persistence, and (via IPC) UI rebuild.
 */

import type { JsonObject, SessionPlan, SessionPlanDoc, PlanStep, PlanStepStatus } from "./types.js";
import { PLAN_DOC_SUMMARY_MAX } from "./types.js";

export const PLAN_MIN_STEPS = 2;
export const PLAN_MAX_STEPS = 12;
export const PLAN_TITLE_MAX = 80;
export const PLAN_STEP_TITLE_MAX = 120;
/** One step in flight. Models invent poor DAGs when allowed to parallelize. */
export const PLAN_MAX_IN_PROGRESS = 1;

const STEP_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

export function isPlanStepStatus(value: unknown): value is PlanStepStatus {
  return typeof value === "string" && STEP_STATUSES.has(value);
}

export function isActivePlan(
  plan: SessionPlan | null | undefined,
): plan is SessionPlan {
  return Boolean(plan && plan.status === "active");
}

/** Active plan with at least one pending or in_progress step. */
export function hasOpenPlanSteps(
  plan: SessionPlan | null | undefined,
): plan is SessionPlan {
  return (
    isActivePlan(plan) &&
    plan.steps.some(
      (s) => s.status === "pending" || s.status === "in_progress",
    )
  );
}

/** Compact fingerprint of step id→status (for detecting plan progress changes). */
export function planStepStatusesKey(
  plan: SessionPlan | null | undefined,
): string {
  if (!plan?.steps?.length) return "";
  return plan.steps.map((s) => `${s.id}:${s.status}`).join("|");
}

function planDocRefFromDoc(
  doc: SessionPlanDoc | null | undefined,
): SessionPlan["planDoc"] | undefined {
  if (!doc?.path?.trim()) return undefined;
  return {
    path: doc.path.trim(),
    summary: doc.summary.trim().slice(0, PLAN_DOC_SUMMARY_MAX),
  };
}

/**
 * Fill the plan→doc link only when missing: an existing ref wins (already
 * stamped from the creating tool's snapshot), else the current session doc.
 */
export function withPlanDocRef(
  plan: SessionPlan,
  doc: SessionPlanDoc | null | undefined,
): SessionPlan {
  if (plan.planDoc) return plan;
  const ref = planDocRefFromDoc(doc);
  if (!ref) return plan;
  return { ...plan, planDoc: ref };
}

/**
 * (Re)point an active plan at a freshly written doc — write_plan_doc landing
 * while the plan is active replaces the link (doc rewrite / replace).
 */
export function refreshPlanDocRef(
  plan: SessionPlan,
  doc: SessionPlanDoc | null | undefined,
): SessionPlan {
  const ref = planDocRefFromDoc(doc);
  if (!ref) return plan;
  if (
    plan.planDoc &&
    plan.planDoc.path === ref.path &&
    plan.planDoc.summary === ref.summary
  ) {
    return plan;
  }
  return { ...plan, planDoc: ref };
}

export function nextStepId(steps: PlanStep[]): string {
  let max = 0;
  for (const step of steps) {
    const match = /^s(\d+)$/.exec(step.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `s${max + 1}`;
}

export function clipTitle(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

export type CreatePlanStepSpec = {
  title: string;
  /** When true, chain to the previous step id after ids are assigned. */
  chainDefault?: boolean;
  dependsOn?: string[];
};

function parseCreatePlanStepItem(
  item: unknown,
): { ok: true; spec: CreatePlanStepSpec } | { ok: false; message: string } {
  if (typeof item === "string") {
    if (item.trim().length === 0) {
      return { ok: false, message: "each step must be a non-empty string." };
    }
    return {
      ok: true,
      spec: { title: clipTitle(item, PLAN_STEP_TITLE_MAX), chainDefault: true },
    };
  }
  return {
    ok: false,
    message:
      'each step must be a non-empty string (object steps / dependsOn are not accepted).',
  };
}

export function parseCreatePlanArgs(args: JsonObject):
  | { ok: true; title: string; stepSpecs: CreatePlanStepSpec[] }
  | { ok: false; message: string } {
  const titleRaw =
    typeof args.title === "string" && args.title.trim().length > 0
      ? args.title
      : "Plan";
  const title = clipTitle(titleRaw, PLAN_TITLE_MAX);

  if (!Array.isArray(args.steps)) {
    return {
      ok: false,
      message: 'Invalid arguments: "steps" must be an array.',
    };
  }

  const stepSpecs: CreatePlanStepSpec[] = [];
  for (const item of args.steps) {
    const parsed = parseCreatePlanStepItem(item);
    if (!parsed.ok) {
      return { ok: false, message: `Invalid arguments: ${parsed.message}` };
    }
    stepSpecs.push(parsed.spec);
  }

  if (stepSpecs.length < PLAN_MIN_STEPS) {
    return {
      ok: false,
      message: `Invalid arguments: need at least ${PLAN_MIN_STEPS} steps.`,
    };
  }
  if (stepSpecs.length > PLAN_MAX_STEPS) {
    return {
      ok: false,
      message: `Invalid arguments: at most ${PLAN_MAX_STEPS} steps.`,
    };
  }

  return { ok: true, title, stepSpecs };
}

export function buildPlanStepsFromSpecs(specs: CreatePlanStepSpec[]): PlanStep[] {
  const steps: PlanStep[] = specs.map((spec, index) => {
    const id = `s${index + 1}`;
    const step: PlanStep = {
      id,
      title: spec.title,
      status: "pending",
    };
    if (spec.dependsOn !== undefined) {
      // Drop self-edges (models often keep dependsOn:["s1"] after omitting a
      // finished first step; create_plan reassigns ids from s1). Unknown /
      // cyclic deps among distinct steps still fail validation below.
      const deps = spec.dependsOn.filter((depId) => depId !== id);
      if (deps.length > 0) {
        step.dependsOn = deps;
      }
    } else if (spec.chainDefault && index > 0) {
      step.dependsOn = [`s${index}`];
    }
    return step;
  });

  const graph = validatePlanStepGraph(steps);
  if (!graph.ok) {
    throw new Error(graph.message);
  }
  return steps;
}

export function stepByIdMap(steps: PlanStep[]): Map<string, PlanStep> {
  return new Map(steps.map((s) => [s.id, s]));
}

export function areStepDepsSatisfied(step: PlanStep, steps: PlanStep[]): boolean {
  const deps = step.dependsOn ?? [];
  if (deps.length === 0) return true;
  const byId = stepByIdMap(steps);
  for (const depId of deps) {
    const dep = byId.get(depId);
    if (!dep || dep.status !== "completed") return false;
  }
  return true;
}

export function unsatisfiedDepIds(step: PlanStep, steps: PlanStep[]): string[] {
  const deps = step.dependsOn ?? [];
  if (deps.length === 0) return [];
  const byId = stepByIdMap(steps);
  const waiting: string[] = [];
  for (const depId of deps) {
    const dep = byId.get(depId);
    if (!dep || dep.status !== "completed") waiting.push(depId);
  }
  return waiting;
}

export function isStepReady(step: PlanStep, steps: PlanStep[]): boolean {
  return step.status === "pending" && areStepDepsSatisfied(step, steps);
}

export function isStepBlocked(step: PlanStep, steps: PlanStep[]): boolean {
  return step.status === "pending" && !areStepDepsSatisfied(step, steps);
}

export function getReadySteps(steps: PlanStep[]): PlanStep[] {
  return steps.filter((s) => isStepReady(s, steps));
}

export function getBlockedSteps(
  steps: PlanStep[],
): Array<{ step: PlanStep; waitingOn: string[] }> {
  return steps
    .filter((s) => isStepBlocked(s, steps))
    .map((step) => ({ step, waitingOn: unsatisfiedDepIds(step, steps) }));
}

export function countInProgressSteps(steps: PlanStep[]): number {
  return steps.filter((s) => s.status === "in_progress").length;
}

export function inProgressSteps(steps: PlanStep[]): PlanStep[] {
  return steps.filter((s) => s.status === "in_progress");
}

export function validatePlanStepGraph(
  steps: PlanStep[],
): { ok: true } | { ok: false; message: string } {
  const ids = new Set(steps.map((s) => s.id));
  for (const step of steps) {
    for (const depId of step.dependsOn ?? []) {
      if (depId === step.id) {
        return {
          ok: false,
          message: `Invalid plan graph: step "${step.id}" depends on itself.`,
        };
      }
      if (!ids.has(depId)) {
        return {
          ok: false,
          message: `Invalid plan graph: unknown dependency "${depId}" on step "${step.id}".`,
        };
      }
    }
  }

  const indegree = new Map<string, number>();
  for (const step of steps) indegree.set(step.id, 0);
  for (const step of steps) {
    for (const depId of step.dependsOn ?? []) {
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
    }
  }

  const queue = steps.filter((s) => (indegree.get(s.id) ?? 0) === 0).map((s) => s.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited += 1;
    for (const step of steps) {
      if (!(step.dependsOn ?? []).includes(id)) continue;
      const next = (indegree.get(step.id) ?? 0) - 1;
      indegree.set(step.id, next);
      if (next === 0) queue.push(step.id);
    }
  }

  if (visited !== steps.length) {
    return { ok: false, message: "Invalid plan graph: dependency cycle detected." };
  }
  return { ok: true };
}

export function applyStepInProgress(
  steps: PlanStep[],
  targetId: string,
): { ok: true; steps: PlanStep[] } | { ok: false; message: string } {
  const idx = steps.findIndex((s) => s.id === targetId);
  if (idx < 0) {
    return { ok: false, message: `Invalid arguments: unknown step id "${targetId}".` };
  }
  const target = steps[idx]!;
  if (target.status === "in_progress") {
    return { ok: true, steps: steps.map((s) => ({ ...s })) };
  }
  if (target.status !== "pending") {
    return {
      ok: false,
      message: `Invalid arguments: step "${targetId}" is not pending.`,
    };
  }
  const waiting = unsatisfiedDepIds(target, steps);
  if (waiting.length > 0) {
    return {
      ok: false,
      message:
        `Invalid arguments: step "${targetId}" is blocked; ` +
        `waiting on ${waiting.join(", ")}.`,
    };
  }
  if (countInProgressSteps(steps) >= PLAN_MAX_IN_PROGRESS) {
    return {
      ok: false,
      message: `Invalid arguments: at most ${PLAN_MAX_IN_PROGRESS} steps may be in_progress.`,
    };
  }
  const next = steps.map((s) =>
    s.id === targetId ? { ...s, status: "in_progress" as const } : { ...s },
  );
  return { ok: true, steps: next };
}

export function cancelIncompleteSteps(steps: PlanStep[]): PlanStep[] {
  return steps.map((step) =>
    step.status === "completed"
      ? step
      : { ...step, status: "cancelled" as const },
  );
}

/**
 * Close out remaining open steps when finishing a plan.
 * - `completed`: pending / in_progress → completed (keeps explicit cancelled)
 * - `cancelled`: pending / in_progress → cancelled (keeps completed)
 */
export function finalizeIncompleteSteps(
  steps: PlanStep[],
  outcome: "completed" | "cancelled",
): PlanStep[] {
  const fill: PlanStepStatus =
    outcome === "completed" ? "completed" : "cancelled";
  return steps.map((step) => {
    if (step.status === "completed" || step.status === "cancelled") {
      return step;
    }
    return { ...step, status: fill };
  });
}

export function formatPlanSummary(plan: SessionPlan): string {
  const done = plan.steps.filter((s) => s.status === "completed").length;
  const lines = [
    `Plan "${plan.title}" [${plan.status}] ${done}/${plan.steps.length} done`,
    ...plan.steps.map((s) => `- [${s.status}] ${s.id}: ${s.title}`),
  ];
  if (plan.summary) {
    lines.push(`Summary: ${plan.summary}`);
  }
  lines.push(`plan_json:${JSON.stringify(plan)}`);
  return lines.join("\n");
}

function clonePlan(plan: SessionPlan): SessionPlan {
  return {
    ...plan,
    steps: plan.steps.map((s) => ({
      ...s,
      ...(s.dependsOn ? { dependsOn: [...s.dependsOn] } : {}),
    })),
    ...(plan.summary !== undefined ? { summary: plan.summary } : {}),
  };
}

function parseCreatePlanStepsFromArgs(args: JsonObject): PlanStep[] | null {
  if (!Array.isArray(args.steps)) return null;
  const specs: CreatePlanStepSpec[] = [];
  for (const item of args.steps) {
    const parsed = parseCreatePlanStepItem(item);
    if (!parsed.ok) {
      if (typeof item === "string" && item.trim()) {
        specs.push({
          title: clipTitle(item, PLAN_STEP_TITLE_MAX),
          chainDefault: true,
        });
        continue;
      }
      return null;
    }
    specs.push(parsed.spec);
  }
  if (specs.length < PLAN_MIN_STEPS) return null;
  try {
    return buildPlanStepsFromSpecs(specs);
  } catch {
    return null;
  }
}

function argsStatus(args: JsonObject): "completed" | "cancelled" | null {
  if (args.status === "completed" || args.status === "cancelled") {
    return args.status;
  }
  return null;
}

function parsePlanStepFromJson(step: Record<string, unknown>): PlanStep | null {
  if (typeof step.id !== "string" || typeof step.title !== "string") return null;
  if (!isPlanStepStatus(step.status)) return null;
  const parsed: PlanStep = {
    id: step.id,
    title: step.title,
    status: step.status,
  };
  if (Array.isArray(step.dependsOn)) {
    const deps: string[] = [];
    for (const item of step.dependsOn) {
      if (typeof item !== "string" || !item.trim()) return null;
      deps.push(item.trim());
    }
    if (deps.length > 0) parsed.dependsOn = deps;
  }
  return parsed;
}

export function parseSessionPlanJson(raw: string | null | undefined): SessionPlan | null {
  if (raw == null || raw === "") return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const obj = value as Record<string, unknown>;
    if (typeof obj.id !== "string" || typeof obj.title !== "string") return null;
    if (obj.status !== "active" && obj.status !== "completed" && obj.status !== "cancelled") {
      return null;
    }
    if (!Array.isArray(obj.steps) || typeof obj.createToolCallId !== "string") {
      return null;
    }
    if (typeof obj.createdAt !== "number" || typeof obj.updatedAt !== "number") {
      return null;
    }
    const steps: PlanStep[] = [];
    for (const item of obj.steps) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const step = parsePlanStepFromJson(item as Record<string, unknown>);
      if (!step) return null;
      steps.push(step);
    }
    const graph = validatePlanStepGraph(steps);
    if (!graph.ok) return null;
    const plan: SessionPlan = {
      id: obj.id,
      title: obj.title,
      status: obj.status,
      steps,
      createdAt: obj.createdAt,
      updatedAt: obj.updatedAt,
      createToolCallId: obj.createToolCallId,
    };
    if (typeof obj.summary === "string" && obj.summary.trim()) {
      plan.summary = obj.summary.trim();
    }
    if (
      obj.planDoc &&
      typeof obj.planDoc === "object" &&
      !Array.isArray(obj.planDoc)
    ) {
      const ref = obj.planDoc as Record<string, unknown>;
      if (
        typeof ref.path === "string" &&
        ref.path.trim() &&
        typeof ref.summary === "string"
      ) {
        plan.planDoc = {
          path: ref.path.trim(),
          summary: ref.summary.trim().slice(0, PLAN_DOC_SUMMARY_MAX),
        };
      }
    }
    return plan.status === "active" ? repairActivePlanInProgress(plan) : plan;
  } catch {
    return null;
  }
}

/** Legacy sessions: ensure an active plan has an in_progress step when loaded. */
export function repairActivePlanInProgress(plan: SessionPlan): SessionPlan {
  if (plan.status !== "active") return plan;
  if (inProgressSteps(plan.steps).length > 0) return plan;
  const next = getReadySteps(plan.steps)[0];
  if (!next) return plan;
  const applied = applyStepInProgress(plan.steps, next.id);
  if (!applied.ok) return plan;
  return { ...plan, steps: applied.steps, updatedAt: Date.now() };
}
