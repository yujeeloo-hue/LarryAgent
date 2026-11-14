import { dispatchLlmApi } from "../../llm/apiDispatch.js";
import {
  chatCompletionOnce,
  streamChatCompletion,
} from "../../llm/openaiCompatibleClient.js";
import type { OpenAiCompatibleClientConfig } from "../../llm/types.js";
import type { StreamChatFn } from "../types.js";
import type { RoleLlmBinding, RoleLlmBundle } from "./types.js";

export function createRoleLlmBinding(input: {
  providerId: string;
  client: OpenAiCompatibleClientConfig;
  stream?: StreamChatFn;
}): RoleLlmBinding {
  const baseStream = input.stream ?? streamChatCompletion;
  const client = input.client;
  const adapter = dispatchLlmApi(client);

  const stream: StreamChatFn = async function* (config, options) {
    const extraBody = adapter.requestExtraBody(client, options.extraBody);
    yield* baseStream(config, {
      ...options,
      ...(extraBody ? { extraBody } : {}),
    });
  };

  return {
    providerId: input.providerId,
    model: client.model,
    client,
    hostedTools: () => adapter.hostedTools(client),
    messagesForBinding: (messages, builtScope) =>
      adapter.messagesForBinding(messages, builtScope, client),
    stream,
    complete: async (opts) => {
      // No temperature passthrough: Kimi K-series forbids setting it and a
      // fixed value is meaningless across providers — provider default only.
      const extraBody = adapter.requestExtraBody(client, undefined);
      const result = await chatCompletionOnce(client, {
        messages: opts.messages,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.responseFormat
          ? { responseFormat: opts.responseFormat }
          : {}),
        ...(extraBody ? { extraBody } : {}),
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        meta: { purpose: opts.purpose as "chat" },
      });
      return result.content;
    },
  };
}

/** All roles share the same session chat binding. */
export function createUniformRoleLlmBundle(input: {
  providerId: string;
  client: OpenAiCompatibleClientConfig;
  stream?: StreamChatFn;
}): RoleLlmBundle {
  const binding = createRoleLlmBinding(input);
  return {
    sessionDefault: binding,
    agent: binding,
    planner: binding,
    planWriter: binding,
    executor: binding,
    replanner: binding,
    subagent: binding,
    byProviderId: { [binding.providerId]: binding },
  };
}
