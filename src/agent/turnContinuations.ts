import {
  RETRY_CONTINUATION_PART_ID,
  STEER_CONTINUATION_PART_ID,
  type Message,
  type MessagePart,
} from "../session/types.js";

export function markPartsAsSteerContinuation(parts: MessagePart[]): void {
  const text = parts.find((part) => part.type === "text");
  if (text) {
    text.id = STEER_CONTINUATION_PART_ID;
    return;
  }
  parts.unshift({
    type: "text",
    text: "",
    id: STEER_CONTINUATION_PART_ID,
  });
}

export function isSteerContinuation(message: Message): boolean {
  return (
    message.role === "user" &&
    message.parts.some(
      (part) =>
        part.type === "text" && part.id === STEER_CONTINUATION_PART_ID,
    )
  );
}

/**
 * The prompt an error card's Retry click submits. It replaces the old
 * "resend the failed turn's prompt" behavior: the original prompt (and any
 * partial work) is still in the transcript, so the model just needs a nudge
 * to pick the task back up instead of redoing it from scratch.
 */
export const RETRY_CONTINUATION_PROMPT =
  "The previous turn was interrupted by an error before the task finished. " +
  "Continue the task from where it stopped: verify the current state first, " +
  "do not repeat work that already succeeded, and proceed until the task is complete.";

/** Stamp a turn's user message as a UI-hidden retry continuation. */
export function markPartsAsRetryContinuation(parts: MessagePart[]): void {
  const text = parts.find((part) => part.type === "text");
  if (text) {
    text.id = RETRY_CONTINUATION_PART_ID;
    return;
  }
  parts.unshift({
    type: "text",
    text: "",
    id: RETRY_CONTINUATION_PART_ID,
  });
}

/** User message carrying the retry-continuation marker (model-facing, UI-hidden). */
export function isRetryContinuation(message: Message): boolean {
  return (
    message.role === "user" &&
    message.parts.some(
      (part) =>
        part.type === "text" && part.id === RETRY_CONTINUATION_PART_ID,
    )
  );
}
