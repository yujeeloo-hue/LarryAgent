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

/** Refuse absurdly large uploads (same order as read_image caps). */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function isVisionImageDraft(draft: AttachmentDraft): boolean {
  return (
    draft.kind === "image" &&
    isVisionImageRef(draft.path, draft.mimeType)
  );
}

export type UploadImageAttachmentsResult = {
  /** Drafts with `s3` filled in on successful uploads (order preserved). */
  attachments: AttachmentDraft[];
  /** Number of images uploaded successfully this turn. */
  uploaded: number;
  /** Number of image uploads that failed (each degrades to the stub path). */
  failed: number;
};

/**
 * Upload image attachments to S3/COS before a multimodal turn starts.
 * Non-image attachments and SVG (XML markup, not a vision format) pass
 * through untouched. Failures degrade per-file:
 * the draft keeps no `s3` field and the wire falls back to the read_image
 * path stub — sending is never blocked.
 */
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

/**
 * Re-exported for existing callers. The pure predicates live in
 * settings/types so unit tests never pull the Electron-dependent
 * upload/embed path.
 */
export {
  chatProviderAcceptsImageUrls,
  chatProviderUsesBase64Images,
  chatProviderUsesProviderFiles,
} from "../settings/types.js";

export type EmbedImageAttachmentsResult = {
  /** Drafts with `s3.url` filled with a data URI on success (order preserved). */
  attachments: AttachmentDraft[];
  /** Number of images embedded successfully this turn. */
  embedded: number;
  /** Number of embeds that failed (each degrades to the stub path). */
  failed: number;
};

/**
 * Inline image attachments as base64 data URIs for multimodal providers
 * that cannot fetch external image URLs. Images are downscaled to fit
 * inside 800×600 first (aspect kept) to keep the wire payload small.
 * SVG is skipped (XML markup, not a vision payload). Failures degrade
 * per-file to the read_image stub path — sending is never blocked.
 */
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
