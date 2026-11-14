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
import { validateBlackboardKey } from "../blackboardKeys.js";
import {
  COMPARE_SOURCES,
  evaluateCondition,
  isNonBlackboardSource,
  isNumericMetricSource,
} from "./blackboardCondition.js";
import { NodeActionStubBase } from "./NodeActionStubBase.js";

/** Pure semantic checks for normalized Action params. */
export function validateNodeActionCompareParams(
  params: Readonly<Record<string, unknown>>,
  label: string,
): void {
  const source = params.source;
  if (isNonBlackboardSource(source)) {
    const asKeyError = validateBlackboardKey(params.asKey, label);
    if (asKeyError) {
      throw new FSMConfigError("INVALID_ACTION_PARAMS", asKeyError);
    }
    if (isNumericMetricSource(source)) {
      const valueType =
        params.type === "int" || params.type === "float"
          ? params.type
          : "int";
      const expected = coerceTypedExpected(
        valueType,
        params.value,
        `${label} params.value`,
      );
      if (!expected.ok) {
        throw new FSMConfigError("INVALID_ACTION_PARAMS", expected.error);
      }
    }
    return;
  }
  const keyError = validateBlackboardKey(params.key, label);
  if (keyError) {
    throw new FSMConfigError("INVALID_ACTION_PARAMS", keyError);
  }
  const asKeyError = validateBlackboardKey(params.asKey, label);
  if (asKeyError) {
    throw new FSMConfigError("INVALID_ACTION_PARAMS", asKeyError);
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

export const NodeActionCompareSchema: FsmParamsSchema = {
  type: "object",
  title: "Compare",
  description:
    "Evaluate a typed condition and write true/false to a turn register (asKey). Does not route — pair with RouteTo when[] expr rows that read those flags.",
  "x-llmDescription": "Condition primitive: evaluate source (blackboard key, planOpenSteps, planPresent, planDocPresent, planDocApproved, autoSkillSummarize, fullPermissions, modelIterations, turnModelIterations, toolFailureCount, toolErrorCount, toolRecoveryCount, skillsReadCount, demoConfirm) with operator / type / value and write true/false to turnContext[asKey] (required). Never routes itself — pair with RouteTo when[].expr rows.",
  details: `Compare is the condition ALU for graph routing. It never sets routeTarget itself.

Workflow: mount one or more Compare actions, then a RouteTo with when[] rows whose expr references the asKey flags. Each Compare writes turnContext[asKey] = true when the condition is met, false otherwise (indeterminate → false unless strict=true → halt).

Sources (param source):
- blackboard — read key from turnContext (scope=turn) or session blackboard (scope=session). Workflow phase uses session key "phase".
- planOpenSteps / planPresent / planDocPresent / planDocApproved — read Session.plan / planDoc; approval means the current revision matches approvedRevision. Compare as "true"/"false" (value defaults to "true").
- autoSkillSummarize — composer Self-learning switch on this turn.
- fullPermissions — Bypass permissions gate (fullPermissionsEnabled).
- Int host counters (type int, operators like >): modelIterations (budget; reset by plan step progress / ask_user answers), turnModelIterations (whole turn, never reset), toolFailureCount (any non-zero returnCode), toolErrorCount (returnCode 1 / 4 / 5), toolRecoveryCount (error later followed by a success of the same tool), skillsReadCount (distinct SKILL.md reads).
- demoConfirm — this turn's user input is a demo confirm marker message ("Demo confirmed [demo:<toolCallId>]:"). Compare as "true"/"false" (value defaults to true); absent turn input (stub / editor preview) is false.

Example (skill reflect flags, then RouteTo routes on them):
  Compare { source: "turnModelIterations", type: "int", operator: ">", value: 8, asKey: "reflect.enoughIters" }
  Compare { source: "toolRecoveryCount", type: "int", operator: ">=", value: 1, asKey: "reflect.recovered" }
  RouteTo { when: [{ expr: "reflect.enoughIters && reflect.recovered", to: "skill_reflector" }], defaultPin: "end" }

asKey must be a valid turn register name (letters/digits/._-; reserved FSM keys rejected). Use distinct names per condition.`,
  additionalProperties: false,
  required: ["asKey"],
  properties: {
    source: {
      type: "string",
      enum: [...COMPARE_SOURCES],
      default: "blackboard",
      title: "Source",
      description:
        "blackboard = turn/session register; plan* / planDoc* = Session fields.",
      "x-ui": "select",
      "x-enumLabels": {
        blackboard: "Blackboard",
        planOpenSteps: "Plan · has open steps",
        planPresent: "Plan · active present",
        planDocPresent: "Plan doc · present",
        planDocApproved: "Plan doc · current revision approved",
        autoSkillSummarize: "Self-learning enabled",
        fullPermissions: "Full permissions",
        modelIterations: "Model iterations (budget)",
        turnModelIterations: "Model iterations (whole turn)",
        toolFailureCount: "Tool failure count",
        toolErrorCount: "Tool error count",
        toolRecoveryCount: "Tool recovery count",
        skillsReadCount: "Skills read",
        demoConfirm: "Demo confirmed message",
      },
    },
    key: {
      type: "string",
      minLength: 1,
      title: "Key",
      description: "Blackboard key when source is blackboard.",
      "x-ui": "text",
      "x-showWhen": { source: "blackboard" },
    },
    scope: {
      type: "string",
      enum: ["turn", "session"],
      default: "turn",
      title: "Scope",
      description: "Only for blackboard source.",
      "x-ui": "select",
      "x-enumLabels": { turn: "Turn", session: "Session (persisted)" },
      "x-showWhen": { source: "blackboard" },
    },
    type: {
      type: "string",
      enum: [...FSM_VALUE_TYPES],
      default: "string",
      title: "Type",
      description: "Typed compare for blackboard values (plan* sources are bool→string).",
      "x-ui": "select",
      "x-enumLabels": { int: "Int", float: "Float", string: "String" },
      "x-showWhen": { source: "blackboard" },
    },
    operator: {
      type: "string",
      enum: [...FSM_COMPARE_OPERATORS],
      default: "==",
      title: "Operator",
      "x-ui": "select",
    },
    value: {
      title: "Value",
      description:
        'Expected value. For plan* sources use true/"true" (default true).',
    },
    asKey: {
      type: "string",
      minLength: 1,
      title: "Write as key",
      description:
        "Turn register name receiving true/false. RouteTo when[].expr references this flag.",
      "x-ui": "text",
    },
    strict: {
      type: "boolean",
      default: false,
      title: "Strict",
      description:
        "Halt when the value is missing or mistyped; otherwise write false.",
      "x-ui": "toggle",
    },
  },
};

/**
 * Condition → turnContext boolean register. Topology-blind; does not route.
 */
export class NodeActionCompare extends NodeActionStubBase {
  readonly type = "NodeActionCompare";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const label = this.type;
    const asKeyError = validateBlackboardKey(this.params.asKey, label);
    if (asKeyError) {
      return { status: "halt", errorMessage: asKeyError };
    }
    const asKey = this.params.asKey as string;

    const outcome = evaluateCondition(this.params, args, label);
    if (outcome.kind === "halt") {
      return { status: "halt", errorMessage: outcome.message };
    }
    if (outcome.kind === "indeterminate") {
      if (this.params.strict === true) {
        return { status: "halt", errorMessage: outcome.message };
      }
      return {
        status: "continue",
        turnContextPatch: { [asKey]: false },
      };
    }
    return {
      status: "continue",
      turnContextPatch: { [asKey]: outcome.kind === "met" },
    };
  }
}
