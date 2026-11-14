/**
 * Normalize in-progress assistant Markdown so block parsers can render partial
 * output without leaving fences or other block openers dangling.
 */
export function prepareStreamingMarkdown(markdown: string): string {
  if (!markdown) return markdown;

  let prepared = markdown;

  const fenceCount = (prepared.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 === 1) {
    prepared += "\n```";
  }

  return prepared;
}
