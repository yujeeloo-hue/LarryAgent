/**
 * Blackboard key rules shared by WriteBlackboard / ReadBlackboard / Compare /
 * RouteTo pin gate and validateFSMGraphConfig. Reserved turnContext keys
 * are guarded at BOTH config-validation and Exec time (authoring bugs always
 * produce named halts — never strict-dependent, never silent overwrites).
 */

/** turnContext keys owned by the runtime / built-in Actions — never blackboard-writable. */
export const FORBIDDEN_BLACKBOARD_KEYS: ReadonlySet<string> = new Set([
  "routeTarget",
  "routeEvent",
  "routeEventSource",
  "haltResult",
  "finishedStatus",
  "modelIterations",
  "turnStartMessageIndex",
  "stepClaimed",
  "toolCalls",
  "toolEffects",
  "toolsRan",
]);

/** Author-facing key shape: identifier head, then word/dot/dash segments. */
export const BLACKBOARD_KEY_PATTERN = /^[A-Za-z_][\w.-]*$/;

/** Returns a named error message, or null when the key is usable. */
export function validateBlackboardKey(
  key: unknown,
  label: string,
): string | null {
  if (typeof key !== "string" || key.length === 0) {
    return `${label}: blackboard key is required`;
  }
  if (!BLACKBOARD_KEY_PATTERN.test(key)) {
    return `${label}: blackboard key "${key}" must match ${BLACKBOARD_KEY_PATTERN.source}`;
  }
  if (FORBIDDEN_BLACKBOARD_KEYS.has(key)) {
    return `${label}: blackboard key "${key}" is reserved by the FSM runtime`;
  }
  return null;
}
