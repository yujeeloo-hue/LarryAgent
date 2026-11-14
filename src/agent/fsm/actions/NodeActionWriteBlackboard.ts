import { FSMConfigError } from "../FSMConfigError.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { parseFiniteNumber } from "../compareValues.js";
import { validateBlackboardKey } from "../blackboardKeys.js";
import { NodeActionStubBase } from "./NodeActionStubBase.js";

/** Pure semantic checks for normalized Action params. */
export function validateNodeActionWriteBlackboardParams(
  params: Readonly<Record<string, unknown>>,
  label: string,
): void {
  const keyError = validateBlackboardKey(params.key, label);
  if (keyError) {
    throw new FSMConfigError("INVALID_ACTION_PARAMS", keyError);
  }
  const mode = params.mode ?? "set";
  if (mode === "increment") {
    if (
      params.value !== undefined &&
      parseFiniteNumber(params.value) === undefined
    ) {
      throw new FSMConfigError(
        "INVALID_ACTION_PARAMS",
        `${label}: mode "increment" requires a numeric value operand (or omit it for +1)`,
      );
    }
    return;
  }
  if (mode === "multiply") {
    if (parseFiniteNumber(params.value) === undefined) {
      throw new FSMConfigError(
        "INVALID_ACTION_PARAMS",
        `${label}: mode "multiply" requires a numeric value operand`,
      );
    }
    return;
  }
  if (params.value === undefined) {
    throw new FSMConfigError(
      "INVALID_ACTION_PARAMS",
      `${label}: mode "set" requires a value`,
    );
  }
}

export const NodeActionWriteBlackboardSchema: FsmParamsSchema = {
  type: "object",
  title: "Write blackboard",
  description:
    "Set / increment / multiply a blackboard key. scope=turn lives on turnContext (this turn only); scope=session persists in the session store (survives restarts, cleared with the session).",
  "x-llmDescription": "Write a blackboard key: key (required), mode set (default) | increment | multiply, value, scope turn (default) | session, strict. Reserved FSM keys are rejected; workflow phase uses key 'phase' with scope session.",
  details: `Blackboard write. mode="set" stores value verbatim (any JSON); mode="increment" adds the numeric value operand to the current value; mode="multiply" multiplies. increment treats a missing current value as 0 (counters start from zero); multiply requires an existing numeric value.

Numeric guards are always named halts, never strict-dependent: non-numeric current value, non-finite result (Infinity/NaN would serialize to null and corrupt session persistence). A missing session host capability (stub / subagent path) skips silently unless strict=true.

Reserved turnContext keys (routeTarget / routeEvent / haltResult / …) are rejected as blackboard keys at validation and Exec time. Workflow phase uses key "phase" with scope=session (value null clears the key).`,
  additionalProperties: false,
  required: ["key"],
  properties: {
    key: {
      type: "string",
      minLength: 1,
      title: "Key",
      description:
        "Blackboard key (letters/digits/._-; reserved FSM keys rejected).",
      "x-ui": "text",
    },
    scope: {
      type: "string",
      enum: ["turn", "session"],
      default: "turn",
      title: "Scope",
      description:
        "turn = this turn's context only; session = persisted with the session.",
      "x-ui": "select",
      "x-enumLabels": { turn: "Turn", session: "Session (persisted)" },
    },
    value: {
      title: "Value",
      description:
        "set: any JSON value (required). increment: numeric operand, defaults to 1. multiply: numeric operand (required).",
    },
    mode: {
      type: "string",
      enum: ["set", "increment", "multiply"],
      default: "set",
      title: "Mode",
      description: "set stores value; increment adds; multiply multiplies.",
      "x-ui": "select",
    },
    strict: {
      type: "boolean",
      default: false,
      title: "Strict",
      description:
        "Halt (named error) when the session host capability is missing; otherwise skip silently.",
      "x-ui": "toggle",
    },
  },
};

/**
 * Blackboard write (set / increment / multiply). Data-only Action: turn scope
 * patches turnContext; session scope goes through the optional host
 * blackboardGet / blackboardSet capability (persisted per session).
 */
export class NodeActionWriteBlackboard extends NodeActionStubBase {
  readonly type = "NodeActionWriteBlackboard";

  /** number → valid operand; string → named halt message. */
  private resolveOperand(mode: "increment" | "multiply"): number | string {
    if (this.params.value === undefined) {
      // Counter bump default: increment without an operand adds 1.
      if (mode === "increment") return 1;
      return `${this.type}: mode "${mode}" requires a numeric value operand`;
    }
    const parsed = parseFiniteNumber(this.params.value);
    if (parsed === undefined) {
      return `${this.type}: mode "${mode}" requires a numeric value operand`;
    }
    return parsed;
  }

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const label = this.type;
    const keyError = validateBlackboardKey(this.params.key, label);
    if (keyError) {
      return { status: "halt", errorMessage: keyError };
    }
    const key = this.params.key as string;
    const scope = this.params.scope === "session" ? "session" : "turn";
    const mode =
      this.params.mode === "increment" || this.params.mode === "multiply"
        ? this.params.mode
        : "set";
    const setCap = args.host?.blackboardSet;

    if (scope === "session" && !setCap) {
      if (this.params.strict === true) {
        return {
          status: "halt",
          errorMessage: `${label}: session blackboard capability is not available on this turn`,
        };
      }
      return { status: "continue" };
    }

    let value: unknown;
    if (mode === "set") {
      if (this.params.value === undefined) {
        return {
          status: "halt",
          errorMessage: `${label}: mode "set" requires a value`,
        };
      }
      value = this.params.value;
    } else {
      const current =
        scope === "session"
          ? args.host?.blackboardGet?.(key)
          : args.turnContext[key];

      let currentNumber: number;
      if (current === undefined) {
        if (mode === "multiply") {
          return {
            status: "halt",
            errorMessage: `${label}: multiply requires an existing numeric value at "${key}"`,
          };
        }
        currentNumber = 0;
      } else {
        const parsed = parseFiniteNumber(current);
        if (parsed === undefined) {
          return {
            status: "halt",
            errorMessage: `${label}: current value at "${key}" is not a number (got ${typeof current})`,
          };
        }
        currentNumber = parsed;
      }

      const operand = this.resolveOperand(mode);
      if (typeof operand !== "number") {
        return { status: "halt", errorMessage: operand };
      }

      const result =
        mode === "increment" ? currentNumber + operand : currentNumber * operand;
      if (!Number.isFinite(result)) {
        return {
          status: "halt",
          errorMessage: `${label}: ${mode} on "${key}" produced a non-finite result (${result}) — write rejected`,
        };
      }
      value = result;
    }

    if (scope === "turn") {
      return { status: "continue", turnContextPatch: { [key]: value } };
    }

    // Session scope — the capability check above guarantees setCap exists.
    if (!setCap) {
      return { status: "continue" };
    }
    const out = setCap(key, value);
    if (!out.ok) {
      return { status: "halt", errorMessage: `${label}: ${out.error}` };
    }
    return { status: "continue" };
  }
}
