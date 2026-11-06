import { isSvgMimeType, isSvgPath } from "../tools/fileMeta.js";
import type { AttachmentKind } from "../session/types.js";

export type AttachmentWireFields = {
  kind: AttachmentKind | string;
  uri: string;
  name?: string;
  mimeType?: string;
};

/**
 * Model-facing path stub for a user attachment.
 * Metadata only — never embeds file bytes or body text.
 */
export function formatAttachmentWireStub(part: AttachmentWireFields): string {
  const name = part.name?.trim() || (part.kind === "image" ? "image" : part.uri);
  if (part.kind === "image") {
    if (isSvgPath(part.uri) || isSvgPath(name) || isSvgMimeType(part.mimeType)) {
      return `[Attached SVG "${name}" at absolute path "${part.uri}". SVG is XML markup — use read_file to read it. Do not call read_image (vision models do not accept SVG).]`;
    }
    return `[Attached image "${name}" at absolute path "${part.uri}". Call read_image with this path to understand its contents, or pass it to generate_image via images for image-to-image.]`;
  }
  const mime = (part.mimeType ?? "").toLowerCase();
  const isPdf =
    mime === "application/pdf" || /\.pdf$/i.test(part.uri) || /\.pdf$/i.test(name);
  if (isPdf) {
    return `[Attached file "${name}" at absolute path "${part.uri}". Use display_pdf to show it to the user, or other tools with this path as needed.]`;
  }
  const kindLabel =
    part.kind === "source_code"
      ? "source_code"
      : part.kind === "audio" || part.kind === "video"
        ? part.kind
        : "file";
  return `[Attached ${kindLabel} "${name}" at absolute path "${part.uri}". Use read_file (or other tools) with this path when you need its contents.]`;
}

/**
 * Path hint for an image that is already shown to the model as an
 * `image_url` content part (multimodal wire). The pixels are visible; this
 * line surfaces the absolute path so tools that need the file itself
 * (generate_image reference images, etc.) can be called.
 */
export function formatAttachmentImagePathHint(
  part: AttachmentWireFields,
): string {
  const name = part.name?.trim() || "image";
  return `[Image "${name}" at absolute path "${part.uri}" — pass this path to tools (e.g. generate_image images) when the file itself is needed.]`;
}
