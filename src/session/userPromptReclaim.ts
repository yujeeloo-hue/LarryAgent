/**
 * Click-to-reclaim the running turn's user prompt card. Shared by main
 * (STOP-rollback transcript surgery) and the renderer (whether the prompt
 * card shows the stop-and-reclaim affordance). Pure functions only — no
 * DOM, no IPC.
 */
import { isSteerContinuation } from "../agent/turnContinuations.js";
import { parseDemoConfirmToolCallId } from "./demoConfirm.js";
import type { Message } from "./types.js";
import { isWireOverlayTranscriptMessage } from "./wireOverlay.js";

/**
 * Structural input: accepts both main's `Message[]` and the renderer's loose
 * session-message snapshots (`SessionMessage[]`).
 */
type PromptReclaimMessageLike = {
  id?: string;
  role: string;
  parts: Array<Record<string, unknown>>;
};

/**
 * Assistant placeholder check: a message the user never saw content from —
 * no parts, only whitespace text parts, and/or reasoning parts (thinking
 * is internal, never visible output, so it stays rollback-eligible) and/or
 * `model_response` parts (Responses-native state echo — bookkeeping like
 * reasoning, never visible output; without this every Responses-protocol
 * turn blocks the rollback from the moment the round submits, since the
 * first response_state event pushes the part before any content streams).
 * Any non-empty text part, tool call, hosted tool, or other part type
 * counts as content and blocks the rollback.
 */
export function isContentFreeAssistant(
  message: PromptReclaimMessageLike,
): boolean {
  if (message.role !== "assistant") return false;
  for (const part of message.parts) {
    if (part.type === "reasoning") continue;
    if (part.type === "model_response") continue;
    if (part.type === "text") {
      if (typeof part.text === "string" && part.text.trim().length > 0) {
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Demo confirm messages (D7 marker text, src/session/demoConfirm.ts) are
 * structured tool-card confirmations, not free-form prompts — neither the
 * click-to-reclaim affordance nor the STOP-rollback restore applies to
 * them. Shared by the renderer predicate and main's shape-A rollback.
 */
export function isDemoConfirmMessage(
  message: PromptReclaimMessageLike,
): boolean {
  return message.parts.some(
    (part) =>
      part.type === "text" &&
      typeof part.text === "string" &&
      parseDemoConfirmToolCallId(part.text) !== null,
  );
}

/**
 * Renderer companion: message id whose prompt card shows the reclaim
 * affordance. Only while the turn runs AND the turn is still
 * rollback-eligible — the latest user message (wire overlay excluded; steer
 * continuations excluded: a mid-turn steer makes the turn non-rollbackable)
 * with nothing but content-free assistant placeholders after it. Once
 * visible model content lands the card is read-only again, so the
 * affordance never promises a restore the STOP path cannot deliver.
 * Attachment-only prompts are reclaimable (attachments restore too).
 *
 * Mirrors shape A of `rollbackCancelledTurnPrompt` (main) from the latest
 * user message backwards; `isContentFreeAssistant` is the shared predicate.
 */
export function reclaimableUserMessageId<T extends PromptReclaimMessageLike>(
  messages: T[],
  sessionStatus: string,
): string | null {
  if (sessionStatus !== "running") return null;
  // The trailing wire-only role overlay is transparent (it is not from the
  // user and never renders).
  const transcript = messages.filter(
    (message) => !isWireOverlayTranscriptMessage(message),
  );
  let targetIndex = -1;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const message = transcript[i]!;
    if (message.role !== "user") continue;
    targetIndex = i;
    break;
  }
  if (targetIndex < 0) return null;
  const target = transcript[targetIndex]!;
  // Mid-turn steer consumed into the transcript: the turn is no longer a
  // single clean prompt — STOP keeps the transcript, no restore.
  if (isSteerContinuation(target as unknown as Message)) return null;
  // Demo confirm (D7 marker): a structured card confirmation, not a prompt
  // — never click-to-reclaim (user-confirmed 2026-10-24).
  if (isDemoConfirmMessage(target)) return null;
  if (typeof target.id !== "string") return null;
  for (let i = targetIndex + 1; i < transcript.length; i++) {
    if (!isContentFreeAssistant(transcript[i]!)) return null;
  }
  return target.id;
}
