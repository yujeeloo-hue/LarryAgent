import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AttachmentDraft } from "../agent/ipcTypes.js";
import { agentLogWarn } from "../logging/agentLog.js";
import { isVisionImageRef } from "../tools/fileMeta.js";

/** Same order as the S3 upload cap. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export type UploadImageAttachmentsToProviderFilesOptions = {
  /** Provider base URL (e.g. https://api.moonshot.cn/v1). */
  baseUrl: string;
  apiKey: string;
  attachments: AttachmentDraft[];
  /** Files-API purpose field (Moonshot: "image"). */
  purpose?: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  logTag?: string;
};

export type UploadImageAttachmentsToProviderFilesResult = {
  /** Drafts with `s3.url` = `ms://<file-id>` on success (order preserved). */
  attachments: AttachmentDraft[];
  uploaded: number;
  failed: number;
};

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

type FileCreateResponse = {
  id?: string;
  object?: string;
  error?: { message?: string };
};

/**
 * Upload image attachments to the chat provider's own files API
 * (Moonshot/Kimi `POST {baseUrl}/files` with purpose="image") and reference
 * the returned file id on the wire as `ms://<file-id>` — the protocol Kimi
 * vision models accept in `image_url.url` instead of external https URLs.
 *
 * Failures degrade per-file to the read_image stub path — sending is never
 * blocked. SVG drafts are skipped (XML markup, not a vision payload).
 * rawEndpoint providers cannot derive a files URL; all raster images
 * degrade with a warning.
 */
export async function uploadImageAttachmentsToProviderFiles(
  options: UploadImageAttachmentsToProviderFilesOptions,
): Promise<UploadImageAttachmentsToProviderFilesResult> {
  const {
    baseUrl,
    apiKey,
    attachments,
    purpose = "image",
    fetchFn = fetch,
    logTag = "llm.files",
  } = options;
  const images = attachments.filter(
    (a) => a.kind === "image" && !a.s3 && isVisionImageRef(a.path, a.mimeType),
  );
  if (!baseUrl.trim() || images.length === 0) {
    return { attachments, uploaded: 0, failed: 0 };
  }

  const filesUrl = joinUrl(baseUrl.trim(), "files");
  let uploaded = 0;
  let failed = 0;
  for (const draft of attachments) {
    if (
      draft.kind !== "image" ||
      draft.s3 ||
      !isVisionImageRef(draft.path, draft.mimeType)
    ) {
      continue;
    }
    try {
      const bytes = await readFile(draft.path);
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        throw new Error(
          `Image too large (${bytes.byteLength} bytes; max ${MAX_UPLOAD_BYTES})`,
        );
      }
      const form = new FormData();
      form.append("purpose", purpose);
      form.append(
        "file",
        new Blob([bytes], { type: draft.mimeType || "image/png" }),
        basename(draft.path),
      );
      const response = await fetchFn(filesUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      const body = (await response.json().catch(() => null)) as
        | FileCreateResponse
        | null;
      if (!response.ok || !body?.id) {
        throw new Error(
          `files API ${response.status}: ${body?.error?.message ?? "no file id returned"}`,
        );
      }
      draft.s3 = { url: `ms://${body.id}`, key: body.id };
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
