import { FSMConfigError } from "../FSMConfigError.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { validateBlackboardKey } from "../blackboardKeys.js";
import { NodeActionStubBase } from "./NodeActionStubBase.js";

/** Pure semantic checks for normalized Action params. */
export function validateNodeActionReadBlackboardParams(
  params: Readonly<Record<string, unknown>>,
  label: string,
): void {
  const keyError = validateBlackboardKey(params.key, label);
  if (keyError) {
    throw new FSMConfigError("INVALID_ACTION_PARAMS", keyError);
  }
  const asKeyError = validateBlackboardKey(params.asKey ?? params.key, label);
  if (asKeyError) {
    throw new FSMConfigError("INVALID_ACTION_PARAMS", asKeyError);
  }
}

export const NodeActionReadBlackboardSchema: FsmParamsSchema = {
  type: "object",
  title: "Read blackboard",
  description:
    "Materialize a blackboard key into this turn's context for routing conditions and later Actions. To surface the value to the model, mount PromptInject (source=blackboard).",
  "x-llmDescription": "Materialize a blackboard value into turnContext for routing conditions: key (required), scope turn (default) | session, asKey (defaults to key), strict. Data-only — render the value to the model with PromptInject source=blackboard.",
  details: `Blackboard read. Copies the value at key (scope=turn from turnContext, scope=session from the persisted session blackboard) into turnContext under asKey (defaults to key) for routing conditions (EdgeWhen, Route to when) and later Actions. Data-only: the model never sees the value here — use PromptInject (source=blackboard) to render it into the trailing overlay.

Missing value: silently continues (nothing materialized) unless strict=true (then a named halt). A missing session host capability (stub / subagent path) behaves the same way.

Reserved turnContext keys are rejected for both key and asKey at validation and Exec time.`,
  additionalProperties: false,
  required: ["key"],
  properties: {
    key: {
      type: "string",
      minLength: 1,
      title: "Key",
      description: "Blackboard key to read.",
      "x-ui": "text",
    },
    scope: {
      type: "string",
      enum: ["turn", "session"],
      default: "turn",
      title: "Scope",
      description:
        "turn = this turn's context; session = persisted session blackboard.",
      "x-ui": "select",
      "x-enumLabels": { turn: "Turn", session: "Session (persisted)" },
    },
    asKey: {
      type: "string",
      title: "As key",
      description:
        "Turn-context key to materialize the value under (defaults to key).",
      "x-ui": "text",
    },
    strict: {
      type: "boolean",
      default: false,
      title: "Strict",
      description:
        "Halt (named error) when the key is missing or the session host capability is absent; otherwise continue quietly.",
      "x-ui": "toggle",
    },
  },
};

export function formatBlackboardValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Blackboard read / materialize. Data-only Action: copies a value into
 * turnContext under asKey for routing conditions and later Actions.
 * Use PromptInject (source=blackboard) to surface the value to the model.
 */
export class NodeActionReadBlackboard extends NodeActionStubBase {
  readonly type = "NodeActionReadBlackboard";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const label = this.type;
    const keyError = validateBlackboardKey(this.params.key, label);
    if (keyError) {
      return { status: "halt", errorMessage: keyError };
    }
    const asKeyError = validateBlackboardKey(
      this.params.asKey ?? this.params.key,
      label,
    );
    if (asKeyError) {
      return { status: "halt", errorMessage: asKeyError };
    }
    const key = this.params.key as string;
    const asKey =
      typeof this.params.asKey === "string" && this.params.asKey
        ? this.params.asKey
        : key;
    const scope = this.params.scope === "session" ? "session" : "turn";
    const strict = this.params.strict === true;

    if (scope === "session" && !args.host?.blackboardGet) {
      if (strict) {
        return {
          status: "halt",
          errorMessage: `${label}: session blackboard capability is not available on this turn`,
        };
      }
      return { status: "continue" };
    }

    const value =
      scope === "session"
        ? args.host?.blackboardGet?.(key)
        : args.turnContext[key];

    if (value === undefined) {
      if (strict) {
        return {
          status: "halt",
          errorMessage: `${label}: blackboard key "${key}" is not set`,
        };
      }
      return { status: "continue" };
    }

    return {
      status: "continue",
      turnContextPatch: { [asKey]: value },
    };
  }
}
