import {
  loadNativeImage,
  type NativeImageLike,
} from "../host/nativeImage.js";

/** Default bounds for base64-embedded chat images (fit-inside, aspect kept). */
export const BASE64_IMAGE_MAX_WIDTH = 800;
export const BASE64_IMAGE_MAX_HEIGHT = 600;
/** JPEG re-encode quality for base64 embedding (0–100). */
const JPEG_QUALITY = 85;

export type ResizeImageResult = {
  bytes: Buffer;
  mimeType: string;
  /** True when the source was actually downscaled. */
  resized: boolean;
  width: number;
  height: number;
};

/**
 * Downscale an image to fit inside maxWidth × maxHeight (aspect ratio kept)
 * for base64 embedding on the model wire. Images already within bounds pass
 * through untouched (original bytes, no re-encode). JPEG sources re-encode
 * as JPEG; everything else as PNG.
 *
 * Returns null when the bytes cannot be decoded as an image — callers fall
 * back to the raw file. Headless nodes (no native decoder) always take the
 * raw-file path.
 */
export async function resizeImageForBase64(
  bytes: Buffer,
  mimeType: string,
  maxWidth = BASE64_IMAGE_MAX_WIDTH,
  maxHeight = BASE64_IMAGE_MAX_HEIGHT,
): Promise<ResizeImageResult | null> {
  const nativeImage = await loadNativeImage();
  if (!nativeImage) return null;
  let image: NativeImageLike;
  try {
    image = nativeImage.createFromBuffer(bytes);
  } catch {
    return null;
  }
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  if (width <= 0 || height <= 0) return null;
  if (width <= maxWidth && height <= maxHeight) {
    return { bytes, mimeType, resized: false, width, height };
  }
  const scale = Math.min(maxWidth / width, maxHeight / height);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const scaled = image.resize({
    width: targetWidth,
    height: targetHeight,
    quality: "good",
  });
  const isJpeg = /jpe?g/i.test(mimeType);
  const out = isJpeg ? scaled.toJPEG(JPEG_QUALITY) : scaled.toPNG();
  return {
    bytes: out,
    mimeType: isJpeg ? "image/jpeg" : "image/png",
    resized: true,
    width: targetWidth,
    height: targetHeight,
  };
}
