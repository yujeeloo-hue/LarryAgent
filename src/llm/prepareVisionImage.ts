import { readFile } from "node:fs/promises";
import { loadNativeImage } from "../host/nativeImage.js";
import { isSvgMimeType, isSvgPath } from "../tools/fileMeta.js";

const MAX_EDGE = 1024;
const JPEG_QUALITY = 70;

export type PreparedVisionImage = {
  mimeType: string;
  base64: string;
  sourceWidth?: number;
  sourceHeight?: number;
  width?: number;
  height?: number;
  mode: "jpeg-resized" | "jpeg-original" | "raw-bytes";
};

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
  }

  const bytes = await readFile(imagePath);
  return {
    mimeType: fallbackMimeType,
    base64: bytes.toString("base64"),
    mode: "raw-bytes",
  };
}
