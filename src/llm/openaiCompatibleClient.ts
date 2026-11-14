/**
 * Public chat entry. Protocol selection lives in `apiDispatch`;
 * Chat Completions HTTP lives in `adapters/chatCompletions/http`.
 */
import { dispatchLlmApi } from "./apiDispatch.js";
import type { OpenAiCompatibleClientConfig, StreamChatOptions } from "./types.js";
import type { StreamEvent } from "./streamEvents.js";

export {
  DEFAULT_LLM_COMPACT_TIMEOUT_MS,
  llmEndpointKey,
} from "./adapters/chatCompletions/http.js";
export type {
  LlmCompleteOptions,
  LlmCompleteResult,
} from "./canonicalTypes.js";

export async function* streamChatCompletion(
  config: OpenAiCompatibleClientConfig,
  options: StreamChatOptions,
): AsyncGenerator<StreamEvent, void, undefined> {
  yield* dispatchLlmApi(config).stream(config, options);
}

export async function chatCompletionOnce(
  config: OpenAiCompatibleClientConfig,
  options: import("./canonicalTypes.js").LlmCompleteOptions,
): Promise<import("./canonicalTypes.js").LlmCompleteResult> {
  return dispatchLlmApi(config).complete(config, options);
}
