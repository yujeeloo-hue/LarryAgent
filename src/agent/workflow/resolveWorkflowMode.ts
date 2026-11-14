import type { ComposerRunMode } from "../ipcTypes.js";
import type { OrchestratorMode } from "../roles/types.js";
import type { RunAgentTurnInput } from "../types.js";

/**
 * Map composer `runMode` → FSM graph mode in one place.
 * Subagent turns always use `subagent` (ignore parent runMode).
 * Custom graphs supply their own config; mode stays `react` for
 * notify/label fallbacks only.
 */
export function workflowModeFromComposerRunMode(
  runMode: ComposerRunMode | undefined,
): Exclude<OrchestratorMode, "subagent"> {
  if (runMode === "ask") return "ask";
  if (runMode === "plan") return "plan_execute";
  // agent + custom → react label; custom topology comes from fsmGraphConfig
  return "react";
}

/**
 * Resolve turn control mode from input.
 * Prefer explicit `runMode`; subagent turns always use `subagent`.
 */
export function resolveWorkflowMode(
  input: RunAgentTurnInput,
): OrchestratorMode {
  if (input.isSubagentTurn === true) {
    return "subagent";
  }
  return workflowModeFromComposerRunMode(input.runMode);
}
