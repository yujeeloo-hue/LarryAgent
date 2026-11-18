import { prepareStreamingMarkdown } from "../../markdown/prepareStreamingMarkdown.js";
import { parseMarkdownBlocks } from "../../markdown/parseMarkdownBlocks.js";
import {
  renderMarkdownBlocks,
  renderMarkdownBlocksAsync,
} from "./cards/MarkdownBlocksView.js";

export type RenderMarkdownTextOptions = {
  streaming?: boolean;
};

const streamingBlockKeys = new WeakMap<HTMLElement, string[]>();

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

export async function renderMarkdownTextAsync(
  markdown: string,
  container: HTMLElement,
): Promise<void> {
  const blocks = parseMarkdownBlocks(markdown);
  container.replaceChildren();
  await renderMarkdownBlocksAsync(blocks, container);
}
