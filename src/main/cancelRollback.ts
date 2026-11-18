import { existsSync } from "node:fs";
import type { AttachmentDraft } from "../agent/ipcTypes.js";
import { isRetryContinuation, isSteerContinuation } from "../agent/turnContinuations.js";
import {
  isContentFreeAssistant,
  isDemoConfirmMessage,
} from "../session/userPromptReclaim.js";
import type { Message, Session, UserMessage } from "../session/types.js";


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

export function rollbackCancelledTurnPrompt(input: {
  session: Session;
  turnStartIndex: number;
  aborted: boolean;
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
    messages.splice(turnStartIndex, messages.length - turnStartIndex);
    return payload;
  }

  for (let i = turnStartIndex; i < messages.length; i++) {
    if (messages[i]!.role !== "system") return null;
  }
  if (!input.fallback) return null;
  const text = input.fallback.text.trim();
  const attachments = input.fallback.attachments.filter((draft) =>
    fileExists(draft.path),
  );
  if (text.length === 0 && attachments.length === 0) return null;
  messages.splice(turnStartIndex, messages.length - turnStartIndex);
  return { text, attachments };
}
