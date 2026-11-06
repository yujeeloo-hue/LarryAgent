/**
 * Shared typed-condition evaluation for Compare / EmitRouteEventWhen
 * (and legacy RouteToWhen migration). Data read → compare → outcome.
 *
 * Sources:
 * - blackboard (default): turnContext or session fsmBlackboard via key/scope
 * - planOpenSteps / planPresent / planDocPresent: Session fields (not blackboard)
 *
 * Outcome:
 * - halt — authoring bug; always named halt
 * - indeterminate — missing / type mismatch / no session capability
 * - met / notMet — clean comparison
 */

import { hasOpenPlanSteps, isActivePlan } from "../../../session/plan.js";
import { isPlanDocApproved } from "../../../session/planDoc.js";
import { parseDemoConfirmToolCallId } from "../../../session/demoConfirm.js";
import { compareTyped, type FsmValueType } from "../compareValues.js";
import { validateBlackboardKey } from "../blackboardKeys.js";
import type { NodeActionExecArgs } from "../types.js";

export const COMPARE_SOURCES = [
  "blackboard",
  "planOpenSteps",
  "planPresent",
  "planDocPresent",
  "planDocApproved",
  "autoSkillSummarize",
  "fullPermissions",
  "modelIterations",
  "toolFailureCount",
  "demoConfirm",
] as const;

export type CompareSource = (typeof COMPARE_SOURCES)[number];

export type ConditionOutcome =
  | { kind: "halt"; message: string }
  | { kind: "indeterminate"; message: string }
  | { kind: "met" }
  | { kind: "notMet" };

/** @deprecated Use {@link ConditionOutcome}. */
export type BlackboardConditionOutcome = ConditionOutcome;

function resolveSource(params: Record<string, unknown>): CompareSource {
  const raw = params.source;
  if (
    raw === "planOpenSteps" ||
    raw === "planPresent" ||
    raw === "planDocPresent" ||
    raw === "planDocApproved" ||
    raw === "blackboard" ||
    raw === "autoSkillSummarize" ||
    raw === "fullPermissions" ||
    raw === "modelIterations" ||
    raw === "toolFailureCount" ||
    raw === "demoConfirm"
  ) {
    return raw;
  }
  return "blackboard";
}

function numberFromContext(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readTurnMetric(
  source:
    | "autoSkillSummarize"
    | "fullPermissions"
    | "modelIterations"
    | "toolFailureCount"
    | "demoConfirm",
  args: NodeActionExecArgs,
  label: string,
): { ok: true; value: boolean | number } {
  void label;
  if (source === "autoSkillSummarize") {
    const enabled =
      args.turnInput?.autoSkillSummarize === true ||
      args.turnContext.autoSkillSummarize === true;
    return { ok: true, value: enabled };
  }
  if (source === "demoConfirm") {
    // Pure turn-level signal: is this turn's user input a demo confirm
    // marker message? No graph / role / model knowledge here.
    const text =
      typeof args.turnInput?.userText === "string"
        ? args.turnInput.userText
        : "";
    return { ok: true, value: parseDemoConfirmToolCallId(text) !== null };
  }
  if (source === "fullPermissions") {
    const enabled = args.host
      ? args.host.gate.fullPermissionsEnabled === true
      : args.turnContext.fullPermissionsEnabled === true;
    return { ok: true, value: enabled };
  }
  const counters = args.host?.getCounters();
  if (source === "modelIterations") {
    return {
      ok: true,
      value: counters
        ? counters.modelIterations
        : numberFromContext(args.turnContext.modelIterations),
    };
  }
  return {
    ok: true,
    value: counters
      ? counters.toolFailureCount
      : numberFromContext(args.turnContext.toolFailureCount),
  };
}

function readSessionFlag(
  source: Exclude<CompareSource, "blackboard">,
  args: NodeActionExecArgs,
  label: string,
): { ok: true; value: boolean } | { ok: false; message: string } {
  const session = args.host?.session;
  if (!session) {
    return {
      ok: false,
      message: `${label}: session host is not available for source "${source}"`,
    };
  }
  if (source === "planOpenSteps") {
    return { ok: true, value: hasOpenPlanSteps(session.plan) };
  }
  if (source === "planPresent") {
    return { ok: true, value: isActivePlan(session.plan) };
  }
  if (source === "planDocApproved") return { ok: true, value: isPlanDocApproved(session.planDoc) };
  // planDocPresent
  const path =
    typeof session.planDoc?.path === "string" ? session.planDoc.path.trim() : "";
  return { ok: true, value: path.length > 0 };
}

/**
 * Evaluate a typed condition. Blackboard sources need key (+ optional scope);
 * plan* sources ignore key and compare a boolean actual against params.value.
 */
export function evaluateCondition(
  params: Record<string, unknown>,
  args: NodeActionExecArgs,
  label: string,
): ConditionOutcome {
  const source = resolveSource(params);

  let actual: unknown;
  if (source === "blackboard") {
    const keyError = validateBlackboardKey(params.key, label);
    if (keyError) {
      return { kind: "halt", message: keyError };
    }
    const key = params.key as string;
    const scope = params.scope === "session" ? "session" : "turn";
    if (scope === "session" && !args.host?.blackboardGet) {
      return {
        kind: "indeterminate",
        message: `${label}: session blackboard capability is not available on this turn`,
      };
    }
    actual =
      scope === "session"
        ? args.host?.blackboardGet?.(key)
        : args.turnContext[key];
  } else if (
    source === "autoSkillSummarize" ||
    source === "fullPermissions" ||
    source === "modelIterations" ||
    source === "toolFailureCount" ||
    source === "demoConfirm"
  ) {
    const metric = readTurnMetric(source, args, label);
    actual = metric.value;
  } else {
    const flag = readSessionFlag(source, args, label);
    if (!flag.ok) {
      return { kind: "indeterminate", message: flag.message };
    }
    actual = flag.value;
  }

  const valueType: FsmValueType =
    source === "blackboard" ||
    source === "modelIterations" ||
    source === "toolFailureCount"
      ? ((params.type as FsmValueType) ??
          (source === "blackboard" ? "string" : "int"))
      : "string";
  // Booleans compare as strings "true"/"false" for a single typed path.
  const actualForCompare =
    typeof actual === "boolean" ? (actual ? "true" : "false") : actual;
  let expected = params.value;
  if (
    source !== "blackboard" &&
    source !== "modelIterations" &&
    source !== "toolFailureCount"
  ) {
    if (expected === true || expected === false) {
      expected = expected ? "true" : "false";
    } else if (expected === undefined) {
      expected = "true";
    }
  }

  const operator =
    typeof params.operator === "string" && params.operator.trim()
      ? params.operator.trim()
      : "==";

  const out = compareTyped(
    valueType,
    operator,
    actualForCompare,
    expected,
    label,
  );
  if (!out.ok) {
    return { kind: "indeterminate", message: `${label}: ${out.error}` };
  }
  return out.met ? { kind: "met" } : { kind: "notMet" };
}

/** @deprecated Use {@link evaluateCondition}. */
export function evaluateBlackboardCondition(
  params: Record<string, unknown>,
  args: NodeActionExecArgs,
  label: string,
): ConditionOutcome {
  return evaluateCondition(params, args, label);
}
