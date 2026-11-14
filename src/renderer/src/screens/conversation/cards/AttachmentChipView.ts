import {
  File as FileIcon,
  FileCode,
  FileImage,
  FileAudio,
  FileVideo,
  Paperclip,
} from "lucide";
import { createLucideIcon, type IconNode } from "../../../ui/originalIcons.js";
import { localFileMediaUrl } from "../../../ui/localFileUrl.js";
import { fileUriToPath } from "../../../ui/filePath.js";

export type AttachmentChipInput = {
  kind: string;
  uri: string;
  name?: string;
  mimeType: string;
  sizeBytes?: number;
};

function iconForKind(kind: string): IconNode {
  switch (kind) {
    case "image":
      return FileImage;
    case "audio":
      return FileAudio;
    case "video":
      return FileVideo;
    case "source_code":
      return FileCode;
    case "file":
      return FileIcon;
    default:
      return Paperclip;
  }
}

function formatSize(bytes: number | undefined): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function displayName(input: AttachmentChipInput): string {
  if (input.name && input.name.trim()) return input.name.trim();
  if (input.uri) {
    try {
      const path = input.uri.replace(/^file:\/\//, "");
      const segments = path.split(/[/\\]/).filter(Boolean);
      return segments[segments.length - 1] ?? input.uri;
    } catch {
      return input.uri;
    }
  }
  return "Attachment";
}

function isImageAttachment(input: AttachmentChipInput): boolean {
  if (input.kind === "image") return true;
  return input.mimeType.toLowerCase().startsWith("image/");
}

/** Presentation-only attachment chip; images render a local thumbnail. */
export function createAttachmentChip(input: AttachmentChipInput): HTMLElement {
  const chip = document.createElement("div");
  chip.className = "content-card content-card-attachment";
  chip.title = input.uri || displayName(input);

  const nameText = displayName(input);
  const absolutePath = fileUriToPath(input.uri);
  const showThumb = isImageAttachment(input) && Boolean(absolutePath);

  if (showThumb) {
    chip.classList.add("is-image");
  }

  const meta = document.createElement("div");
  meta.className = "content-card-attachment-meta";

  const name = document.createElement("span");
  name.className = "content-card-attachment-name";
  name.textContent = nameText;

  const sub = document.createElement("span");
  sub.className = "content-card-attachment-sub";
  const size = formatSize(input.sizeBytes);
  const bits = [input.kind.replace(/_/g, " "), size].filter(Boolean);
  sub.textContent = bits.join(" · ");

  meta.append(name);
  if (sub.textContent) meta.append(sub);

  if (showThumb) {
    const thumb = document.createElement("img");
    thumb.className = "content-card-attachment-thumb";
    thumb.alt = nameText;
    thumb.loading = "lazy";
    thumb.decoding = "async";
    thumb.src = localFileMediaUrl(absolutePath);
    thumb.addEventListener("error", () => {
      chip.classList.remove("is-image");
      const icon = createLucideIcon(iconForKind(input.kind), { size: 14 });
      icon.classList.add("content-card-attachment-icon");
      thumb.replaceWith(icon);
    });
    thumb.addEventListener("click", (event) => {
      event.stopPropagation();
      void window.jellybot?.openPath?.(absolutePath);
    });
    chip.append(thumb, meta);
  } else {
    const icon = createLucideIcon(iconForKind(input.kind), { size: 14 });
    icon.classList.add("content-card-attachment-icon");
    chip.append(icon, meta);
  }

  return chip;
}
