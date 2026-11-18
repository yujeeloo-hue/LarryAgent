import { reasoningScopeForClient } from "../contextScope.js";
import type { OpenAiChatMessage, OpenAiCompatibleClientConfig } from "../types.js";

export function messagesForBinding(
  messages: readonly OpenAiChatMessage[],
  builtScope: string | undefined,
  client: OpenAiCompatibleClientConfig,
): OpenAiChatMessage[] {
  if (builtScope !== undefined && builtScope === reasoningScopeForClient(client)) {
    return messages as OpenAiChatMessage[];
  }
  if (builtScope === undefined) return messages as OpenAiChatMessage[];
  return messages.map((message) => {
    if (message.reasoning_content === undefined && message.responsesOutput === undefined) {
      return message;
    }
    const { reasoning_content: _reasoning, responsesOutput: _responses, ...visible } = message;
    return message.role === "assistant" && message.tool_calls?.length
      ? { ...visible, reasoning_content: "" }
      : visible;
  });
}
