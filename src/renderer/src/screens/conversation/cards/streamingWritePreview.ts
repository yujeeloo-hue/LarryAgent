import { isMarkdownPathOrName } from "./codeHighlight.js";
import { updateLinedFileView } from "./LinedFileView.js";
import {
  parsePartialWriteFileArgs,
  patchHeaderPathFromText,
} from "./parsePartialWriteArgs.js";
import {
  isPatchTool,
  isPlanDocTool,
  pathFromArgs,
  planDocPathHintFromTitle,
  planDocTitleFromArgs,
  toolCardHint,
} from "./toolInvocationHelpers.js";
import { renderMarkdownText } from "../renderMarkdownText.js";
import { updateVirtualToolCardInput, virtualToolCardIsSuspended } from "./virtualToolCard.js";

export type StreamingWritePreviewInput = {
  /** Resolved tool name: write_file | patch | write_plan_doc. */
  name: string;
  arguments: unknown;
  argumentsRaw: string;
  previewContent: string;
};

/**
 * Display path for a live write / patch preview: parsed args first, then
 * whatever can be skimmed off the still-open argument stream.
 */
export function streamingWritePreviewPathHint(
  input: Pick<StreamingWritePreviewInput, "name" | "arguments" | "argumentsRaw">,
): string | undefined {
  const partial = parsePartialWriteFileArgs(input.argumentsRaw);
  return (
    pathFromArgs(input.arguments) ??
    (isPatchTool(input.name) && partial.patchText !== undefined
      ? patchHeaderPathFromText(partial.patchText)
      : undefined) ??
    partial.path ??
    (isPlanDocTool(input.name)
      ? planDocPathHintFromTitle(
          planDocTitleFromArgs(input.arguments) ?? partial.title,
        )
      : undefined)
  );
}

/**
 * Patch a live write / patch preview card in place.
 *
 * Rebuilding the whole card per streamed chunk throws away the preview's
 * scroll container ~20 times a second; on platforms with classic (non-overlay)
 * scrollbars that shows up as a flickering scrollbar. Returns false when the
 * card shape changed (tool name or preview kind) and the caller must rebuild.
 */
export function updateStreamingWritePreviewCard(
  card: HTMLElement,
  input: StreamingWritePreviewInput,
): boolean {
  if (card.dataset.toolStreaming !== "1") return false;
  const sameName = card.dataset.toolName === input.name;
  // Closed/offscreen cards store chunks without rendering or highlighting.
  if (updateVirtualToolCardInput(card, input)) {
    if (virtualToolCardIsSuspended(card)) return true;
    if (!sameName) return false;
    syncPreviewHint(card, input);
    return true;
  }
  if (!sameName) return false;

  const previewBody = card.querySelector<HTMLElement>(
    ".content-card-tool-preview-body",
  );
  if (!previewBody) return false;

  const pathHint = streamingWritePreviewPathHint(input);
  const markdownContainer = previewBody.querySelector<HTMLElement>(
    ".content-card-write-markdown",
  );
  if (isMarkdownPathOrName(pathHint)) {
    if (!markdownContainer) return false;
    renderMarkdownText(input.previewContent, markdownContainer, {
      streaming: true,
    });
  } else {
    if (markdownContainer) return false;
    const lines = previewBody.querySelector<HTMLElement>(".tool-file-lines");
    if (!lines) return false;
    updateLinedFileView(lines, input.previewContent, {
      ...(pathHint !== undefined ? { pathOrName: pathHint } : {}),
    });
  }

  syncPreviewHint(card, input);
  return true;
}

/** Keep the summary hint in sync with the path/title arriving on the stream. */
function syncPreviewHint(
  card: HTMLElement,
  input: StreamingWritePreviewInput,
): void {
  const left = card.querySelector<HTMLElement>(
    ".content-card-tool-result-left",
  );
  if (!left) return;

  const hintText = toolCardHint({
    name: input.name,
    arguments: input.arguments,
    resultText: "",
  });
  let hint = left.querySelector<HTMLElement>(".content-card-tool-result-hint");
  if (!hintText) {
    hint?.remove();
    return;
  }
  if (!hint) {
    hint = document.createElement("span");
    hint.className = "content-card-tool-result-hint";
    left.append(hint);
  }
  const text = hintText.length <= 64 ? hintText : `${hintText.slice(0, 61)}…`;
  if (hint.textContent !== text) hint.textContent = text;
  const title = pathFromArgs(input.arguments) || hintText;
  if (hint.title !== title) hint.title = title;
}
