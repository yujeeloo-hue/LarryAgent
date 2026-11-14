import { readFile } from "node:fs/promises";
import { loadNativeImage } from "../host/nativeImage.js";
import { isSvgMimeType, isSvgPath } from "../tools/fileMeta.js";

/** Longest edge after downscale (local vision models are slow on large pixels). */
const MAX_EDGE = 1024;
/** JPEG quality for the wire payload (0–100). */
const JPEG_QUALITY = 70;

export type PreparedVisionImage = {
  mimeType: string;
  base64: string;
  /** Diagnostics for the vision.request log: original pixel size, if decoded. */
  sourceWidth?: number;
  sourceHeight?: number;
  /** Diagnostics: pixel size actually placed on the wire. */
  width?: number;
  height?: number;
  /** Diagnostics: how the payload was produced. */
  mode: "jpeg-resized" | "jpeg-original" | "raw-bytes";
};

/**
 * Load a local raster image, downscale, and re-encode as JPEG for vision
 * requests. SVG is refused — it is XML markup, not a vision payload.
 * Falls back to the original file bytes when Electron cannot decode a
 * raster (never for SVG) — and always, in the headless agentd node, where
 * no native decoder exists (raw-bytes passthrough).
 */
export async function prepareVisionImage(
  imagePath: string,
  fallbackMimeType: string,
): Promise<PreparedVisionImage> {
  if (isSvgPath(imagePath) || isSvgMimeType(fallbackMimeType)) {
    throw new Error(
      "SVG is XML markup and cannot be sent to a vision model. Use read_file.",
    );
  }
  try {
    const nativeImage = await loadNativeImage();
    if (nativeImage) {
      const img = nativeImage.createFromPath(imagePath);
      if (img.isEmpty()) {
        throw new Error("empty nativeImage");
      }
      const { width, height } = img.getSize();
      let out = img;
      const edge = Math.max(width, height);
      if (edge > MAX_EDGE) {
        const scale = MAX_EDGE / edge;
        out = img.resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          quality: "better",
        });
      }
      const jpeg = out.toJPEG(JPEG_QUALITY);
      if (jpeg.byteLength > 0) {
        return {
          mimeType: "image/jpeg",
          base64: Buffer.from(jpeg).toString("base64"),
          sourceWidth: width,
          sourceHeight: height,
          width: out.getSize().width,
          height: out.getSize().height,
          mode: edge > MAX_EDGE ? "jpeg-resized" : "jpeg-original",
        };
      }
    }
  } catch {
    // Fall through to raw bytes.
  }

  const bytes = await readFile(imagePath);
  return {
    mimeType: fallbackMimeType,
    base64: bytes.toString("base64"),
    mode: "raw-bytes",
  };
}
