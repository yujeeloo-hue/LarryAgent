import type { AssistantMessage, Message, MessagePart } from "../../session/types.js";

function hasVisibleText(parts: MessagePart[]): boolean {
  return parts.some((p) => p.type === "text" && p.text.trim().length > 0);
}

export function turnHasVisibleReply(
  messages: readonly Message[],
  exclude: AssistantMessage,
): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === "user") return false;
    if (message === exclude || message.role !== "assistant") continue;
    if (hasVisibleText(message.parts)) return true;
  }
  return false;
}

export type EmptyAssistantAction = "keep" | "surface_reasoning" | "drop";

export function decideEmptyAssistant(input: {
  messages: readonly Message[];
  assistant: AssistantMessage;
  reasoningText: string;
}): EmptyAssistantAction {
  const { assistant } = input;
  if (hasVisibleText(assistant.parts)) return "keep";
  if (turnHasVisibleReply(input.messages, assistant)) return "keep";
  if (input.reasoningText.trim()) return "surface_reasoning";
  if (assistant.parts.some((p) => p.type === "tool_call")) return "keep";
  return "drop";
}
