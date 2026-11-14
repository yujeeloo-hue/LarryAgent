import type { AssistantMessage, Message, MessagePart } from "../../session/types.js";

function hasVisibleText(parts: MessagePart[]): boolean {
  return parts.some((p) => p.type === "text" && p.text.trim().length > 0);
}

/**
 * True when an assistant message after the latest user message (other than
 * `exclude`) already carries visible text — the turn has answered, so a later
 * text-less round (e.g. the skill reflector's closing `fsm_route`) must not be
 * filled from its reasoning.
 */
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

/** How the end node treats the final assistant round when it has no visible text. */
export function decideEmptyAssistant(input: {
  messages: readonly Message[];
  assistant: AssistantMessage;
  reasoningText: string;
}): EmptyAssistantAction {
  const { assistant } = input;
  if (hasVisibleText(assistant.parts)) return "keep";
  if (turnHasVisibleReply(input.messages, assistant)) return "keep";
  if (input.reasoningText.trim()) return "surface_reasoning";
  // Tool results reference this message's tool_call ids.
  if (assistant.parts.some((p) => p.type === "tool_call")) return "keep";
  return "drop";
}
