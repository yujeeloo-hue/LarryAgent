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

export const updatePlanDefinition: ToolDefinition = {
  name: "update_plan",
  description:
    "Update the active serial checklist: step status/title, plan title, or append steps. " +
    "Do not skip steps. Complete the current in_progress step — or a contiguous run of steps starting at it — in one call. " +
    "The next ready step starts automatically.",
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
              description: "New status for this step.",
            },
          },
          additionalProperties: false,
        },
        description:
          "Partial updates and/or appended steps (queued at the end of the list). Send the current step's completion, or a contiguous run of completions from that step.",
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

function completionPayload(stepId: string): string {
  return `{"steps":[{"id":"${stepId}","status":"completed"}]}`;
}

function completionInstruction(stepId: string): string {
  return `Send only ${completionPayload(stepId)}. The next ready step starts automatically.`;
}

function currentCursor(steps: PlanStep[]): PlanStep | undefined {
  return inProgressSteps(steps)[0] ?? getReadySteps(steps)[0];
}

function currentStepHint(steps: PlanStep[]): string {
  const cursor = currentCursor(steps);
  if (cursor) return completionInstruction(cursor.id);
  return "No serial step is currently ready.";
}

function openChainFromCursor(steps: PlanStep[]): PlanStep[] {
  const cursor = currentCursor(steps);
  if (!cursor) return [];
  const start = steps.findIndex((step) => step.id === cursor.id);
  if (start < 0) return [];
  const chain: PlanStep[] = [];
  for (const step of steps.slice(start)) {
    if (step.status === "completed" || step.status === "cancelled") continue;
    chain.push(step);
  }
  return chain;
}

function consecutivePrefixIds(
  newlyCompleted: ParsedStepPatch[],
  steps: PlanStep[],
): string[] | null {
  const chain = openChainFromCursor(steps);
  if (chain.length < 2) return null;
  const ids = new Set(newlyCompleted.map((patch) => patch.id));
  let count = 0;
  while (count < chain.length && ids.has(chain[count]!.id)) count += 1;
  if (count < 2 || ids.size !== count) return null;
  return chain.slice(0, count).map((step) => step.id);
}

function oneCompletionError(
  steps: PlanStep[],
  newlyCompleted: ParsedStepPatch[],
): string {
  const cursor = currentCursor(steps);
  const received = newlyCompleted.map((patch) => patch.id);
  if (!cursor) {
    return `Invalid arguments: complete a contiguous run from the current step; received ${received.join(", ")}. No serial step is currently ready.`;
  }
  const leave = received.filter((id) => id !== cursor.id);
  const leaveText =
    leave.length > 0
      ? ` Leave ${leave.join(", ")} unchanged — the list skips a step.`
      : "";
  return `Invalid arguments: Send only ${completionPayload(cursor.id)}, or a contiguous run of completions starting at ${cursor.id}.${leaveText} The next ready step starts automatically.`;
}

function prefixDependencyError(ids: string[], steps: PlanStep[]): string | null {
  const done = new Set(
    steps.filter((step) => step.status === "completed").map((step) => step.id),
  );
  for (const id of ids) {
    const step = steps.find((item) => item.id === id);
    if (!step) return `Invalid arguments: unknown step id "${id}".`;
    if (step.status === "cancelled") {
      return `Invalid arguments: cancelled step "${id}" cannot be completed. Append a corrective step instead.`;
    }
    const waiting = (step.dependsOn ?? []).filter((depId) => !done.has(depId));
    if (waiting.length > 0) {
      const states = waiting
        .map((depId) => {
          const dependency = steps.find((item) => item.id === depId);
          return `${depId} (${dependency?.status ?? "missing"})`;
        })
        .join(", ");
      return `Invalid arguments: cannot complete "${id}"; it is waiting on ${states}. ${currentStepHint(steps)}`;
    }
    done.add(id);
  }
  return null;
}

function batchApplyNote(
  ids: string[],
  droppedStartId: string | null,
  steps: PlanStep[],
): string {
  const current = inProgressSteps(steps)[0];
  const parts = [`Completed ${ids.join(", ")}.`];
  if (droppedStartId && droppedStartId !== current?.id) {
    parts.push(`Did not start ${droppedStartId}.`);
  }
  if (current) parts.push(`${current.id} is now in_progress.`);
  return parts.join(" ");
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
  let batchIds: string[] | null = null;
  let droppedStartId: string | null = null;

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

    const unfinishedCompletions = () =>
      patches.filter((patch) => {
        if (patch.status !== "completed") return false;
        return steps.find((step) => step.id === patch.id)?.status !== "completed";
      });

    let newlyCompleted = unfinishedCompletions();
    if (newlyCompleted.length > 1) {
      const prefix = consecutivePrefixIds(newlyCompleted, steps);
      const disruptive = patches.some(
        (patch) => patch.status === "cancelled" || patch.status === "pending",
      );
      const starts = patches.filter((patch) => patch.status === "in_progress");
      if (!prefix) {
        return failureResult(
          oneCompletionError(steps, newlyCompleted),
          ToolReturnCode.InvalidArguments,
        );
      }
      if (disruptive) {
        return failureResult(
          "Invalid arguments: a batch completion cannot also cancel or reopen a step. Send those updates in their own call.",
          ToolReturnCode.InvalidArguments,
        );
      }
      if (starts.length > 1) {
        return failureResult(
          `Invalid arguments: ${currentStepHint(steps)} Only one step may be in_progress; received ${starts.map((patch) => patch.id).join(", ")}.`,
          ToolReturnCode.InvalidArguments,
        );
      }
      const depError = prefixDependencyError(prefix, steps);
      if (depError) {
        return failureResult(depError, ToolReturnCode.InvalidArguments);
      }
      const nextId = openChainFromCursor(steps)[prefix.length]?.id ?? null;
      const start = starts[0];
      if (start && start.id !== nextId) {
        droppedStartId = start.id;
        start.status = null;
      }
      batchIds = prefix;
    }

    for (const patch of patches) {
      if (!patch.title) continue;
      const idx = steps.findIndex((step) => step.id === patch.id);
      steps[idx] = { ...steps[idx]!, title: patch.title };
    }

    const requestedStarts = patches.filter(
      (patch) => patch.status === "in_progress",
    );
    if (requestedStarts.length > 1) {
      return failureResult(
        `Invalid arguments: ${currentStepHint(steps)} Only one step may be in_progress; received ${requestedStarts.map((patch) => patch.id).join(", ")}.`,
        ToolReturnCode.InvalidArguments,
      );
    }

    const transitionBaseline = cloneSteps(steps);
    const completion = batchIds ? undefined : newlyCompleted[0];
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
          `Invalid arguments: Send only ${completionPayload(active.id)}. Leave "${target.id}" unchanged while "${active.id}" is in_progress. The next ready step starts automatically.`,
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
          `Invalid arguments: ${currentStepHint(transitionBaseline)} Cannot complete "${target.id}"; it is waiting on ${states}.`,
          ToolReturnCode.InvalidArguments,
        );
      }
    }

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

    const requestedStart = requestedStarts[0];
    if (requestedStart) {
      const target = steps.find((step) => step.id === requestedStart.id)!;
      if (target.status !== "in_progress") {
        const active = inProgressSteps(steps)[0];
        if (active) {
          return failureResult(
            `Invalid arguments: Send only ${completionPayload(active.id)}. Cannot start "${target.id}" while "${active.id}" is in_progress. The next ready step starts automatically.`,
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

    if (newlyCompleted.length >= 1 && inProgressSteps(steps).length === 0) {
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
  const summary = formatPlanSummary(plan);
  const note =
    batchIds && batchIds.length > 1
      ? batchApplyNote(batchIds, droppedStartId, steps)
      : "";
  return {
    ...textResult(note ? `${note}\n${summary}` : summary, ToolReturnCode.Success),
    sessionPatch: {
      plan: withPlanDocRef(plan, context.planDocSnapshot),
    },
    ...(hasOpenPlanSteps(plan)
      ? { routeEvent: { event: "plan_resume", source: "tool" as const } }
      : {}),
  };
};
