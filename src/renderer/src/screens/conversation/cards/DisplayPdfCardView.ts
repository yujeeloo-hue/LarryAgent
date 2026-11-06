import { ExternalLink, FolderOpen } from "lucide";
import { createLucideIcon } from "../../../ui/originalIcons.js";
import { localFileMediaUrl } from "../../../ui/localFileUrl.js";
import { fileUriToPath } from "../../../ui/filePath.js";
import type { ToolResultSnapshot } from "./ToolInvocationCardView.js";

export type DisplayPdfCardInput = {
  arguments: unknown;
  result?: ToolResultSnapshot;
  revealLabel: string;
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
};

function pathFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const path = (args as Record<string, unknown>).path;
  return typeof path === "string" && path.trim() ? path.trim() : undefined;
}

function pdfPathFromResult(result: ToolResultSnapshot | undefined): string | undefined {
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
  return "Failed to display PDF.";
}

/** PDF-only tool card for display_pdf — no status badge or args row. */
export function createDisplayPdfCard(input: DisplayPdfCardInput): HTMLElement {
  const card = document.createElement("article");
  card.className = "content-card content-card-display-pdf";

  const pdfPath =
    pdfPathFromResult(input.result) ?? pathFromArgs(input.arguments);
  const errorText = errorTextFromResult(input.result);

  if (errorText) {
    const message = document.createElement("p");
    message.className = "content-card-display-pdf-error";
    message.textContent = errorText;
    card.append(message);
    return card;
  }

  if (!pdfPath) {
    const pending = document.createElement("p");
    pending.className = "content-card-display-pdf-pending";
    pending.textContent = "Loading PDF…";
    card.append(pending);
    return card;
  }

  const frame = document.createElement("iframe");
  frame.className = "content-card-display-pdf-frame";
  frame.title = pdfPath.split(/[/\\]/).pop() ?? "PDF";
  frame.src = localFileMediaUrl(pdfPath);
  frame.addEventListener("error", () => {
    card.replaceChildren();
    const message = document.createElement("p");
    message.className = "content-card-display-pdf-error";
    message.textContent = "Failed to load PDF.";
    card.append(message);
  });

  const actions = document.createElement("div");
  actions.className = "content-card-display-pdf-actions";

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "content-card-display-pdf-action";
  openBtn.append(
    createLucideIcon(ExternalLink, { size: 14 }),
    document.createTextNode("Open"),
  );
  openBtn.addEventListener("click", () => {
    input.onOpen(pdfPath);
  });

  const revealBtn = document.createElement("button");
  revealBtn.type = "button";
  revealBtn.className = "content-card-display-pdf-action";
  revealBtn.append(
    createLucideIcon(FolderOpen, { size: 14 }),
    document.createTextNode(input.revealLabel),
  );
  revealBtn.addEventListener("click", () => {
    input.onReveal(pdfPath);
  });

  actions.append(openBtn, revealBtn);
  card.append(frame, actions);
  return card;
}
