
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

export const BLACKBOARD_KEY_PATTERN = /^[A-Za-z_][\w.-]*$/;

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
