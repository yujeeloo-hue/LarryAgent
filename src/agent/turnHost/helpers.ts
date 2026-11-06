import type { AttachmentPart, MessagePart } from "../../session/types.js";
import type { AttachmentDraft } from "../ipcTypes.js";

export function buildUserParts(
  userText: string,
  attachments: AttachmentDraft[] | undefined,
  createId: () => string,
): MessagePart[] {
  const parts: MessagePart[] = [];
  const text = userText.trim();
  if (text) {
    parts.push({ type: "text", text });
  }
  for (const draft of attachments ?? []) {
    const part: AttachmentPart = {
      type: "attachment",
      kind: draft.kind,
      uri: draft.path,
      mimeType: draft.mimeType,
      name: draft.name,
      id: createId(),
    };
    if (typeof draft.sizeBytes === "number") {
      part.sizeBytes = draft.sizeBytes;
    }
    if (draft.s3) {
      part.s3 = { url: draft.s3.url, key: draft.s3.key };
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    parts.push({ type: "text", text: "Please review the attached files." });
  }
  return parts;
}

export function combineToolPredicates(
  ...preds: Array<((name: string) => boolean) | undefined>
): ((name: string) => boolean) | undefined {
  const active = preds.filter(
    (p): p is (name: string) => boolean => typeof p === "function",
  );
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return (name) => active.every((p) => p(name));
}
