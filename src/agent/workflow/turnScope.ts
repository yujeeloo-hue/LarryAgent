import { streamChatCompletion } from "../../llm/openaiCompatibleClient.js";
import { PlanFacade } from "../roles/PlanFacade.js";
import { createUniformRoleLlmBundle } from "../roles/llmBinding.js";
import { createTurnState } from "../roles/types.js";
import type { TurnScope } from "../fsm/turnScope.js";
import type { RunAgentTurnInput } from "../types.js";

export type { TurnScope };

/** Assemble plan/role/LLM scope for this turn (workflow layer, not Host). */
export function createTurnScope(input: RunAgentTurnInput): TurnScope {
  const stream = input.streamChat ?? streamChatCompletion;
  return {
    plan: new PlanFacade(input.session, input.onEvent),
    turnState: createTurnState({
      activeRole: input.isSubagentTurn ? "subagent" : "agent",
    }),
    llmBundle:
      input.llmBundle ??
      createUniformRoleLlmBundle({
        providerId: input.session.providerId || "default",
        client: input.client,
        stream,
      }),
  };
}
