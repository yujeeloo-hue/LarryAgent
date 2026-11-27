import type { OpenAiChatMessage } from "../llm/types.js";
import type { ContextUsageCategory } from "../shared/contextUsageBreakdown.js";

// Keep attribution local so it never enters a provider payload or a replay hash.
export const contextMessageCategories = new WeakMap<OpenAiChatMessage, ContextUsageCategory>();

export function categorizeContextMessage(
  message: OpenAiChatMessage,
  category: ContextUsageCategory,
): OpenAiChatMessage {
  contextMessageCategories.set(message, category);
  return message;
}
