import type { PlanFacade } from "../roles/PlanFacade.js";
import type { RoleLlmBundle, TurnState } from "../roles/types.js";

export type TurnScope = {
  plan: PlanFacade;
  turnState: TurnState;
  llmBundle: RoleLlmBundle;
};
