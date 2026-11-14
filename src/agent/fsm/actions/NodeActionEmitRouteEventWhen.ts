import { validateBlackboardKey } from "../blackboardKeys.js";
import { FSMConfigError } from "../FSMConfigError.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import {
  coerceTypedExpected,
  FSM_COMPARE_OPERATORS,
  FSM_VALUE_TYPES,
} from "../compareValues.js";
import { evaluateBlackboardCondition } from "./blackboardCondition.js";
import { NodeActionStubBase } from "./NodeActionStubBase.js";

/** Pure semantic checks for normalized Action params. */
export function validateNodeActionEmitRouteEventWhenParams(
  params: Readonly<Record<string, unknown>>,
  label: string,
): void {
  const keyError = validateBlackboardKey(params.key, label);
  if (keyError) {
    throw new FSMConfigError("INVALID_ACTION_PARAMS", keyError);
  }
  if (
    params.type === "int" ||
    params.type === "float" ||
    params.type === "string"
  ) {
    const expected = coerceTypedExpected(
      params.type,
      params.value,
      `${label} params.value`,
    );
    if (!expected.ok) {
      throw new FSMConfigError("INVALID_ACTION_PARAMS", expected.error);
    }
  }
}

export const NodeActionEmitRouteEventWhenSchema: FsmParamsSchema = {
  type: "object",
  title: "Emit route event when",
  description:
    "Typed condition that fires a named route event when met — Route to on the same node resolves the event through its event→pin bindings, decoupling the condition from routing topology.",
  "x-llmDescription": "Typed condition that fires a named route event: key, type (int|float|string), operator, value, event (all required), scope turn|session, strict. Bind the event in RouteTo routes on the same node — otherwise it falls through to the stay/leave fallback.",
  details: `Condition event. Reads key (scope=turn from turnContext, scope=session from the persisted session blackboard) and compares it against value under the declared type (int / float / string) and operator (== != > < <= >=; strings compare lexicographically) — exactly like Route to when. On a match it writes nodeContext.routeEvent = event (routeEventSource "blackboard") instead of a pin: Route to on the same node looks the event up in its routes map (event → pin), so one condition can feed different pins per node and several conditions can coexist on one node — each only speaks when it holds.

Unmet / uninterpretable value / missing session capability: nothing is written (an earlier routeEvent this round stays intact) unless strict=true (then a named halt). The event name is matched verbatim by Route to bindings — bind it explicitly on Route to (event → pin), otherwise the round falls through to the stay/leave fallback and the event has no effect.`,
  additionalProperties: false,
  required: ["key", "type", "operator", "value", "event"],
  properties: {
    key: {
      type: "string",
      minLength: 1,
      title: "Key",
      description: "Blackboard / context key to compare.",
      "x-ui": "text",
    },
    scope: {
      type: "string",
      enum: ["turn", "session"],
      default: "turn",
      title: "Scope",
      description:
        "turn = this turn's context; session = persisted session blackboard (explicit authoring decision — the event then depends on cross-turn state).",
      "x-ui": "select",
      "x-enumLabels": { turn: "Turn", session: "Session (persisted)" },
    },
    type: {
      type: "string",
      enum: [...FSM_VALUE_TYPES],
      title: "Type",
      description:
        "int (integer), float (finite number), string (lexicographic).",
      "x-ui": "select",
      "x-enumLabels": { int: "Int", float: "Float", string: "String" },
    },
    operator: {
      type: "string",
      enum: [...FSM_COMPARE_OPERATORS],
      title: "Operator",
      description: "Comparison operator.",
      "x-ui": "select",
    },
    value: {
      title: "Value",
      description:
        "Expected value — number or numeric string for int/float, string for string.",
    },
    event: {
      type: "string",
      minLength: 1,
      title: "Event",
      description:
        "Route event name (matched verbatim by Route to bindings on this node).",
      "x-ui": "text",
    },
    strict: {
      type: "boolean",
      default: false,
      title: "Strict",
      description:
        "Halt (named error) when the key is missing, the value does not match the declared type, or the session host capability is absent; otherwise treat as not met.",
      "x-ui": "toggle",
    },
  },
};

/**
 * Typed condition → named route event. Met writes routeEvent / routeEventSource
 * for Route to on the same node; unmet writes nothing (composable with other
 * condition Actions on the node).
 */
export class NodeActionEmitRouteEventWhen extends NodeActionStubBase {
  readonly type = "NodeActionEmitRouteEventWhen";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const label = this.type;
    const outcome = evaluateBlackboardCondition(this.params, args, label);
    if (outcome.kind === "halt") {
      return { status: "halt", errorMessage: outcome.message };
    }
    if (outcome.kind === "indeterminate") {
      if (this.params.strict === true) {
        return { status: "halt", errorMessage: outcome.message };
      }
      return { status: "continue" };
    }
    if (outcome.kind === "notMet") {
      return { status: "continue" };
    }

    const event = this.params.event;
    if (typeof event !== "string" || !event.trim()) {
      return {
        status: "halt",
        errorMessage: `${label}: event is required (non-empty string)`,
      };
    }
    return {
      status: "continue",
      nodeContextPatch: {
        routeEvent: event,
        routeEventSource: "blackboard",
      },
    };
  }
}
