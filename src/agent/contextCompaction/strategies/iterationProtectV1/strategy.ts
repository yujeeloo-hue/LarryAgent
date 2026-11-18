import type { ContextCompactionStrategy } from "../../types.js";
import { maybeCompactBeforeIteration } from "./compactContext.js";
import { buildModelMessages } from "./messagesToOpenAi.js";
import { refreshSessionCompactionState } from "./refreshState.js";

export const iterationProtectV1Strategy: ContextCompactionStrategy = {
  id: "iterationProtectV1",
  maybeCompactBeforeIteration,
  buildModelMessages,
  refreshSessionCompactionState,
};
