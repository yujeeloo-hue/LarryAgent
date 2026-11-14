/**
 * OpenAI Images-compatible text-to-image client (POST /images/generations).
 * Zhipu CogView, SiliconFlow and OpenAI gpt-image all speak this shape;
 * only whitelisted body fields are sent (e.g. Zhipu rejects response_format).
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  agentLogError,
  agentLogInfo,
  agentLogWarn,
} from "../logging/agentLog.js";
import { withLlmUserAgent } from "./userAgent.js";
import type { LlmRequestMeta, OpenAiCompatibleClientConfig } from "./types.js";

/** Single-request wall-clock timeout — image generation is slow (a 2K
 * seedream i2i probe measured ~93s; 5 min leaves headroom for queueing). */
export const IMAGEGEN_REQUEST_TIMEOUT_MS = 300_000;
/** Download timeout for provider-returned image URLs (short-lived OSS links). */
export const IMAGEGEN_DOWNLOAD_TIMEOUT_MS = 30_000;
/** Max generated image bytes accepted from a provider. */
export const IMAGEGEN_MAX_BYTES = 32 * 1024 * 1024;

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Images endpoint: `rawEndpoint` uses `baseUrl` as-is (already the full
 * endpoint); otherwise append `images/generations`. */
function imagesEndpoint(config: OpenAiCompatibleClientConfig): string {
  if (config.rawEndpoint === true) return config.baseUrl;
  return `${config.baseUrl.replace(/\/+$/, "")}/images/generations`;
}

function combinedSignal(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

type ImagesGenerationItem = {
  b64_json?: unknown;
  url?: unknown;
};

type ImagesGenerationResponse = {
  data?: unknown;
  error?: { message?: unknown; code?: unknown } | null;
  message?: unknown;
};

/** Best-effort provider error detail from a non-2xx JSON body. */
async function readErrorMessage(response: Response): Promise<string> {
  let detail = "";
  try {
    const payload = (await response.json()) as ImagesGenerationResponse;
    const err = payload?.error;
    if (err && typeof err === "object") {
      const code =
        typeof err.code === "string" && err.code ? ` (${err.code})` : "";
      const message =
        typeof err.message === "string" && err.message.trim()
          ? err.message.trim()
          : "";
      detail = `${message}${code}`.trim();
    } else if (typeof payload?.message === "string" && payload.message.trim()) {
      detail = payload.message.trim();
    }
  } catch {
    // Non-JSON error body — fall back to the status line alone.
  }
  return detail ? `: ${detail}` : "";
}

/** Detect PNG / JPEG / WebP / GIF from magic bytes. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    return "image/gif";
  }
  return null;
}

/** File extension for a mime type (default png). */
export function imageExtensionForMime(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/png":
      return "png";
    default:
      return "png";
  }
}

export type GenerateImageInput = {
  client: OpenAiCompatibleClientConfig;
  prompt: string;
  /** Provider-specific size string (e.g. "1024x1024", Zhipu "1440x720"). */
  size?: string;
  /**
   * Explicit watermark preference sent as `watermark: true|false` in the
   * body (Volcano Ark doubao-seedream). Omit = not sent (provider default).
   */
  watermark?: boolean;
  /**
   * Input images (image-to-image / reference images) already encoded for
   * the wire — base64 strings or https URLs, one entry per image. Sent as
   * the `image` body field (Volcano Ark seedream, 1–10 entries). Callers
   * must only pass these when the provider declares image-input support.
   */
  images?: string[];
  signal?: AbortSignal;
  /** Correlation for agent file logs. */
  meta?: LlmRequestMeta;
};

export type GenerateImageResult = {
  bytes: Uint8Array;
  mimeType: string;
};

function guardSize(bytes: Uint8Array): void {
  if (bytes.length === 0) {
    throw new Error("Image generation returned an empty image");
  }
  if (bytes.length > IMAGEGEN_MAX_BYTES) {
    throw new Error(
      `Image generation returned ${bytes.length} bytes; max ${IMAGEGEN_MAX_BYTES}`,
    );
  }
}

async function downloadImage(
  url: string,
  callerSignal: AbortSignal | undefined,
): Promise<GenerateImageResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: withLlmUserAgent({ Accept: "image/*" }),
      signal: combinedSignal(callerSignal, IMAGEGEN_DOWNLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    if (callerSignal?.aborted) throw new Error("Request cancelled");
    if (isTimeoutError(err)) {
      throw new Error(
        `Image download timed out after ${IMAGEGEN_DOWNLOAD_TIMEOUT_MS}ms`,
      );
    }
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  if (!response.ok) {
    throw new Error(`Image download failed (HTTP ${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  guardSize(bytes);
  const headerMime =
    response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase() ?? "";
  const sniffed = sniffImageMime(bytes);
  const mimeType =
    sniffed ?? (headerMime.startsWith("image/") ? headerMime : "image/png");
  return { bytes, mimeType };
}

/**
 * Generate one image from a text prompt via an OpenAI Images-compatible
 * endpoint. Decodes `data[].b64_json` directly or downloads `data[].url`
 * (b64 wins when both are present). Never writes to disk.
 */
export async function generateImage(
  input: GenerateImageInput,
): Promise<GenerateImageResult> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Prompt is empty");

  const startedAt = Date.now();
  const fields = {
    host: hostOf(input.client.baseUrl),
    model: input.client.model,
    purpose: "image_generation" as const,
    ...(input.meta?.sessionId ? { sessionId: input.meta.sessionId } : {}),
    ...(input.meta?.iteration !== undefined
      ? { iteration: input.meta.iteration }
      : {}),
  };
  agentLogInfo("imagegen.request", {
    ...fields,
    promptChars: prompt.length,
    ...(input.size?.trim() ? { size: input.size.trim() } : {}),
    ...(input.images?.length ? { imageCount: input.images.length } : {}),
  });

  // Only whitelisted fields are sent — providers reject OpenAI-only params
  // (Zhipu: response_format / n). n defaults to 1 on every provider.
  const body = {
    model: input.client.model,
    prompt,
    ...(input.size?.trim() ? { size: input.size.trim() } : {}),
    ...(typeof input.watermark === "boolean"
      ? { watermark: input.watermark }
      : {}),
    ...(input.images && input.images.length > 0
      ? { image: input.images }
      : {}),
  };

  let response: Response;
  try {
    response = await fetch(imagesEndpoint(input.client), {
      method: "POST",
      headers: withLlmUserAgent({
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.client.apiKey}`,
      }),
      body: JSON.stringify(body),
      signal: combinedSignal(input.signal, IMAGEGEN_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (input.signal?.aborted) {
      agentLogWarn("imagegen.cancelled", {
        ...fields,
        durationMs: Date.now() - startedAt,
      });
      throw new Error("Request cancelled");
    }
    const message = isTimeoutError(err)
      ? `Image generation timed out after ${IMAGEGEN_REQUEST_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    agentLogError("imagegen.error", {
      ...fields,
      message,
      durationMs: Date.now() - startedAt,
    });
    throw new Error(message);
  }

  if (!response.ok) {
    const message = `Image generation failed (HTTP ${response.status}${await readErrorMessage(response)})`;
    agentLogError("imagegen.error", {
      ...fields,
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
    });
    throw new Error(message);
  }

  let payload: ImagesGenerationResponse;
  try {
    payload = (await response.json()) as ImagesGenerationResponse;
  } catch {
    throw new Error("Image generation endpoint returned invalid JSON");
  }

  const entries = Array.isArray(payload.data)
    ? (payload.data as unknown[])
    : [];
  let b64Item: string | null = null;
  let urlItem: string | null = null;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as ImagesGenerationItem;
    if (typeof item.b64_json === "string" && item.b64_json && !b64Item) {
      b64Item = item.b64_json;
      break;
    }
    if (typeof item.url === "string" && item.url && !urlItem) {
      urlItem = item.url;
    }
  }

  const result = b64Item
    ? (() => {
        const bytes = new Uint8Array(Buffer.from(b64Item, "base64"));
        guardSize(bytes);
        return { bytes, mimeType: sniffImageMime(bytes) ?? "image/png" };
      })()
    : urlItem
      ? await downloadImage(urlItem, input.signal)
      : null;

  if (!result) {
    throw new Error(
      "Image generation response contains no image data (missing b64_json / url)",
    );
  }

  agentLogInfo("imagegen.result", {
    ...fields,
    imageBytes: result.bytes.length,
    mimeType: result.mimeType,
    durationMs: Date.now() - startedAt,
  });
  return result;
}

function fileStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export type SaveGeneratedImageResult = {
  filePath: string;
  sizeBytes: number;
  mimeType: string;
};

/**
 * Persist generated image bytes under `outputDir` (created when missing) as
 * `img-<yyyyMMdd-HHmmss>-<hex4>.<ext>` with the extension derived from the
 * mime type.
 */
export async function saveGeneratedImage(
  bytes: Uint8Array,
  mimeType: string,
  outputDir: string,
): Promise<SaveGeneratedImageResult> {
  await mkdir(outputDir, { recursive: true });
  const rand = randomBytes(2).toString("hex");
  const filePath = join(
    outputDir,
    `img-${fileStamp()}-${rand}.${imageExtensionForMime(mimeType)}`,
  );
  await writeFile(filePath, bytes);
  return { filePath, sizeBytes: bytes.length, mimeType };
}
