import { prepareStreamingMarkdown } from "../../markdown/prepareStreamingMarkdown.js";
import { parseMarkdownBlocks } from "../../markdown/parseMarkdownBlocks.js";
import {
  renderMarkdownBlocks,
  renderMarkdownBlocksAsync,
} from "./cards/MarkdownBlocksView.js";

export type RenderMarkdownTextOptions = {
  /** Parse partial assistant output (closes unclosed fences, etc.). */
  streaming?: boolean;
};

/** Block identities of the last streaming paint, per container. */
const streamingBlockKeys = new WeakMap<HTMLElement, string[]>();

/** Parse Markdown and render display blocks into {@link container}. */
export function renderMarkdownText(
  markdown: string,
  container: HTMLElement,
  options?: RenderMarkdownTextOptions,
): void {
  if (options?.streaming !== true) {
    streamingBlockKeys.delete(container);
    const blocks = parseMarkdownBlocks(markdown);
    container.replaceChildren();
    renderMarkdownBlocks(blocks, container);
    return;
  }

  const blocks = parseMarkdownBlocks(prepareStreamingMarkdown(markdown));
  // Streaming repaints run ~20×/s on the same container. Re-rendering every
  // block each time destroys and recreates the scroll containers inside code
  // fences, which flickers on platforms with classic scrollbars — only the
  // blocks that actually changed (in practice the last one) are redrawn.
  const keys = blocks.map((block) => JSON.stringify(block));
  const prev =
    streamingBlockKeys.get(container)?.length === container.childElementCount
      ? (streamingBlockKeys.get(container) ?? [])
      : [];

  let shared = 0;
  while (
    shared < prev.length &&
    shared < keys.length &&
    prev[shared] === keys[shared]
  ) {
    shared += 1;
  }
  while (container.childElementCount > shared) {
    container.lastElementChild?.remove();
  }
  renderMarkdownBlocks(blocks.slice(shared), container, { streaming: true });
  streamingBlockKeys.set(container, keys);
}

/**
 * Final (non-streaming) Markdown render: awaits Mermaid cards serially before
 * returning so the conversation can wait on diagram completion.
 */
export async function renderMarkdownTextAsync(
  markdown: string,
  container: HTMLElement,
): Promise<void> {
  const blocks = parseMarkdownBlocks(markdown);
  container.replaceChildren();
  await renderMarkdownBlocksAsync(blocks, container);
}
