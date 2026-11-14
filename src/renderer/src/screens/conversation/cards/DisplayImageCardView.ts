import { Camera, ChevronDown, Download, ExternalLink, FolderOpen } from "lucide";
import { createConversationImageElement } from "../../../markdown/conversationImage.js";
import { createLucideIcon } from "../../../ui/originalIcons.js";
import { localFileMediaUrl } from "../../../ui/localFileUrl.js";
import { fileUriToPath } from "../../../ui/filePath.js";
import type { ToolResultSnapshot } from "./ToolInvocationCardView.js";

export type DisplayImageCardInput = {
  arguments: unknown;
  result?: ToolResultSnapshot;
  revealLabel?: string;
  onOpen?: (path: string) => void;
  onReveal?: (path: string) => void;
  /** When provided, shows a Save As action that copies the file. */
  onSave?: (path: string) => void;
  /** Label for the Save As action (defaults to "Save As"). */
  saveLabel?: string;
  /** When true, hide the image until the user expands the card. */
  startCollapsed?: boolean;
  /** Summary title when collapsed (defaults to "Image"). */
  title?: string;
  /**
   * When set and no result has arrived yet, renders a sized generating
   * placeholder (aspect ratio from the `size` argument) with this label —
   * e.g. generate_image while the request is in flight.
   */
  pendingLabel?: string;
};

/** Aspect ratio from "1024x1024" / "1024×1024" pixels or "16:9" ratio
 * strings. Returns null when the size is unknown or unparseable. */
export function aspectRatioFromArgs(args: unknown): number | null {
  if (!args || typeof args !== "object") return null;
  const size = (args as Record<string, unknown>).size;
  if (typeof size !== "string") return null;
  const text = size.trim();
  const pixels = text.match(/^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)$/i);
  if (pixels?.[1] && pixels?.[2]) {
    const ratio = parseFloat(pixels[1]) / parseFloat(pixels[2]);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
  }
  const ratioText = text.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (ratioText?.[1] && ratioText?.[2]) {
    const ratio = parseFloat(ratioText[1]) / parseFloat(ratioText[2]);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
  }
  return null;
}

/** Raw `size` argument text (e.g. "1024x1024") for the placeholder caption. */
function sizeTextFromArgs(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const size = (args as Record<string, unknown>).size;
  return typeof size === "string" && size.trim() ? size.trim() : null;
}

/** Intrinsic pixel width from a "WxH" / "W×H" size argument (e.g. 1024 for
 * "1024x1024"), so the placeholder mirrors the final image's rendered width
 * instead of stretching across the whole message. Null for ratio-only or
 * unknown sizes. */
export function displayWidthFromArgs(args: unknown): number | null {
  if (!args || typeof args !== "object") return null;
  const size = (args as Record<string, unknown>).size;
  if (typeof size !== "string") return null;
  const pixels = size.trim().match(/^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)$/i);
  if (!pixels?.[1] || !pixels?.[2]) return null;
  const width = parseFloat(pixels[1]);
  return Number.isFinite(width) && width > 0 ? width : null;
}

function appendGeneratingPlaceholder(
  parent: HTMLElement,
  args: unknown,
  label: string,
): void {
  const box = document.createElement("div");
  box.className = "content-card-display-image-generating";
  const ratio = aspectRatioFromArgs(args);
  if (ratio) box.style.aspectRatio = String(ratio);
  // Mirror the final image: intrinsic pixel width when known (e.g. 1024x1024
  // renders at most 1024px wide), fall back to a compact card otherwise.
  const width = displayWidthFromArgs(args);
  box.style.width = width
    ? `min(100%, ${width}px, 720px)`
    : "min(100%, 480px)";
  box.style.maxWidth = "100%";

  const spinner = document.createElement("span");
  spinner.className = "content-card-display-image-generating-spinner";
  spinner.setAttribute("role", "status");
  spinner.setAttribute("aria-label", label);

  const labelEl = document.createElement("span");
  labelEl.className = "content-card-display-image-generating-label";
  labelEl.textContent = label;

  box.append(spinner, labelEl);

  const size = sizeTextFromArgs(args);
  if (size) {
    const caption = document.createElement("span");
    caption.className = "content-card-display-image-generating-size";
    caption.textContent = size;
    box.append(caption);
  }

  parent.append(box);
}

function pathFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "output"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function imagePathFromResult(result: ToolResultSnapshot | undefined): string | undefined {
  if (!result || result.returnCode !== 0) return undefined;
  for (const part of result.content) {
    if (part.type !== "attachment") continue;
    const uri = typeof part.uri === "string" ? part.uri : "";
    const path = fileUriToPath(uri);
    if (path) return path;
  }
  return undefined;
}

function errorTextFromResult(result: ToolResultSnapshot | undefined): string | null {
  if (!result || result.returnCode === 0) return null;
  for (const part of result.content) {
    if (part.type === "text" && typeof part.text === "string") {
      const text = part.text.trim();
      if (text) return text;
    }
  }
  return "Failed to display image.";
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function appendImageBody(
  parent: HTMLElement,
  imagePath: string,
  input: DisplayImageCardInput,
): void {
  const figure = document.createElement("figure");
  figure.className = "content-card-display-image-figure";

  const img = createConversationImageElement({
    src: localFileMediaUrl(imagePath),
    alt: basename(imagePath),
    className: "conversation-image content-card-display-image-preview",
  });
  img.addEventListener("error", () => {
    figure.replaceChildren();
    const message = document.createElement("p");
    message.className = "content-card-display-image-error";
    message.textContent = "Failed to load image.";
    figure.append(message);
  });
  figure.append(img);

  const actions = document.createElement("div");
  actions.className = "content-card-display-image-actions";

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "content-card-display-image-action";
  openBtn.append(
    createLucideIcon(ExternalLink, { size: 14 }),
    document.createTextNode("Open"),
  );
  openBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    input.onOpen?.(imagePath);
  });

  const revealBtn = document.createElement("button");
  revealBtn.type = "button";
  revealBtn.className = "content-card-display-image-action";
  revealBtn.append(
    createLucideIcon(FolderOpen, { size: 14 }),
    document.createTextNode(input.revealLabel ?? "Reveal"),
  );
  revealBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    input.onReveal?.(imagePath);
  });

  actions.append(openBtn, revealBtn);
  if (input.onSave) {
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "content-card-display-image-action action-primary";
    saveBtn.append(
      createLucideIcon(Download, { size: 14 }),
      document.createTextNode(input.saveLabel?.trim() || "Save As"),
    );
    saveBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      input.onSave?.(imagePath);
    });
    actions.append(saveBtn);
  }
  parent.append(figure, actions);
}

/** Image tool card for display_image / capture_app_window / generate_image. */
export function createDisplayImageCard(input: DisplayImageCardInput): HTMLElement {
  const resultImagePath = imagePathFromResult(input.result);
  const errorText = errorTextFromResult(input.result);
  const collapsed = Boolean(input.startCollapsed);
  const title = input.title?.trim() || "Image";

  if (errorText) {
    const card = document.createElement("article");
    card.className = "content-card content-card-display-image";
    const message = document.createElement("p");
    message.className = "content-card-display-image-error";
    message.textContent = errorText;
    card.append(message);
    return card;
  }

  // In-flight generation: show a sized placeholder (aspect ratio from the
  // `size` argument) until the result arrives. Takes precedence over an
  // explicit `path` argument, which does not exist on disk yet.
  if (!resultImagePath && input.pendingLabel) {
    const card = document.createElement("article");
    card.className = "content-card content-card-display-image";
    appendGeneratingPlaceholder(card, input.arguments, input.pendingLabel);
    return card;
  }

  const imagePath =
    resultImagePath ?? pathFromArgs(input.arguments);

  if (!imagePath) {
    const card = document.createElement("article");
    card.className = "content-card content-card-display-image";
    const pending = document.createElement("p");
    pending.className = "content-card-display-image-pending";
    pending.textContent = collapsed ? "Capturing window…" : "Loading image…";
    card.append(pending);
    return card;
  }

  if (!collapsed) {
    const card = document.createElement("article");
    card.className = "content-card content-card-display-image";
    appendImageBody(card, imagePath, input);
    return card;
  }

  const card = document.createElement("details");
  card.className =
    "content-card content-card-display-image content-card-display-image-collapsible";
  card.open = false;

  const summary = document.createElement("summary");
  summary.className = "content-card-display-image-summary";

  const left = document.createElement("span");
  left.className = "content-card-display-image-summary-left";
  const icon = createLucideIcon(Camera, { size: 15 });
  icon.classList.add("content-card-display-image-summary-icon");
  const name = document.createElement("span");
  name.className = "content-card-display-image-summary-title";
  name.textContent = title;
  const file = document.createElement("span");
  file.className = "content-card-display-image-summary-file";
  file.textContent = basename(imagePath);
  file.title = imagePath;
  left.append(icon, name, file);

  const chevron = createLucideIcon(ChevronDown, { size: 14 });
  chevron.classList.add("content-card-display-image-summary-chevron");

  summary.append(left, chevron);

  const body = document.createElement("div");
  body.className = "content-card-display-image-body";
  appendImageBody(body, imagePath, input);

  card.append(summary, body);
  return card;
}
