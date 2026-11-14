/**
 * Multi-step plan types + transcript rebuild for the conversation UI.
 * Keep behavior aligned with src/session/plan.ts.
 */

export type PlanStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";

export type PlanStatus = "active" | "completed" | "cancelled";

export type PlanStepSnapshot = {
  id: string;
  title: string;
  status: PlanStepStatus;
  dependsOn?: string[];
};

export type PlanSnapshot = {
  id: string;
  title: string;
  status: PlanStatus;
  steps: PlanStepSnapshot[];
  createdAt: number;
  updatedAt: number;
  createToolCallId: string;
  summary?: string;
};

/** Compact update_plan / complete_plan one-liner (label + status icon kind). */
export type PlanProgressKind =
  | "completed"
  | "in_progress"
  | "cancelled"
  | "updated";

export type PlanProgressDisplay = {
  label: string;
  kind: PlanProgressKind;
};

const STEP_STATUSES = new Set<string>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

function isStepStatus(value: unknown): value is PlanStepStatus {
  return typeof value === "string" && STEP_STATUSES.has(value);
}

function cancelIncomplete(steps: PlanStepSnapshot[]): PlanStepSnapshot[] {
  return steps.map((step) =>
    step.status === "completed"
      ? step
      : { ...step, status: "cancelled" as const },
  );
}

/** Match session/plan finalizeIncompleteSteps for transcript rebuild. */
function finalizeIncomplete(
  steps: PlanStepSnapshot[],
  outcome: "completed" | "cancelled",
): PlanStepSnapshot[] {
  const fill: PlanStepStatus =
    outcome === "completed" ? "completed" : "cancelled";
  return steps.map((step) => {
    if (step.status === "completed" || step.status === "cancelled") {
      return step;
    }
    return { ...step, status: fill };
  });
}

function areDepsSatisfied(
  step: PlanStepSnapshot,
  steps: PlanStepSnapshot[],
): boolean {
  const deps = step.dependsOn ?? [];
  if (deps.length === 0) return true;
  const byId = new Map(steps.map((s) => [s.id, s]));
  for (const depId of deps) {
    const dep = byId.get(depId);
    if (!dep || dep.status !== "completed") return false;
  }
  return true;
}

function unsatisfiedDepIds(
  step: PlanStepSnapshot,
  steps: PlanStepSnapshot[],
): string[] {
  const deps = step.dependsOn ?? [];
  const byId = new Map(steps.map((s) => [s.id, s]));
  return deps.filter((depId) => {
    const dep = byId.get(depId);
    return !dep || dep.status !== "completed";
  });
}

function countInProgress(steps: PlanStepSnapshot[]): number {
  return steps.filter((s) => s.status === "in_progress").length;
}

function applyStepInProgress(
  steps: PlanStepSnapshot[],
  targetId: string,
): PlanStepSnapshot[] | null {
  const idx = steps.findIndex((s) => s.id === targetId);
  if (idx < 0) return null;
  const target = steps[idx]!;
  if (target.status === "in_progress") return steps.map((s) => ({ ...s }));
  if (target.status !== "pending" || !areDepsSatisfied(target, steps)) return null;
  if (countInProgress(steps) >= 4) return null;
  return steps.map((s) =>
    s.id === targetId ? { ...s, status: "in_progress" as const } : { ...s },
  );
}

function applyInProgressExclusive(
  steps: PlanStepSnapshot[],
  targetId: string,
): PlanStepSnapshot[] {
  return (
    applyStepInProgress(steps, targetId) ??
    steps.map((s) =>
      s.id === targetId ? { ...s, status: "in_progress" as const } : { ...s },
    )
  );
}

function nextStepId(steps: PlanStepSnapshot[]): string {
  let max = 0;
  for (const step of steps) {
    const match = /^s(\d+)$/.exec(step.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `s${max + 1}`;
}

function clonePlan(plan: PlanSnapshot): PlanSnapshot {
  return {
    ...plan,
    steps: plan.steps.map((s) => ({ ...s })),
    ...(plan.summary !== undefined ? { summary: plan.summary } : {}),
  };
}

function asPlanSnapshot(value: unknown): PlanSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.title !== "string") return null;
  if (
    obj.status !== "active" &&
    obj.status !== "completed" &&
    obj.status !== "cancelled"
  ) {
    return null;
  }
  if (!Array.isArray(obj.steps) || typeof obj.createToolCallId !== "string") {
    return null;
  }
  if (typeof obj.createdAt !== "number" || typeof obj.updatedAt !== "number") {
    return null;
  }
  const steps: PlanStepSnapshot[] = [];
  for (const item of obj.steps) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const step = item as Record<string, unknown>;
    if (typeof step.id !== "string" || typeof step.title !== "string") {
      return null;
    }
    if (!isStepStatus(step.status)) return null;
    const snap: PlanStepSnapshot = {
      id: step.id,
      title: step.title,
      status: step.status,
    };
    if (Array.isArray(step.dependsOn)) {
      const deps = step.dependsOn.filter(
        (d): d is string => typeof d === "string" && d.trim().length > 0,
      );
      if (deps.length > 0) snap.dependsOn = deps;
    }
    steps.push(snap);
  }
  const plan: PlanSnapshot = {
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
  return plan;
}

/**
 * A create_plan call becomes a renderable Plan only when its result contains
 * the authoritative SessionPlan payload emitted by formatPlanSummary().
 * Review staging never activates Session.plan, so it has no plan_json payload.
 */
export function collectActivatedPlanCallIds(
  messages: Array<{ parts: Array<Record<string, unknown>> }>,
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool_result") continue;
      if (!Array.isArray(part.content)) continue;
      for (const entry of part.content) {
        if (!entry || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        if (item.type !== "text" || typeof item.text !== "string") continue;
        for (const line of item.text.split(/\r?\n/)) {
          if (!line.startsWith("plan_json:")) continue;
          try {
            const parsed = JSON.parse(line.slice("plan_json:".length)) as {
              createToolCallId?: unknown;
            };
            if (
              typeof parsed.createToolCallId === "string" &&
              parsed.createToolCallId.trim()
            ) {
              ids.add(parsed.createToolCallId.trim());
            }
          } catch {
            // Ignore malformed historical summaries.
          }
        }
      }
    }
  }
  return ids;
}

/**
 * Rebuild plan cards from tool_call history; overlay live session.plan when present.
 * Also builds compact one-liner labels for update_plan / complete_plan tool calls
 * using step titles (not step ids).
 */
export function buildPlansByCreateToolCallId(
  messages: Array<{
    createdAt?: number;
    parts: Array<Record<string, unknown>>;
  }>,
  livePlan?: unknown,
): {
  plansByCreateToolCallId: Map<string, PlanSnapshot>;
  progressByToolCallId: Map<string, PlanProgressDisplay>;
} {
  const byCreateId = new Map<string, PlanSnapshot>();
  const progressByToolCallId = new Map<string, PlanProgressDisplay>();
  const activatedPlanCallIds = collectActivatedPlanCallIds(messages);
  const live = asPlanSnapshot(livePlan);
  if (live) activatedPlanCallIds.add(live.createToolCallId);
  let current: PlanSnapshot | null = null;

  const finalizeCurrentIfActive = (at: number): void => {
    if (!current || current.status !== "active") return;
    current = {
      ...current,
      status: "cancelled",
      steps: cancelIncomplete(current.steps),
      updatedAt: at,
    };
    byCreateId.set(current.createToolCallId, clonePlan(current));
  };

  for (const message of messages) {
    const at =
      typeof message.createdAt === "number" ? message.createdAt : Date.now();
    for (const part of message.parts) {
      if (part.type !== "tool_call") continue;
      const name = typeof part.name === "string" ? part.name : "";
      const id = typeof part.id === "string" ? part.id : "";
      const args =
        part.arguments &&
        typeof part.arguments === "object" &&
        !Array.isArray(part.arguments)
          ? (part.arguments as Record<string, unknown>)
          : {};

      if (name === "create_plan") {
        if (!id || !activatedPlanCallIds.has(id)) continue;
        finalizeCurrentIfActive(at);
        const title =
          typeof args.title === "string" && args.title.trim()
            ? args.title.trim()
            : "Plan";
        const stepSpecs: Array<{ title: string; dependsOn?: string[]; chain?: boolean }> = [];
        if (Array.isArray(args.steps)) {
          for (const item of args.steps) {
            if (typeof item === "string" && item.trim()) {
              stepSpecs.push({ title: item.trim(), chain: true });
              continue;
            }
            if (item && typeof item === "object" && !Array.isArray(item)) {
              const entry = item as Record<string, unknown>;
              if (typeof entry.title === "string" && entry.title.trim()) {
                const spec: { title: string; dependsOn?: string[]; chain?: boolean } = {
                  title: entry.title.trim(),
                };
                if (Array.isArray(entry.dependsOn)) {
                  spec.dependsOn = entry.dependsOn.filter(
                    (d): d is string => typeof d === "string" && d.trim().length > 0,
                  );
                } else {
                  spec.chain = true;
                }
                stepSpecs.push(spec);
              }
            }
          }
        }
        if (stepSpecs.length < 2) continue;
        current = {
          id: `plan_${id}`,
          title,
          status: "active",
          steps: stepSpecs.map((spec, index) => {
            const step: PlanStepSnapshot = {
              id: `s${index + 1}`,
              title: spec.title,
              status: "pending",
            };
            if (spec.dependsOn && spec.dependsOn.length > 0) {
              step.dependsOn = [...spec.dependsOn];
            } else if (spec.chain && index > 0) {
              step.dependsOn = [`s${index}`];
            }
            return step;
          }),
          createdAt: at,
          updatedAt: at,
          createToolCallId: id,
        };
        byCreateId.set(id, clonePlan(current));
        continue;
      }

      if (!current) continue;

      if (name === "update_plan") {
        if (id) {
          const display = progressDisplayForUpdate(
            args,
            current.steps,
            current.title,
          );
          if (display) progressByToolCallId.set(id, display);
        }
        if (typeof args.title === "string" && args.title.trim()) {
          current = {
            ...current,
            title: args.title.trim(),
            updatedAt: at,
          };
        }
        if (Array.isArray(args.steps)) {
          let steps: PlanStepSnapshot[] = current.steps.map((s) => ({ ...s }));
          for (const raw of args.steps) {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
            const entry = raw as Record<string, unknown>;
            if (typeof entry.id === "string" && entry.id.trim()) {
              const stepId = entry.id.trim();
              const idx = steps.findIndex((s) => s.id === stepId);
              if (idx < 0) continue;
              let next: PlanStepSnapshot = { ...steps[idx]! };
              if (typeof entry.title === "string" && entry.title.trim()) {
                next = { ...next, title: entry.title.trim() };
              }
              if (isStepStatus(entry.status)) {
                if (entry.status === "in_progress") {
                  const applied = applyStepInProgress(
                    steps.map((s, i) => (i === idx ? next : s)),
                    stepId,
                  );
                  if (applied) {
                    steps = applied;
                    continue;
                  }
                  steps = applyInProgressExclusive(
                    steps.map((s, i) => (i === idx ? next : s)),
                    stepId,
                  );
                  continue;
                }
                next = { ...next, status: entry.status };
              }
              steps[idx] = next;
            } else if (typeof entry.title === "string" && entry.title.trim()) {
              if (steps.length >= 12) continue;
              steps.push({
                id: nextStepId(steps),
                title: entry.title.trim(),
                status: "pending",
              });
            }
          }
          current = { ...current, steps, updatedAt: at };
        }
        byCreateId.set(current.createToolCallId, clonePlan(current));
        continue;
      }

      if (name === "complete_plan") {
        if (id) {
          const planTitle = current.title.trim() || "Plan";
          progressByToolCallId.set(id, {
            label: planTitle,
            kind: args.status === "cancelled" ? "cancelled" : "completed",
          });
        }
        const status =
          args.status === "cancelled" ? "cancelled" : "completed";
        const summary =
          typeof args.summary === "string" && args.summary.trim()
            ? args.summary.trim()
            : undefined;
        current = {
          ...current,
          status,
          steps: finalizeIncomplete(current.steps, status),
          updatedAt: at,
          ...(summary ? { summary } : {}),
        };
        byCreateId.set(current.createToolCallId, clonePlan(current));
      }
    }
  }

  if (live) {
    // Normalize older persisted plans that cancelled leftover steps on success.
    const normalized =
      live.status === "completed" || live.status === "cancelled"
        ? {
            ...live,
            steps: finalizeIncomplete(live.steps, live.status),
          }
        : live;
    byCreateId.set(normalized.createToolCallId, normalized);
  }

  return { plansByCreateToolCallId: byCreateId, progressByToolCallId };
}

function progressDisplayForUpdate(
  args: Record<string, unknown>,
  steps: PlanStepSnapshot[],
  planTitleRaw: string,
): PlanProgressDisplay | null {
  const planTitle = planTitleRaw.trim() || "Plan";
  const titleOnly =
    typeof args.title === "string" && args.title.trim()
      ? args.title.trim()
      : null;
  const rawSteps = Array.isArray(args.steps) ? args.steps : [];
  if (rawSteps.length === 0) {
    return titleOnly
      ? { label: `${planTitle} → ${titleOnly}`, kind: "updated" }
      : null;
  }

  for (const raw of rawSteps) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const status = entry.status;
    const stepId =
      typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : "";
    const fromArgs =
      typeof entry.title === "string" && entry.title.trim()
        ? entry.title.trim()
        : "";
    const fromPlan = stepId
      ? steps.find((s) => s.id === stepId)?.title.trim() ?? ""
      : "";
    const stepTitle = fromArgs || fromPlan || "Step";
    const label = `${planTitle} → ${stepTitle}`;
    if (status === "in_progress") {
      return { label, kind: "in_progress" };
    }
    if (status === "completed") {
      return { label, kind: "completed" };
    }
    if (status === "cancelled") {
      return { label, kind: "cancelled" };
    }
    if (fromArgs || fromPlan) {
      return { label, kind: "updated" };
    }
  }

  return titleOnly
    ? { label: `${planTitle} → ${titleOnly}`, kind: "updated" }
    : { label: planTitle, kind: "updated" };
}
