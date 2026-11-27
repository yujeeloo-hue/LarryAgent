import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { AttachmentDraft } from "../agent/ipcTypes.js";
import { readApiKeyFromStore } from "../llm/credentials.js";
import { agentLogInfo, agentLogWarn } from "../logging/agentLog.js";
import { resizeImageForBase64 } from "./imageResize.js";
import { isVisionImageRef } from "../tools/fileMeta.js";
import {
  OBJECT_STORAGE_CREDENTIAL_ID,
  resolveActiveObjectStorage,
  type WorkspaceSettings,
} from "../settings/types.js";
import { buildObjectKey, putObject } from "./s3Client.js";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function isVisionImageDraft(draft: AttachmentDraft): boolean {
  return (
    draft.kind === "image" &&
    isVisionImageRef(draft.path, draft.mimeType)
  );
}

export type UploadImageAttachmentsResult = {
  attachments: AttachmentDraft[];
  uploaded: number;
  failed: number;
};

export async function uploadImageAttachments(
  settings: WorkspaceSettings | null | undefined,
  attachments: AttachmentDraft[],
  logTag = "s3.upload",
): Promise<UploadImageAttachmentsResult> {
  const config = resolveActiveObjectStorage(settings);
  const images = attachments.filter(
    (a) => isVisionImageDraft(a) && !a.s3,
  );
  if (!config || images.length === 0) {
    return { attachments, uploaded: 0, failed: 0 };
  }

  const secretAccessKey = await readApiKeyFromStore(
    OBJECT_STORAGE_CREDENTIAL_ID,
  ).catch(() => null);
  if (!secretAccessKey) {
    agentLogWarn(`${logTag}.no_secret`, {
      provider: config.provider,
      bucket: config.bucket,
      degraded: images.length,
    });
    return { attachments, uploaded: 0, failed: images.length };
  }

  let uploaded = 0;
  let failed = 0;
  for (const draft of attachments) {
    if (!isVisionImageDraft(draft) || draft.s3) continue;
    try {
      const bytes = await readFile(draft.path);
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        throw new Error(
          `Image too large (${bytes.byteLength} bytes; max ${MAX_UPLOAD_BYTES})`,
        );
      }
      const key = buildObjectKey(config, extname(draft.path));
      const result = await putObject(
        { config, secretAccessKey },
        key,
        bytes,
        draft.mimeType || "image/png",
      );
      draft.s3 = { url: result.url, key: result.key };
      uploaded += 1;
    } catch (err) {
      failed += 1;
      agentLogWarn(`${logTag}.failed`, {
        path: draft.path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { attachments, uploaded, failed };
}

export {
  chatProviderAcceptsImageUrls,
  chatProviderUsesBase64Images,
  chatProviderUsesProviderFiles,
} from "../settings/types.js";

export type EmbedImageAttachmentsResult = {
  attachments: AttachmentDraft[];
  embedded: number;
  failed: number;
};

export async function embedImageAttachmentsBase64(
  attachments: AttachmentDraft[],
  logTag = "img.base64",
): Promise<EmbedImageAttachmentsResult> {
  const images = attachments.filter(
    (a) => isVisionImageDraft(a) && !a.s3,
  );
  if (images.length === 0) {
    return { attachments, embedded: 0, failed: 0 };
  }
  let embedded = 0;
  let failed = 0;
  for (const draft of attachments) {
    if (!isVisionImageDraft(draft) || draft.s3) continue;
    try {
      const raw = await readFile(draft.path);
      if (raw.byteLength > MAX_UPLOAD_BYTES) {
        throw new Error(
          `Image too large (${raw.byteLength} bytes; max ${MAX_UPLOAD_BYTES})`,
        );
      }
      const mime = draft.mimeType || "image/png";
      const resized = await resizeImageForBase64(raw, mime);
      const finalBytes = resized?.bytes ?? raw;
      const finalMime = resized?.mimeType ?? mime;
      draft.s3 = {
        url: `data:${finalMime};base64,${finalBytes.toString("base64")}`,
        key: "",
      };
      embedded += 1;
      if (resized?.resized) {
        agentLogInfo(`${logTag}.resized`, {
          path: draft.path,
          width: resized.width,
          height: resized.height,
          bytes: finalBytes.byteLength,
        });
      }
    } catch (err) {
      failed += 1;
      agentLogWarn(`${logTag}.failed`, {
        path: draft.path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { attachments, embedded, failed };
}
