import type { OpenAiChatMessage } from "../../llm/types.js";
import { wrapWireOverlayBody } from "../../session/wireOverlay.js";
import { categorizeContextMessage } from "../contextMessageCategory.js";

export function joinOverlayParts(
  ...parts: Array<string | undefined | null>
): string {
  return parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export function phaseOverlayMessages(
  overlay: string | undefined | null,
): OpenAiChatMessage[] {
  const text = typeof overlay === "string" ? overlay.trim() : "";
  if (!text) return [];
  return [categorizeContextMessage({ role: "user", content: wrapWireOverlayBody(text) }, "turnInjections")];
}

export function assembleModelFacingMessages(input: {
  systemPrefix: OpenAiChatMessage[];
  conversation: OpenAiChatMessage[];
  phaseOverlay?: string | null;
}): OpenAiChatMessage[] {
  return ensureWireUserMessage([
    ...input.systemPrefix,
    ...input.conversation,
    ...phaseOverlayMessages(input.phaseOverlay),
  ]);
}

export const NO_USER_WINDOW_PLACEHOLDER =
  "[Automatic placeholder, not from the user: this window has no user message yet — proceed per the system instructions.]";

export function ensureWireUserMessage(
  messages: OpenAiChatMessage[],
): OpenAiChatMessage[] {
  if (messages.some((message) => message.role === "user")) return messages;
  const at = messages.findIndex((message) => message.role !== "system");
  const index = at === -1 ? messages.length : at;
  return [
    ...messages.slice(0, index),
    categorizeContextMessage({ role: "user", content: NO_USER_WINDOW_PLACEHOLDER }, "turnInjections"),
    ...messages.slice(index),
  ];
}

export function peelTrailingPhaseOverlay(
  messages: OpenAiChatMessage[],
  overlay: string | undefined | null,
): { stem: OpenAiChatMessage[]; tail: OpenAiChatMessage[] } {
  const tail = phaseOverlayMessages(overlay);
  if (tail.length === 0) {
    return { stem: messages, tail: [] };
  }
  const expected = tail[0]!.content;
  const last = messages[messages.length - 1];
  if (
    last &&
    last.role === "user" &&
    typeof last.content === "string" &&
    last.content === expected
  ) {
    return { stem: messages.slice(0, -1), tail };
  }
  return { stem: messages, tail };
}
