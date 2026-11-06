import type { OpenAiChatMessage } from "../../llm/types.js";
import { wrapWireOverlayBody } from "../../session/wireOverlay.js";

/** Join non-empty overlay parts into one trailing body. */
export function joinOverlayParts(
  ...parts: Array<string | undefined | null>
): string {
  return parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/**
 * Ephemeral live phase overlay as a trailing **user** message (wire-only).
 * Plan-role markdown is a Bucket0 system message, not this tail. User role
 * (not system) so Deepseek / TokenHUB cannot hoist changing live fields
 * into the prefix. Not written to Session.
 */
export function phaseOverlayMessages(
  overlay: string | undefined | null,
): OpenAiChatMessage[] {
  const text = typeof overlay === "string" ? overlay.trim() : "";
  if (!text) return [];
  return [{ role: "user", content: wrapWireOverlayBody(text) }];
}

/**
 * Stable system prefix + conversation + mutable overlay at the **end**
 * (cache-friendly: overlay is a user tail, not a hoisted system message).
 */
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

/**
 * Wire-only placeholder user message. GLM / Zhipu (and TokenHUB-class
 * gateways) reject a request whose window holds no `user` role at all —
 * e.g. CoCo's first visit greeting runs with suppressUserMessage on a fresh
 * session, so the assembled window is system-only. The placeholder keeps
 * the wire valid without persisting or displaying a fabricated user turn.
 */
export const NO_USER_WINDOW_PLACEHOLDER =
  "[Automatic placeholder, not from the user: this window has no user message yet — proceed per the system instructions.]";

/**
 * Insert the placeholder only when the window would otherwise have no user.
 * It goes right after the system prefix: a hard-truncated suffix can start
 * with assistant/tool rounds, and some gateways require the first non-system
 * message to be `user`.
 */
export function ensureWireUserMessage(
  messages: OpenAiChatMessage[],
): OpenAiChatMessage[] {
  if (messages.some((message) => message.role === "user")) return messages;
  const at = messages.findIndex((message) => message.role !== "system");
  const index = at === -1 ? messages.length : at;
  return [
    ...messages.slice(0, index),
    { role: "user", content: NO_USER_WINDOW_PLACEHOLDER },
    ...messages.slice(index),
  ];
}

/**
 * If `messages` already ends with this overlay, peel it so callers can append
 * other trailing content (e.g. side-path instruction) then re-attach overlay last.
 */
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
