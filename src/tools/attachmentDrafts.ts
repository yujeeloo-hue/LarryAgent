/**
 * Attachment draft builder — shared by the desktop file picker / drag-and-drop
 * (src/main/index.ts) and the headless agentd remote-upload path.
 */
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AttachmentDraft } from "../agent/ipcTypes.js";
import { guessAttachmentKind, guessMimeType } from "./fileMeta.js";

/**
 * Validate absolute paths and build attachment drafts. Unreadable / non-file
 * paths are skipped.
 */
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
      // Skip unreadable paths
    }
  }
  return drafts;
}
