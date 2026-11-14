import { fileUriToPath } from "../ui/filePath.js";
import { localFileMediaUrl } from "../ui/localFileUrl.js";

const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp|svg)$/i;

function isAbsoluteFilesystemPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function isRemoteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Resolve Markdown image `href` to a renderer-safe `img` src, or null if unsupported. */
export function resolveMarkdownImageSrc(href: string | undefined | null): string | null {
  const trimmed = (href ?? "").trim();
  if (!trimmed) return null;

  if (isRemoteHttpUrl(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith("file:")) {
    const path = fileUriToPath(trimmed);
    if (path && IMAGE_PATH_RE.test(path)) {
      return localFileMediaUrl(path);
    }
    return null;
  }

  if (isAbsoluteFilesystemPath(trimmed) && IMAGE_PATH_RE.test(trimmed)) {
    return localFileMediaUrl(trimmed);
  }

  return null;
}

/** Create an image element sized to intrinsic dimensions up to the conversation width. */
export function createConversationImageElement(options: {
  src: string;
  alt: string;
  className?: string;
}): HTMLImageElement {
  const img = document.createElement("img");
  img.className = options.className ?? "conversation-image";
  img.alt = options.alt;
  img.loading = "lazy";
  img.decoding = "async";
  img.src = options.src;
  return img;
}
