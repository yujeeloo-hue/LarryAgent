/**
 * Agent-driven line flash (Dev Mode): shared shapes + pure helpers.
 *
 * read_file finishing opens the file and flashes the lines that were read
 * (blue); patch flashes added (green) / deleted (red) lines on the new-file
 * side; a replace-mode write_file (no hunks) washes the whole file (write).
 * One-shot ~1.5s fade, rendered by EditorAreaController decorations.
 * No DOM/Monaco imports here — unit-testable in node.
 */

export type AgentFlashKind = "read" | "add" | "del" | "write";

/** `end: null` = through EOF (resolved against the live model at flash time). */
export type AgentFlashRange = {
  start: number;
  end: number | null;
  kind: AgentFlashKind;
};

/** Read span from tool args — always defined; defaults flash the whole file. */
export type AgentReadRange = { start: number; end: number | null };

/** Max decorations per flash — deep patches collapse to their first runs. */
export const AGENT_FLASH_MAX_RANGES = 24;

/** A flash range after clamping — `end` is always concrete (EOF resolved). */
export type ResolvedFlashRange = {
  start: number;
  end: number;
  kind: AgentFlashKind;
};

/**
 * Clamp against the real line count, resolve `end: null` to EOF, drop
 * empty ranges, merge same-kind neighbours, cap the total. Sorting is the
 * caller's business (patch parsing emits in order).
 */
export function normalizeFlashRanges(
  ranges: readonly AgentFlashRange[],
  lineCount: number,
  cap: number = AGENT_FLASH_MAX_RANGES,
): ResolvedFlashRange[] {
  const clamped: ResolvedFlashRange[] = [];
  for (const range of ranges) {
    if (!Number.isFinite(range.start) || range.start < 1) continue;
    const start = Math.min(Math.floor(range.start), Math.max(1, lineCount));
    const resolvedEnd = Math.min(
      Math.floor(range.end ?? lineCount),
      Math.max(1, lineCount),
    );
    const end = Math.max(start, resolvedEnd);
    const last = clamped[clamped.length - 1];
    if (
      last &&
      last.kind === range.kind &&
      start >= last.start &&
      start <= last.end + 1
    ) {
      last.end = Math.max(last.end, end);
      continue;
    }
    clamped.push({ start, end, kind: range.kind });
  }
  return clamped.slice(0, Math.max(0, cap));
}
