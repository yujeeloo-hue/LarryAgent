/**
 * Shared typed-condition evaluation for Compare / EmitRouteEventWhen
 * (and legacy RouteToWhen migration). Data read → compare → outcome.
 *
 * Sources:
 * - blackboard (default): turnContext or session fsmBlackboard via key/scope
 * - planOpenSteps / planPresent / planDocPresent: Session fields (not blackboard)
 * - numeric turn metrics: Host counters (turnContext fallback without a host)
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
import type { TurnHostCounters } from "../../turnHost/types.js";
import type { NodeActionExecArgs } from "../types.js";

/** Numeric Host counters exposed as Compare sources (int compare). */
export const NUMERIC_METRIC_SOURCES = [
  "modelIterations",
  "turnModelIterations",
  "toolFailureCount",
  "toolErrorCount",
  "toolRecoveryCount",
  "skillsReadCount",
] as const satisfies readonly (keyof TurnHostCounters)[];

export type NumericMetricSource = (typeof NUMERIC_METRIC_SOURCES)[number];

export const COMPARE_SOURCES = [
  "blackboard",
  "planOpenSteps",
  "planPresent",
  "planDocPresent",
  "planDocApproved",
  "autoSkillSummarize",
  "fullPermissions",
  ...NUMERIC_METRIC_SOURCES,
  "demoConfirm",
] as const;

export type CompareSource = (typeof COMPARE_SOURCES)[number];

export function isNumericMetricSource(raw: unknown): raw is NumericMetricSource {
  return (NUMERIC_METRIC_SOURCES as readonly unknown[]).includes(raw);
}

/** Sources that read a turn / session fact instead of a blackboard key. */
export function isNonBlackboardSource(raw: unknown): raw is Exclude<CompareSource, "blackboard"> {
  return raw !== "blackboard" && (COMPARE_SOURCES as readonly unknown[]).includes(raw);
}

export type ConditionOutcome =
  | { kind: "halt"; message: string }
  | { kind: "indeterminate"; message: string }
  | { kind: "met" }
  | { kind: "notMet" };

/** @deprecated Use {@link ConditionOutcome}. */
export type BlackboardConditionOutcome = ConditionOutcome;

function resolveSource(params: Record<string, unknown>): CompareSource {
  return isNonBlackboardSource(params.source) ? params.source : "blackboard";
}

function numberFromContext(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readTurnFlag(
  source: "autoSkillSummarize" | "fullPermissions" | "demoConfirm",
  args: NodeActionExecArgs,
): boolean {
  if (source === "autoSkillSummarize") {
    return (
      args.turnInput?.autoSkillSummarize === true ||
      args.turnContext.autoSkillSummarize === true
    );
  }
  if (source === "demoConfirm") {
    // Pure turn-level signal: is this turn's user input a demo confirm
    // marker message? No graph / role / model knowledge here.
    const text =
      typeof args.turnInput?.userText === "string"
        ? args.turnInput.userText
        : "";
    return parseDemoConfirmToolCallId(text) !== null;
  }
  return args.host
    ? args.host.gate.fullPermissionsEnabled === true
    : args.turnContext.fullPermissionsEnabled === true;
}

function readTurnMetric(source: NumericMetricSource, args: NodeActionExecArgs): number {
  const counters = args.host?.getCounters();
  return counters
    ? numberFromContext(counters[source])
    : numberFromContext(args.turnContext[source]);
}

function readSessionFlag(
  source: "planOpenSteps" | "planPresent" | "planDocPresent" | "planDocApproved",
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
  } else if (isNumericMetricSource(source)) {
    actual = readTurnMetric(source, args);
  } else if (
    source === "autoSkillSummarize" ||
    source === "fullPermissions" ||
    source === "demoConfirm"
  ) {
    actual = readTurnFlag(source, args);
  } else {
    const flag = readSessionFlag(source, args, label);
    if (!flag.ok) {
      return { kind: "indeterminate", message: flag.message };
    }
    actual = flag.value;
  }

  const numeric = isNumericMetricSource(source);
  const valueType: FsmValueType =
    source === "blackboard" || numeric
      ? ((params.type as FsmValueType) ??
          (source === "blackboard" ? "string" : "int"))
      : "string";
  // Booleans compare as strings "true"/"false" for a single typed path.
  const actualForCompare =
    typeof actual === "boolean" ? (actual ? "true" : "false") : actual;
  let expected = params.value;
  if (source !== "blackboard" && !numeric) {
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
