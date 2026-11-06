/**
 * STOP-before-content rollback.
 *
 * When the user cancels a turn before any visible model content landed
 * (no non-whitespace text and no tool call — thinking alone does not
 * count), the transcript holds nothing of value for that turn: the prompt
 * user message plus content-free assistant placeholders (the empty
 * assistant message is pushed before the first stream delta; a
 * thinking-only stop leaves a reasoning part on it). This helper removes
 * those messages so the prompt can go back to the composer for a second
 * edit.
 *
 * Pure transcript surgery — no IPC, no broadcast; the caller persists and
 * notifies. File-existence is injectable for tests.
 */
import { existsSync } from "node:fs";
import type { AttachmentDraft } from "../agent/ipcTypes.js";
import { isRetryContinuation, isSteerContinuation } from "../agent/turnContinuations.js";
import {
  isContentFreeAssistant,
  isDemoConfirmMessage,
} from "../session/userPromptReclaim.js";
import type { Message, Session, UserMessage } from "../session/types.js";

// isContentFreeAssistant lives in session/userPromptReclaim.ts (shared with
// the renderer's reclaim-affordance predicate — single source).

/** What goes back into the composer (and the in-memory restore latch). */
export type PromptRestorePayload = {
  text: string;
  attachments: AttachmentDraft[];
};

function basenameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function userPromptText(message: UserMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

function attachmentsFrom(
  message: UserMessage,
  fileExists: (path: string) => boolean,
): AttachmentDraft[] {
  const drafts: AttachmentDraft[] = [];
  for (const part of message.parts) {
    if (part.type !== "attachment") continue;
    const uri = part.uri.trim();
    // Staged files may already be gone — a dead path would only fail on
    // re-send, so drop it instead of handing back a broken chip.
    if (!uri || !fileExists(uri)) continue;
    drafts.push({
      path: uri,
      name: part.name?.trim() || basenameOf(uri),
      kind: part.kind,
      mimeType: part.mimeType,
      ...(typeof part.sizeBytes === "number"
        ? { sizeBytes: part.sizeBytes }
        : {}),
    });
  }
  return drafts;
}

/**
 * Roll back a user-cancelled turn's prompt. Two shapes:
 *
 * A. The prompt landed (`messages[turnStartIndex]` is the turn's user
 *    message) and every message after it is a content-free assistant
 *    placeholder → truncate from `turnStartIndex`, payload from the
 *    message's parts.
 * B. The prompt never reached the transcript (stop during pre-model work,
 *    e.g. image upload); only error-path system notes may sit in the slice
 *    → truncate them, payload from the caller's original request.
 *
 * Anything else (partial text, tool calls, a steer message, orphan-call
 * seals before the prompt) returns null — no rollback.
 */
export function rollbackCancelledTurnPrompt(input: {
  session: Session;
  turnStartIndex: number;
  /** `abort.signal.aborted` — user STOP, not error/pause. */
  aborted: boolean;
  /** Original send request (pre-hook text + local drafts) for shape B. */
  fallback?: { text: string; attachments: AttachmentDraft[] } | null;
  fileExists?: (path: string) => boolean;
}): PromptRestorePayload | null {
  const { session, turnStartIndex, aborted } = input;
  if (!aborted) return null;
  if (!Number.isInteger(turnStartIndex) || turnStartIndex < 0) return null;
  const messages = session.messages;
  if (turnStartIndex > messages.length) return null;
  const fileExists = input.fileExists ?? ((path: string) => existsSync(path));

  const first = messages[turnStartIndex];

  // Shape A — the turn's prompt is the first message of the turn slice.
  // Demo confirm turns (D7 marker) are excluded: STOP keeps the confirm in
  // the transcript (steer-like semantics), no raw-marker composer restore.
  // Retry continuations likewise: their prompt is a hidden synthetic
  // instruction — restoring it would expose it in the composer, so the
  // message stays in the transcript instead.
  if (
    first &&
    first.role === "user" &&
    !isSteerContinuation(first) &&
    !isRetryContinuation(first) &&
    !isDemoConfirmMessage(first)
  ) {
    for (let i = turnStartIndex + 1; i < messages.length; i++) {
      if (!isContentFreeAssistant(messages[i]!)) return null;
    }
    const payload: PromptRestorePayload = {
      text: userPromptText(first),
      attachments: attachmentsFrom(first, fileExists),
    };
    // In-place truncation keeps the array identity (callers may hold refs).
    messages.splice(turnStartIndex, messages.length - turnStartIndex);
    return payload;
  }

  // Shape B — nothing but error-path system notes (if anything) landed.
  for (let i = turnStartIndex; i < messages.length; i++) {
    if (messages[i]!.role !== "system") return null;
  }
  if (!input.fallback) return null;
  const text = input.fallback.text.trim();
  const attachments = input.fallback.attachments.filter((draft) =>
    fileExists(draft.path),
  );
  // Nothing restorable (e.g. a suppressUserMessage continuation turn —
  // /resume, handoff chains — stopped before content): no event, and the
  // error note stays as the abort's transcript footprint.
  if (text.length === 0 && attachments.length === 0) return null;
  messages.splice(turnStartIndex, messages.length - turnStartIndex);
  return { text, attachments };
}
