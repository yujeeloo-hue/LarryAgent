import { isSteerContinuation } from "../agent/turnContinuations.js";
import { parseDemoConfirmToolCallId } from "./demoConfirm.js";
import type { Message } from "./types.js";
import { isWireOverlayTranscriptMessage } from "./wireOverlay.js";

type PromptReclaimMessageLike = {
  id?: string;
  role: string;
  parts: Array<Record<string, unknown>>;
};

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

export function reclaimableUserMessageId<T extends PromptReclaimMessageLike>(
  messages: T[],
  sessionStatus: string,
): string | null {
  if (sessionStatus !== "running") return null;
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
  if (isSteerContinuation(target as unknown as Message)) return null;
  if (isDemoConfirmMessage(target)) return null;
  if (typeof target.id !== "string") return null;
  for (let i = targetIndex + 1; i < transcript.length; i++) {
    if (!isContentFreeAssistant(transcript[i]!)) return null;
  }
  return target.id;
}
