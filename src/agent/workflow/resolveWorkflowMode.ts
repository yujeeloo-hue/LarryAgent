import type { ComposerRunMode } from "../ipcTypes.js";
import type { OrchestratorMode } from "../roles/types.js";
import type { RunAgentTurnInput } from "../types.js";

export function workflowModeFromComposerRunMode(
  runMode: ComposerRunMode | undefined,
): Exclude<OrchestratorMode, "subagent"> {
  if (runMode === "ask") return "ask";
  if (runMode === "plan") return "plan_execute";
  return "react";
}

export function resolveWorkflowMode(
  input: RunAgentTurnInput,
): OrchestratorMode {
  if (input.isSubagentTurn === true) {
    return "subagent";
  }
  return workflowModeFromComposerRunMode(input.runMode);
}
