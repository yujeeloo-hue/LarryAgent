import type { JsonObject } from "../../../session/types.js";
import { reasoningDisableExtraBody } from "../../reasoningDisable.js";
import { reasoningEffortExtraBody } from "../../reasoningEffort.js";
import type { LlmApiAdapter } from "../../canonicalTypes.js";
import type { OpenAiCompatibleClientConfig } from "../../types.js";
import { messagesForBinding } from "../messagesForBinding.js";
import { chatCompletionOnce, streamChatCompletion } from "./http.js";

function requestExtraBody(
  client: OpenAiCompatibleClientConfig,
  extra?: JsonObject,
): JsonObject | undefined {
  const merged: JsonObject = {
    ...(client.reasoningEffort
      ? reasoningEffortExtraBody(client.baseUrl, client.reasoningEffort)
      : {}),
    ...(client.disableReasoning
      ? reasoningDisableExtraBody(client.baseUrl)
      : {}),
    ...(extra ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Chat Completions API adapter. */
export const chatCompletionsAdapter: LlmApiAdapter = {
  id: "chat_completions",
  hostedTools() {
    return [];
  },
  messagesForBinding,
  requestExtraBody,
  stream(config, options) {
    return streamChatCompletion(config, options);
  },
  complete(config, options) {
    return chatCompletionOnce(config, options);
  },
  prepareServerContext() {
    return undefined;
  },
  matchesReplayScope() {
    return false;
  },
};
