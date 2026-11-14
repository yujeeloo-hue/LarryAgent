import type { PlanFacade } from "../roles/PlanFacade.js";
import type { RoleLlmBundle, TurnState } from "../roles/types.js";

/** Mode/role objects for one FSM run — injected on TurnContext, not Host. */
export type TurnScope = {
  plan: PlanFacade;
  turnState: TurnState;
  llmBundle: RoleLlmBundle;
};
