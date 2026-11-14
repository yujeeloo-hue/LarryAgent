import { resolveLlmApiProtocol, type LlmApiEndpointConfig } from "./apiProtocol.js";
import type { LlmApiAdapter } from "./canonicalTypes.js";
import { chatCompletionsAdapter } from "./adapters/chatCompletions/adapter.js";
import { responsesAdapter } from "./adapters/responses/adapter.js";

/** Middle dispatch: the only place that selects an API adapter. */
export function dispatchLlmApi(config: LlmApiEndpointConfig): LlmApiAdapter {
  return resolveLlmApiProtocol(config) === "responses"
    ? responsesAdapter
    : chatCompletionsAdapter;
}
