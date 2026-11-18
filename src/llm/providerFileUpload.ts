import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AttachmentDraft } from "../agent/ipcTypes.js";
import { agentLogWarn } from "../logging/agentLog.js";
import { isVisionImageRef } from "../tools/fileMeta.js";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export type UploadImageAttachmentsToProviderFilesOptions = {
  baseUrl: string;
  apiKey: string;
  attachments: AttachmentDraft[];
  purpose?: string;
  fetchFn?: typeof fetch;
  logTag?: string;
};

export type UploadImageAttachmentsToProviderFilesResult = {
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
