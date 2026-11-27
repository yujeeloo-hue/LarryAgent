import { FsmGraphWorkflow } from "../fsm/FsmGraphWorkflow.js";
import type { RunAgentTurnInput } from "../types.js";
import { resolveWorkflowMode } from "./resolveWorkflowMode.js";
import type { TurnWorkflow } from "./types.js";

export function createWorkflow(input: RunAgentTurnInput): TurnWorkflow {
  return new FsmGraphWorkflow({
    mode: resolveWorkflowMode(input),
    ...(input.fsmGraphConfig ? { graphConfig: input.fsmGraphConfig } : {}),
  });
}
