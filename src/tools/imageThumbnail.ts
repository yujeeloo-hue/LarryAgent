/**
 * Inline image previews (base64) embedded in image tool-result attachment
 * parts (thumbnailBase64 / thumbnailMimeType) so the remote web console can
 * render display_image / generate_image / capture_app_window output without
 * a binary fetch channel — the relay server is a pure WS forwarder and the
 * browser cannot read Mac-local files. Mac renders the original file and
 * ignores these fields; the model wire reads text parts only.
 *
 * Two-stage raster decoder:
 * 1. Electron nativeImage (Mac/Windows app). Imported lazily: tool tests and
 *    the Loops daemon run plain Node, where the "electron" module resolves to
 *    the binary path string (or the daemon shim, whose nativeImage has no
 *    createFromBuffer). There the decoder is unavailable and every raster
 *    call degrades to null — no thumbnail, the web card falls back to the
 *    compact row. GIF sources decode to their first frame; WebP may not
 *    decode at all (nativeImage supports PNG/JPEG) — both are acceptable
 *    preview degradations.
 * 2. ffmpeg CLI (headless agentd on the Pi ONLY — gated on IS_HEADLESS, so
 *    Mac/Windows and the Loops daemon behave exactly as before). The Pi OS
 *    image ships ffmpeg; decode+downscale+re-encode rides a single
 *    stdin→stdout pipe (no temp files: the systemd unit is
 *    ProtectSystem=strict / PrivateTmp). As a bonus it decodes WebP, which
 *    nativeImage cannot.
 */
import { execFile, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { IS_HEADLESS } from "../platformCaps.js";
import { isSvgMimeType } from "./fileMeta.js";

/** Longest-edge bound for raster previews (fits the console column + retina). */
export const THUMBNAIL_MAX_EDGE = 1280;
/** First-pass JPEG re-encode quality. */
export const THUMBNAIL_JPEG_QUALITY = 82;
/** Second-pass JPEG quality when the first pass busts the budget. */
const THUMBNAIL_JPEG_QUALITY_SMALL = 68;
/** Base64 length budget per embedded preview (~300 KB decoded). */
export const THUMBNAIL_MAX_BASE64_CHARS = 400_000;
/** Larger source files are not decoded (main-process memory guard). */
export const THUMBNAIL_SOURCE_MAX_BYTES = 32 * 1024 * 1024;
/** SVG previews are embedded as-is (vector, tiny) up to this size. */
const SVG_EMBED_MAX_BYTES = 256 * 1024;

// ── ffmpeg CLI fallback (agentd / headless Pi only) ─────────────
/** Probe timeout for `ffmpeg -version`. */
const FFMPEG_PROBE_TIMEOUT_MS = 5_000;
/** Encode timeout per pass (a ≤1280px re-encode takes ~0.5s on a Pi 4/5). */
const FFMPEG_ENCODE_TIMEOUT_MS = 15_000;
/** stdout cap for the encode pipe — a ≤1280px re-encode sits far below. */
const FFMPEG_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/**
 * Binary candidates in probe order. The systemd unit sets no PATH, so the
 * compiled-in default (/usr/local/bin:/usr/bin:…) applies — ffmpeg lands in
 * /usr/bin; the bare name covers interactive/custom installs, absolutes are
 * the belt-and-braces fallback.
 */
const FFMPEG_BIN_CANDIDATES = ["ffmpeg", "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
/** mjpeg quality ladder (ffmpeg qscale: 2 best … 31 worst). */
const FFMPEG_JPEG_QUALITY = 4;
const FFMPEG_JPEG_QUALITY_SMALL = 8;
/**
 * Downscale-only fit to THUMBNAIL_MAX_EDGE (min() never upscales; -2 keeps
 * the height even for encoder compatibility). Single-argv quoting — execFile
 * passes this verbatim, ffmpeg's own filter parser strips the quotes.
 */
const FFMPEG_SCALE_FILTER = `scale=w='min(iw,${THUMBNAIL_MAX_EDGE})':h=-2`;

/**
 * Test seam for the CLI fallback: runs (or fakes) one ffmpeg invocation.
 * Receives the binary, argv, stdin bytes and limits; resolves to stdout
 * bytes, or null on any failure (non-zero exit, timeout, maxBuffer).
 */
type CliExec = (
  bin: string,
  args: string[],
  input: Buffer,
  timeoutMs: number,
  maxBuffer: number,
) => Promise<Buffer | null>;

let cliExecOverride: CliExec | null | undefined;
/** Probe result cache (null = probed, no usable ffmpeg). Reset with the seam. */
let cachedFfmpegBin: string | null | undefined;

/** Test seam — overrides CLI-exec resolution (undefined = default gating). */
export function setCliExecForTests(exec: CliExec | null | undefined): void {
  cliExecOverride = exec;
  cachedFfmpegBin = undefined;
}

/**
 * Runtime gate: the ffmpeg fallback exists for the headless agentd node (Pi)
 * only — the Mac/Windows app always has nativeImage and the Loops daemon
 * keeps the compact-row fallback. Outside agentd behavior is byte-identical
 * to before. A test override bypasses the gate (the runner is not headless).
 */
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
    // EPIPE when the probe exits before draining stdin — not a failure here.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });

/** Probe the binary candidates once; cache the hit (or null) process-wide. */
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

/**
 * Headless-agentd raster path: decode + downscale + re-encode through one
 * ffmpeg stdin→stdout pipe. GIF collapses to its first frame (the Mac
 * degradation, matched); PNG sources try PNG first to keep alpha, then fall
 * to the JPEG ladder. Returns null on any failure — the web card then falls
 * back to the compact row, same as before.
 */
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
/** Test seam — overrides decoder resolution (undefined = re-resolve lazily). */
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
    // Real Electron main: { nativeImage: { createFromBuffer } }. Plain Node:
    // the module default-exports the binary path string — no nativeImage.
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
  // PNG sources keep PNG when it fits (lossless alpha — macOS window shots
  // have transparent rounded corners that JPEG would flatten to black);
  // otherwise fall through to JPEG, then give up if still over budget.
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
  // generated_image bytes arrive as Uint8Array; nativeImage + base64 want a
  // Buffer — wrap as a zero-copy view when needed.
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.byteLength === 0 || buffer.byteLength > THUMBNAIL_SOURCE_MAX_BYTES) {
    return null;
  }
  const mime = mimeType.trim().toLowerCase();
  if (isSvgMimeType(mime)) {
    // Vector source: embed as-is (the <img> data URL renders it natively).
    return buffer.byteLength <= SVG_EMBED_MAX_BYTES
      ? { base64: buffer.toString("base64"), mimeType: "image/svg+xml" }
      : null;
  }
  const decoder = await resolveDecoder();
  if (!decoder) {
    // No nativeImage: headless agentd (Pi) falls back to the ffmpeg CLI —
    // gated to IS_HEADLESS inside resolveCliExec, so Mac/Windows and the
    // Loops daemon still get null here (unchanged compact-row fallback).
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
    // Preview generation must never fail the tool result.
    return null;
  }
}
