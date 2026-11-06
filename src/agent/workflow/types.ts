/**
 * TurnWorkflow — replaceable control plane for agent turns.
 *
 * Session / Transcript stay on TurnHost (authoritative). This layer only owns
 * orchestration / routing.
 */

import type { TurnHost } from "../turnHost/types.js";
import type { OrchestratorMode } from "../roles/types.js";
import type { RunAgentTurnInput, RunAgentTurnResult } from "../types.js";

/** Alias kept for workflow-facing docs; same as Host turn result. */
export type WorkflowRunResult = RunAgentTurnResult;

/**
 * Replaceable workflow. Facade picks an implementation via `createWorkflow`.
 */
export interface TurnWorkflow {
  readonly mode: OrchestratorMode;
  /** Owns all control flow for the turn. */
  run(host: TurnHost, input: RunAgentTurnInput): Promise<WorkflowRunResult>;
}
