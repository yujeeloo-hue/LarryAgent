import { extname } from "node:path";
import type { AttachmentKind } from "../session/types.js";

const SOURCE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".html",
  ".md",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".sh",
  ".yml",
  ".yaml",
  ".toml",
  ".sql",
]);

export function guessAttachmentKind(path: string): AttachmentKind {
  const ext = extname(path).toLowerCase();
  if (SOURCE_EXTS.has(ext)) return "source_code";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) {
    return "image";
  }
  if ([".mp3", ".wav", ".m4a", ".ogg"].includes(ext)) return "audio";
  if ([".mp4", ".mov", ".webm"].includes(ext)) return "video";
  return "file";
}

export function guessMimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "text/typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "text/javascript";
    case ".json":
      return "application/json";
    case ".css":
      return "text/css";
    case ".html":
      return "text/html";
    case ".md":
      return "text/markdown";
    case ".py":
      return "text/x-python";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    default:
      return "text/plain";
  }
}

/** True when the path looks like a PDF. */
export function isPdfPath(path: string): boolean {
  return extname(path).toLowerCase() === ".pdf";
}

/** True when the path is SVG (XML markup, not a raster). */
export function isSvgPath(path: string): boolean {
  return extname(path).toLowerCase() === ".svg";
}

/** True when the MIME type is SVG / `image/svg+xml`. */
export function isSvgMimeType(mimeType: string | undefined): boolean {
  return (mimeType ?? "").toLowerCase().includes("svg");
}

/** True when the path looks like a raster image the vision model can read. */
export function isVisionImagePath(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext);
}

/**
 * Raster images a vision model can consume as `image_url` / `read_image`.
 * SVG is XML markup — never send it to multimodal image recognition.
 */
export function isVisionImageRef(path: string, mimeType?: string): boolean {
  if (isSvgPath(path) || isSvgMimeType(mimeType)) return false;
  return isVisionImagePath(path);
}

/** True when the path can be shown inline in the conversation (rasters + SVG). */
export function isDisplayImagePath(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext);
}
