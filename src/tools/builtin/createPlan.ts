import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isPlanDocApproved, planDocRevision } from "../../session/planDoc.js";
import {
  applyStepInProgress,
  buildPlanStepsFromSpecs,
  formatPlanSummary,
  hasOpenPlanSteps,
  parseCreatePlanArgs,
  withPlanDocRef,
} from "../../session/plan.js";
import type { SessionPlan } from "../../session/types.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";

/** Default level: 0 — multi-step plan UI signal. */
export const createPlanDefinition: ToolDefinition = {
  name: "create_plan",
  description:
    "Create a serial execution checklist: an ordered list of 2–12 step titles. " +
    "Steps run in list order, one at a time.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Optional short plan title (default: Plan).",
      },
      steps: {
        type: "array",
        description:
          "Step titles in execution order (2–12). First item is step s1, then s2, and so on.",
        items: {
          type: "string",
          description: "One checklist item to run after the previous item finishes.",
        },
      },
    },
    required: ["steps"],
  },
  defaultPermissionLevel: 0,
};

export const createPlanHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const parsed = parseCreatePlanArgs(args);
  if (!parsed.ok) {
    return failureResult(parsed.message, ToolReturnCode.InvalidArguments);
  }

  const doc = context.planDocSnapshot ?? null;
  if (context.requirePlanDocApprovalForCreatePlan) {
    if (!isPlanDocApproved(doc) || !doc) return failureResult("The current plan document must be approved before creating an execution checklist.", ToolReturnCode.InvalidArguments);
    try {
      context.assertPath?.(doc.path);
      if (planDocRevision(await readFile(doc.path, "utf8")) !== doc.approvedRevision) return failureResult("The plan document changed after approval. Review the current version first.", ToolReturnCode.InvalidArguments);
    } catch {
      return failureResult(`Could not read plan document: ${doc.path}`, ToolReturnCode.NotFound);
    }
  }
  if (context.requirePlanDocForCreatePlan) {
    if (!doc?.path?.trim()) {
      return failureResult(
        "A plan document is required first. Call write_plan_doc " +
          "(under docs/plans/) with title, content, and summary, then create_plan.",
        ToolReturnCode.InvalidArguments,
      );
    }
  }

  const toolCallId = context.toolCallId?.trim();
  if (!toolCallId) {
    return failureResult(
      "Internal error: missing tool call id for create_plan.",
      ToolReturnCode.GenericFailure,
    );
  }

  let steps;
  try {
    steps = buildPlanStepsFromSpecs(parsed.stepSpecs);
    const first = steps[0];
    if (first) {
      const started = applyStepInProgress(steps, first.id);
      if (!started.ok) {
        return failureResult(
          `Internal error: could not start the first plan step. ${started.message}`,
          ToolReturnCode.GenericFailure,
        );
      }
      steps = started.steps;
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Invalid plan dependency graph.";
    return failureResult(message, ToolReturnCode.InvalidArguments);
  }

  const now = Date.now();
  const plan: SessionPlan = withPlanDocRef(
    {
      id: randomUUID(),
      title: parsed.title,
      status: "active",
      steps,
      createdAt: now,
      updatedAt: now,
      createToolCallId: toolCallId,
    },
    doc,
  );

  return {
    ...textResult(formatPlanSummary(plan), ToolReturnCode.Success),
    sessionPatch: { plan },
    ...(hasOpenPlanSteps(plan)
      ? { routeEvent: { event: "plan_resume", source: "tool" as const } }
      : {}),
  };
};
