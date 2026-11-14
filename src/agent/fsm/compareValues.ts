/**
 * Shared typed comparator for FSM data primitives (blackboard / EdgeWhen).
 * Data-only: no host / context access — callers read values and pass them in.
 * Pure: every malformed input returns a named error (ok:false); the caller
 * decides strict → halt vs non-strict → treat as not met.
 */

export type FsmValueType = "int" | "float" | "string";

export const FSM_VALUE_TYPES: readonly FsmValueType[] = [
  "int",
  "float",
  "string",
];

export const FSM_COMPARE_OPERATORS = [
  "==",
  "!=",
  ">",
  "<",
  "<=",
  ">=",
] as const;

export type FsmCompareOperator = (typeof FSM_COMPARE_OPERATORS)[number];

export type CompareOutcome =
  | { ok: true; met: boolean }
  | { ok: false; error: string };

/** Parse a finite number from number | numeric string; undefined otherwise. */
export function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Coerce a params-level expected value (string | number) per declared type. */
export function coerceTypedExpected(
  type: FsmValueType,
  expected: unknown,
  label: string,
): { ok: true; value: number | string } | { ok: false; error: string } {
  if (type === "string") {
    if (typeof expected !== "string") {
      return {
        ok: false,
        error: `${label}: expected value must be a string when type is "string"`,
      };
    }
    return { ok: true, value: expected };
  }
  const n = parseFiniteNumber(expected);
  if (n === undefined) {
    return {
      ok: false,
      error: `${label}: expected value is not a finite ${type}`,
    };
  }
  if (type === "int" && !Number.isInteger(n)) {
    return {
      ok: false,
      error: `${label}: expected value ${n} is not an integer`,
    };
  }
  return { ok: true, value: n };
}

/**
 * Compare `actual` against `expected` under a declared value type + operator.
 *
 * - int/float: both sides go through {@link parseFiniteNumber} (numbers and
 *   numeric strings compare; `int` additionally requires an integer value).
 * - string: both sides must be real strings — no number→string coercion
 *   ("3" vs 3 stays a named error, not a silent match).
 *
 * Lexicographic ordering for strings; exact equality only (no epsilon).
 */
export function compareTyped(
  type: FsmValueType,
  operator: string,
  actual: unknown,
  expected: unknown,
  label = "compareTyped",
): CompareOutcome {
  if (!(FSM_COMPARE_OPERATORS as readonly string[]).includes(operator)) {
    return {
      ok: false,
      error: `${label}: unsupported operator "${operator}"`,
    };
  }

  const expectedOut = coerceTypedExpected(type, expected, label);
  if (!expectedOut.ok) return expectedOut;

  let a: number | string;
  if (type === "string") {
    if (typeof actual !== "string") {
      return {
        ok: false,
        error: `${label}: value is not a string (type "string" declared)`,
      };
    }
    a = actual;
  } else {
    const n = parseFiniteNumber(actual);
    if (n === undefined) {
      return {
        ok: false,
        error: `${label}: value is not a finite number (type "${type}" declared)`,
      };
    }
    if (type === "int" && !Number.isInteger(n)) {
      return {
        ok: false,
        error: `${label}: value ${n} is not an integer (type "int" declared)`,
      };
    }
    a = n;
  }

  const b = expectedOut.value;
  let met: boolean;
  switch (operator as FsmCompareOperator) {
    case "==":
      met = a === b;
      break;
    case "!=":
      met = a !== b;
      break;
    case ">":
      met = a > b;
      break;
    case "<":
      met = a < b;
      break;
    case "<=":
      met = a <= b;
      break;
    case ">=":
      met = a >= b;
      break;
  }
  return { ok: true, met };
}
