
export type AgentFlashKind = "read" | "add" | "del" | "write";

export type AgentFlashRange = {
  start: number;
  end: number | null;
  kind: AgentFlashKind;
};

export type AgentReadRange = { start: number; end: number | null };

export const AGENT_FLASH_MAX_RANGES = 24;

export type ResolvedFlashRange = {
  start: number;
  end: number;
  kind: AgentFlashKind;
};

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
