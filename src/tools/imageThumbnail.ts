import { execFile, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { IS_HEADLESS } from "../platformCaps.js";
import { isSvgMimeType } from "./fileMeta.js";

export const THUMBNAIL_MAX_EDGE = 1280;
export const THUMBNAIL_JPEG_QUALITY = 82;
const THUMBNAIL_JPEG_QUALITY_SMALL = 68;
export const THUMBNAIL_MAX_BASE64_CHARS = 400_000;
export const THUMBNAIL_SOURCE_MAX_BYTES = 32 * 1024 * 1024;
const SVG_EMBED_MAX_BYTES = 256 * 1024;

const FFMPEG_PROBE_TIMEOUT_MS = 5_000;
const FFMPEG_ENCODE_TIMEOUT_MS = 15_000;
const FFMPEG_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const FFMPEG_BIN_CANDIDATES = ["ffmpeg", "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
const FFMPEG_JPEG_QUALITY = 4;
const FFMPEG_JPEG_QUALITY_SMALL = 8;
const FFMPEG_SCALE_FILTER = `scale=w='min(iw,${THUMBNAIL_MAX_EDGE})':h=-2`;

type CliExec = (
  bin: string,
  args: string[],
  input: Buffer,
  timeoutMs: number,
  maxBuffer: number,
) => Promise<Buffer | null>;

let cliExecOverride: CliExec | null | undefined;
let cachedFfmpegBin: string | null | undefined;

export function setCliExecForTests(exec: CliExec | null | undefined): void {
  cliExecOverride = exec;
  cachedFfmpegBin = undefined;
}

function resolveCliExec(): CliExec | null {
  if (cliExecOverride !== undefined) return cliExecOverride;
  return IS_HEADLESS ? defaultCliExec : null;
}

const defaultCliExec: CliExec = (bin, args, input, timeoutMs, maxBuffer) =>
  new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = execFile(
        bin,
        args,
        { encoding: "buffer", timeout: timeoutMs, maxBuffer, killSignal: "SIGKILL" },
        (error, stdout) => {
          resolve(error || stdout.length === 0 ? null : stdout);
        },
      );
    } catch {
      resolve(null);
      return;
    }
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });

async function probeFfmpegBin(exec: CliExec): Promise<string | null> {
  if (cachedFfmpegBin !== undefined) return cachedFfmpegBin;
  for (const bin of FFMPEG_BIN_CANDIDATES) {
    const out = await exec(
      bin,
      ["-hide_banner", "-version"],
      Buffer.alloc(0),
      FFMPEG_PROBE_TIMEOUT_MS,
      64 * 1024,
    );
    if (out?.toString("utf8", 0, 256).includes("ffmpeg")) {
      cachedFfmpegBin = bin;
      return bin;
    }
  }
  cachedFfmpegBin = null;
  return null;
}

async function cliRasterThumbnail(
  buffer: Buffer,
  mime: string,
): Promise<ImageThumbnail | null> {
  const exec = resolveCliExec();
  if (!exec) return null;
  const bin = await probeFfmpegBin(exec);
  if (!bin) return null;
  const passes: Array<{
    mimeType: "image/png" | "image/jpeg";
    codecArgs: string[];
  }> = [
    ...(mime === "image/png"
      ? [{ mimeType: "image/png" as const, codecArgs: ["-vcodec", "png"] }]
      : []),
    {
      mimeType: "image/jpeg" as const,
      codecArgs: ["-vcodec", "mjpeg", "-q:v", String(FFMPEG_JPEG_QUALITY)],
    },
    {
      mimeType: "image/jpeg" as const,
      codecArgs: ["-vcodec", "mjpeg", "-q:v", String(FFMPEG_JPEG_QUALITY_SMALL)],
    },
  ];
  for (const pass of passes) {
    const out = await exec(
      bin,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-frames:v",
        "1",
        "-vf",
        FFMPEG_SCALE_FILTER,
        "-f",
        "image2pipe",
        ...pass.codecArgs,
        "pipe:1",
      ],
      buffer,
      FFMPEG_ENCODE_TIMEOUT_MS,
      FFMPEG_MAX_OUTPUT_BYTES,
    );
    if (!out || out.length === 0) continue;
    const base64 = out.toString("base64");
    if (base64.length <= THUMBNAIL_MAX_BASE64_CHARS) {
      return { base64, mimeType: pass.mimeType };
    }
  }
  return null;
}

export type ImageThumbnail = {
  base64: string;
  mimeType: "image/jpeg" | "image/png" | "image/svg+xml";
};

type DecodedImage = {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width: number; height: number; quality: "good" }): DecodedImage;
  toJPEG(quality: number): Buffer;
  toPNG(): Buffer;
};

type NativeImageLike = {
  createFromBuffer(buffer: Buffer): DecodedImage;
};

let cachedDecoder: NativeImageLike | null | undefined;
let decoderOverride: NativeImageLike | null | undefined;

export function setNativeImageDecoderForTests(
  decoder: NativeImageLike | null | undefined,
): void {
  decoderOverride = decoder;
  cachedDecoder = undefined;
}

async function resolveDecoder(): Promise<NativeImageLike | null> {
  if (decoderOverride !== undefined) return decoderOverride;
  if (cachedDecoder !== undefined) return cachedDecoder;
  try {
    const electron = (await import("electron")) as unknown as {
      nativeImage?: Partial<NativeImageLike>;
    };
    const nativeImage = electron?.nativeImage;
    cachedDecoder =
      nativeImage && typeof nativeImage.createFromBuffer === "function"
        ? (nativeImage as NativeImageLike)
        : null;
  } catch {
    cachedDecoder = null;
  }
  return cachedDecoder;
}

function encodeWithinBudget(scaled: DecodedImage, isPngSource: boolean): ImageThumbnail | null {
  const encodings: Array<{ mimeType: ImageThumbnail["mimeType"]; encode: () => Buffer }> = [
    ...(isPngSource
      ? [{ mimeType: "image/png" as const, encode: () => scaled.toPNG() }]
      : []),
    { mimeType: "image/jpeg" as const, encode: () => scaled.toJPEG(THUMBNAIL_JPEG_QUALITY) },
    { mimeType: "image/jpeg" as const, encode: () => scaled.toJPEG(THUMBNAIL_JPEG_QUALITY_SMALL) },
  ];
  for (const { mimeType, encode } of encodings) {
    let bytes: Buffer;
    try {
      bytes = encode();
    } catch {
      return null;
    }
    if (bytes.byteLength === 0) continue;
    const base64 = bytes.toString("base64");
    if (base64.length <= THUMBNAIL_MAX_BASE64_CHARS) {
      return { base64, mimeType };
    }
  }
  return null;
}

export async function imageThumbnailFromBytes(
  bytes: Uint8Array,
  mimeType: string,
): Promise<ImageThumbnail | null> {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.byteLength === 0 || buffer.byteLength > THUMBNAIL_SOURCE_MAX_BYTES) {
    return null;
  }
  const mime = mimeType.trim().toLowerCase();
  if (isSvgMimeType(mime)) {
    return buffer.byteLength <= SVG_EMBED_MAX_BYTES
      ? { base64: buffer.toString("base64"), mimeType: "image/svg+xml" }
      : null;
  }
  const decoder = await resolveDecoder();
  if (!decoder) {
    return cliRasterThumbnail(buffer, mime);
  }
  let image: DecodedImage;
  try {
    image = decoder.createFromBuffer(buffer);
  } catch {
    return null;
  }
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(width, height));
  let scaled: DecodedImage = image;
  if (scale < 1) {
    try {
      scaled = image.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: "good",
      });
    } catch {
      return null;
    }
  }
  try {
    return encodeWithinBudget(scaled, mime === "image/png");
  } catch {
    return null;
  }
}

export async function imageThumbnailFromFile(
  path: string,
  mimeType: string,
  sizeBytes?: number,
): Promise<ImageThumbnail | null> {
  if (typeof sizeBytes === "number" && sizeBytes > THUMBNAIL_SOURCE_MAX_BYTES) {
    return null;
  }
  try {
    return await imageThumbnailFromBytes(await readFile(path), mimeType);
  } catch {
    return null;
  }
}
