
import type { TurnHost } from "../turnHost/types.js";
import type { OrchestratorMode } from "../roles/types.js";
import type { RunAgentTurnInput, RunAgentTurnResult } from "../types.js";

export type WorkflowRunResult = RunAgentTurnResult;

export interface TurnWorkflow {
  readonly mode: OrchestratorMode;
  run(host: TurnHost, input: RunAgentTurnInput): Promise<WorkflowRunResult>;
}
