import { providerApiEndpoint } from "../../apiProtocol.js";
import type { OpenAiCompatibleClientConfig } from "../../types.js";
import { withLlmUserAgent } from "../../userAgent.js";

export const RESPONSE_FILE_MAX_BYTES = 50 * 1024 * 1024;
export const RESPONSE_FILE_HEADERS_TIMEOUT_MS = 8_000;
export const RESPONSE_FILE_DOWNLOAD_TIMEOUT_MS = 30_000;
const ERROR_BODY_MAX_BYTES = 16 * 1024;

export type ResponseFileReference = { fileId: string; containerId?: string };
export type DownloadedResponseFile = { bytes: Uint8Array; mimeType: string; filename?: string };

function resourceId(value: string, label: string): string {
  // API resource IDs are opaque path segments, never URLs or filesystem paths.
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(value)) {
    throw new Error(`Invalid response ${label} id`);
  }
  return encodeURIComponent(value);
}

function filenameFromHeader(header: string | null): string | undefined {
  if (!header) return undefined;
  const encoded = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  const value = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(header);
  let filename = value?.[1] ?? value?.[2] ?? "";
  if (encoded) {
    try { filename = decodeURIComponent(encoded.trim()); } catch { /* Use the plain filename. */ }
  }
  filename = filename.trim().replaceAll("\\", "/").split("/").at(-1)!
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").slice(0, 200);
  return filename && filename !== "." && filename !== ".." ? filename : undefined;
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(signal.reason);
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try { return await Promise.race([promise, abort]); }
  finally { if (rejectAbort) signal.removeEventListener("abort", rejectAbort); }
}

async function readBytes(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error("Response file exceeds the download size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await withAbort(reader.read(), signal);
      signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) throw new Error("Response file exceeds the download size limit");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

/** Main-process only: the caller verifies the reference belongs to its session. */
export async function downloadResponseFile(
  config: OpenAiCompatibleClientConfig,
  reference: ResponseFileReference,
  signal?: AbortSignal,
): Promise<DownloadedResponseFile> {
  const fileId = resourceId(reference.fileId, "file");
  const path = reference.containerId !== undefined
    ? `containers/${resourceId(reference.containerId, "container")}/files/${fileId}/content`
    : `files/${fileId}/content`;
  let url: URL;
  try { url = new URL(providerApiEndpoint(config.baseUrl, path)); }
  catch { throw new Error("Invalid response file provider URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Response file provider URL must use HTTP or HTTPS without embedded credentials");
  }
  url.hash = "";
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error("Response file download cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const headerTimer = setTimeout(() => controller.abort(new Error("Response file request timed out waiting for response headers")), RESPONSE_FILE_HEADERS_TIMEOUT_MS);
  const totalTimer = setTimeout(() => controller.abort(new Error("Response file download timed out")), RESPONSE_FILE_DOWNLOAD_TIMEOUT_MS);
  try {
    controller.signal.throwIfAborted();
    let response: Response;
    try {
      response = await withAbort(fetch(url.toString(), {
        method: "GET", redirect: "error", signal: controller.signal,
        headers: withLlmUserAgent({ Authorization: `Bearer ${config.apiKey}` }),
      }), controller.signal);
    } catch {
      controller.signal.throwIfAborted();
      throw new Error("Response file request failed");
    } finally { clearTimeout(headerTimer); }
    controller.signal.throwIfAborted();
    if (!response.ok) {
      let detail = "";
      try {
        const bytes = await readBytes(response, ERROR_BODY_MAX_BYTES, controller.signal);
        const data = JSON.parse(new TextDecoder().decode(bytes)) as { error?: { message?: unknown }; message?: unknown };
        const message = data?.error?.message ?? data?.message;
        if (typeof message === "string") detail = message.replace(/[\r\n]+/g, " ");
      } catch { controller.signal.throwIfAborted(); }
      if (config.apiKey) detail = detail.split(config.apiKey).join("[redacted]");
      detail = detail.slice(0, 300);
      throw new Error(`Response file download failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
    }
    let bytes: Uint8Array;
    try { bytes = await readBytes(response, RESPONSE_FILE_MAX_BYTES, controller.signal); }
    catch (error) {
      controller.signal.throwIfAborted();
      if (error instanceof Error && error.message === "Response file exceeds the download size limit") throw error;
      throw new Error("Response file content could not be read");
    }
    controller.signal.throwIfAborted();
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    const mimeType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType) && contentType.length < 128
      ? contentType : "application/octet-stream";
    const filename = filenameFromHeader(response.headers.get("content-disposition"));
    return { bytes, mimeType, ...(filename ? { filename } : {}) };
  } finally {
    clearTimeout(headerTimer);
    clearTimeout(totalTimer);
    signal?.removeEventListener("abort", abort);
  }
}
