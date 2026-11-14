import {
  PLAN_MAX_STEPS,
  PLAN_STEP_TITLE_MAX,
  PLAN_TITLE_MAX,
  applyStepInProgress,
  clipTitle,
  formatPlanSummary,
  getReadySteps,
  hasOpenPlanSteps,
  inProgressSteps,
  isActivePlan,
  isPlanStepStatus,
  nextStepId,
  withPlanDocRef,
} from "../../session/plan.js";
import type {
  PlanStep,
  PlanStepStatus,
  SessionPlan,
} from "../../session/types.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { JsonObject, ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";

/** Default level: 0 — update active multi-step plan. */
export const updatePlanDefinition: ToolDefinition = {
  name: "update_plan",
  description:
    "Update the active serial checklist (step status/title, plan title, or append steps at the end). " +
    "Execution is strictly one step at a time. Mark the current step completed; the next ready step starts automatically. " +
    "A combined completed + in_progress update is also accepted and applied transactionally.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Optional new plan title.",
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Existing step id (omit to append a new step).",
            },
            title: {
              type: "string",
              description: "New step title (rename or append).",
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled"],
              description:
                "New step status. Complete only the current serial step (one completed per call). The next ready step starts automatically.",
            },
          },
          additionalProperties: false,
        },
        description:
          "Partial updates and/or appends. Appended steps are queued at the end of the serial list. Prefer a single completed update for the current step.",
      },
    },
    required: [],
  },
  defaultPermissionLevel: 0,
};

type ParsedStepPatch = {
  id: string;
  title: string | null;
  status: PlanStepStatus | null;
};

function cloneSteps(steps: PlanStep[]): PlanStep[] {
  return steps.map((step) => ({
    ...step,
    ...(step.dependsOn ? { dependsOn: [...step.dependsOn] } : {}),
  }));
}

function completionExample(stepId: string): string {
  return `Example: {"steps":[{"id":"${stepId}","status":"completed"}]}. The next ready step starts automatically.`;
}

function currentStepHint(steps: PlanStep[]): string {
  const current = inProgressSteps(steps)[0];
  if (current) return completionExample(current.id);
  const ready = getReadySteps(steps)[0];
  if (ready) {
    return `Start the current step first, or complete it directly: {"steps":[{"id":"${ready.id}","status":"completed"}]}.`;
  }
  return "No serial step is currently ready.";
}

export const updatePlanHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const current = context.planSnapshot ?? null;
  if (!isActivePlan(current) || !current) {
    return failureResult("No active plan to update.", ToolReturnCode.NotFound);
  }

  const hasTitle = typeof args.title === "string" && args.title.trim().length > 0;
  const hasSteps = Array.isArray(args.steps) && args.steps.length > 0;
  if (!hasTitle && !hasSteps) {
    return failureResult(
      'Invalid arguments: provide "title" and/or "steps".',
      ToolReturnCode.InvalidArguments,
    );
  }

  let title = current.title;
  if (hasTitle) {
    title = clipTitle(args.title as string, PLAN_TITLE_MAX);
  }

  let steps = cloneSteps(current.steps);

  if (hasSteps) {
    const patches: ParsedStepPatch[] = [];
    const patchById = new Map<string, ParsedStepPatch>();

    for (const raw of args.steps as unknown[]) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return failureResult(
          'Invalid arguments: each steps entry must be an object.',
          ToolReturnCode.InvalidArguments,
        );
      }
      const entry = raw as JsonObject;
      const id =
        typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : null;
      const stepTitle =
        typeof entry.title === "string" && entry.title.trim()
          ? clipTitle(entry.title, PLAN_STEP_TITLE_MAX)
          : null;
      const status = isPlanStepStatus(entry.status) ? entry.status : null;

      if (!id) {
        if (!stepTitle) {
          return failureResult(
            'Invalid arguments: new steps need a "title" (omit "id" to append).',
            ToolReturnCode.InvalidArguments,
          );
        }
        if (steps.length >= PLAN_MAX_STEPS) {
          return failureResult(
            `Invalid arguments: at most ${PLAN_MAX_STEPS} steps.`,
            ToolReturnCode.InvalidArguments,
          );
        }
        steps.push({
          id: nextStepId(steps),
          title: stepTitle,
          status: "pending",
        });
        continue;
      }

      const idx = steps.findIndex((s) => s.id === id);
      if (idx < 0) {
        const known = steps.map((step) => step.id).join(", ");
        return failureResult(
          `Invalid arguments: unknown step id "${id}". Known steps: ${known || "(none)"}. ${currentStepHint(steps)}`,
          ToolReturnCode.InvalidArguments,
        );
      }
      if (!stepTitle && !status) {
        return failureResult(
          `Invalid arguments: step "${id}" needs "status" and/or "title".`,
          ToolReturnCode.InvalidArguments,
        );
      }

      const duplicate = patchById.get(id);
      if (
        duplicate?.status &&
        status &&
        duplicate.status !== status
      ) {
        return failureResult(
          `Invalid arguments: step "${id}" has conflicting statuses "${duplicate.status}" and "${status}" in one update.`,
          ToolReturnCode.InvalidArguments,
        );
      }
      const patch: ParsedStepPatch = {
        id,
        title: stepTitle ?? duplicate?.title ?? null,
        status: status ?? duplicate?.status ?? null,
      };
      if (duplicate) {
        Object.assign(duplicate, patch);
      } else {
        patches.push(patch);
        patchById.set(id, patch);
      }
    }

    // Titles are independent of status transitions and can be applied first.
    for (const patch of patches) {
      if (!patch.title) continue;
      const idx = steps.findIndex((step) => step.id === patch.id);
      steps[idx] = { ...steps[idx]!, title: patch.title };
    }

    const newlyCompleted = patches.filter((patch) => {
      if (patch.status !== "completed") return false;
      return steps.find((step) => step.id === patch.id)?.status !== "completed";
    });
    if (newlyCompleted.length > 1) {
      return failureResult(
        `Invalid arguments: complete only one unfinished step per update; received ${newlyCompleted.map((patch) => patch.id).join(", ")}. ${currentStepHint(steps)}`,
        ToolReturnCode.InvalidArguments,
      );
    }

    const requestedStarts = patches.filter(
      (patch) => patch.status === "in_progress",
    );
    if (requestedStarts.length > 1) {
      return failureResult(
        `Invalid arguments: only one step may be in_progress; received ${requestedStarts.map((patch) => patch.id).join(", ")}. ${currentStepHint(steps)}`,
        ToolReturnCode.InvalidArguments,
      );
    }

    const transitionBaseline = cloneSteps(steps);
    const completion = newlyCompleted[0];
    if (completion) {
      const target = transitionBaseline.find(
        (step) => step.id === completion.id,
      )!;
      if (target.status === "cancelled") {
        return failureResult(
          `Invalid arguments: cancelled step "${target.id}" cannot be completed. Append a corrective step instead.`,
          ToolReturnCode.InvalidArguments,
        );
      }
      const active = inProgressSteps(transitionBaseline).find(
        (step) => step.id !== target.id,
      );
      if (active) {
        return failureResult(
          `Invalid arguments: cannot complete "${target.id}" while "${active.id}" is in_progress. Complete the current serial step first. ${completionExample(active.id)}`,
          ToolReturnCode.InvalidArguments,
        );
      }
      const waiting =
        target.dependsOn?.filter((depId) => {
          return (
            transitionBaseline.find((step) => step.id === depId)?.status !==
            "completed"
          );
        }) ?? [];
      if (waiting.length > 0) {
        const states = waiting
          .map((depId) => {
            const dependency = transitionBaseline.find(
              (step) => step.id === depId,
            );
            return `${depId} (${dependency?.status ?? "missing"})`;
          })
          .join(", ");
        return failureResult(
          `Invalid arguments: cannot complete "${target.id}"; it is waiting on ${states}. Complete one serial step at a time. ${currentStepHint(transitionBaseline)}`,
          ToolReturnCode.InvalidArguments,
        );
      }
    }

    // Phase 1: apply terminal/reset transitions before any start transition.
    // This makes [complete current, start next] independent of argument order.
    for (const patch of patches) {
      if (
        patch.status !== "completed" &&
        patch.status !== "cancelled" &&
        patch.status !== "pending"
      ) {
        continue;
      }
      const idx = steps.findIndex((step) => step.id === patch.id);
      const previous = steps[idx]!;

      if (patch.status === "completed") {
        if (previous.status === "completed") continue;
        // A ready pending step is treated as having been started and completed
        // atomically. This repairs legacy plans that have no in-progress step.
        steps[idx] = { ...previous, status: "completed" };
        continue;
      }

      if (patch.status === "pending" && previous.status === "completed") {
        return failureResult(
          `Invalid arguments: completed step "${patch.id}" cannot be reopened. Append a corrective step instead.`,
          ToolReturnCode.InvalidArguments,
        );
      }
      steps[idx] = { ...previous, status: patch.status };
    }

    // Phase 2: apply the optional explicit start against the post-completion
    // snapshot. This accepts either argument order transactionally.
    const requestedStart = requestedStarts[0];
    if (requestedStart) {
      const target = steps.find((step) => step.id === requestedStart.id)!;
      if (target.status !== "in_progress") {
        const active = inProgressSteps(steps)[0];
        if (active) {
          return failureResult(
            `Invalid arguments: cannot start "${target.id}" while "${active.id}" is in_progress. ${completionExample(active.id)}`,
            ToolReturnCode.InvalidArguments,
          );
        }
        const applied = applyStepInProgress(steps, target.id);
        if (!applied.ok) {
          return failureResult(
            `${applied.message} ${currentStepHint(steps)}`,
            ToolReturnCode.InvalidArguments,
          );
        }
        steps = applied.steps;
      }
    }

    // Phase 3: completing the current step advances the serial checklist even
    // when the caller omits an explicit in_progress patch.
    if (newlyCompleted.length === 1 && inProgressSteps(steps).length === 0) {
      const next = getReadySteps(steps)[0];
      if (next) {
        const applied = applyStepInProgress(steps, next.id);
        if (applied.ok) steps = applied.steps;
      }
    }
  }

  const plan: SessionPlan = {
    ...current,
    title,
    steps,
    updatedAt: Date.now(),
  };
  return {
    ...textResult(formatPlanSummary(plan), ToolReturnCode.Success),
    sessionPatch: {
      plan: withPlanDocRef(plan, context.planDocSnapshot),
    },
    ...(hasOpenPlanSteps(plan)
      ? { routeEvent: { event: "plan_resume", source: "tool" as const } }
      : {}),
  };
};
