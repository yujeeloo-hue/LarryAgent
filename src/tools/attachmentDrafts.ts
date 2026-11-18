import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AttachmentDraft } from "../agent/ipcTypes.js";
import { guessAttachmentKind, guessMimeType } from "./fileMeta.js";

export async function buildAttachmentDrafts(
  filePaths: string[],
): Promise<AttachmentDraft[]> {
  const drafts: AttachmentDraft[] = [];
  for (const filePath of filePaths) {
    try {
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      drafts.push({
        path: filePath,
        name: basename(filePath),
        kind: guessAttachmentKind(filePath),
        mimeType: guessMimeType(filePath),
        sizeBytes: info.size,
      });
    } catch {
    }
  }
  return drafts;
}
