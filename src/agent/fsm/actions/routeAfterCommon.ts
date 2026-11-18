
export const ROUTE_TARGET_REFLECT = "skill_reflect_gate";
export const ROUTE_TARGET_STEP_CLAIM = "execution_validator";
export const ROUTE_TARGET_REFLECT_DONE = "end";

export function toolsRanOrInjected(nodeContext: Record<string, unknown>): {
  toolsPath: boolean;
  injected: boolean;
  interrupted: boolean;
} {
  return {
    toolsPath: nodeContext.toolsRan === true,
    injected: nodeContext.subagentInjected === true,
    interrupted: nodeContext.roundInterrupted === true,
  };
}
