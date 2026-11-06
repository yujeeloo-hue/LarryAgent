import type { DiffLine } from "./diffTypes.js";

/** Unchanged lines kept above/below each change hunk. */
export const DIFF_FOLD_CONTEXT = 3;

export type DiffFoldSegment =
  | { type: "lines"; lines: DiffLine[] }
  | { type: "fold"; lines: DiffLine[] };

/**
 * Split a full-file line diff into visible hunks + foldable equal runs.
 * Change lines (add/del) always stay visible; equal lines within
 * {@link DIFF_FOLD_CONTEXT} of a change stay visible; longer equal runs fold.
 */
export function segmentDiffLines(
  lines: DiffLine[],
  context: number = DIFF_FOLD_CONTEXT,
): DiffFoldSegment[] {
  if (lines.length === 0) return [];

  const visible = new Array<boolean>(lines.length).fill(false);
  let hasChange = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.kind === "equal") continue;
    hasChange = true;
    const from = Math.max(0, i - context);
    const to = Math.min(lines.length - 1, i + context);
    for (let j = from; j <= to; j++) visible[j] = true;
  }

  // Pure equal file (no edits) — show everything; nothing useful to fold.
  if (!hasChange) {
    return [{ type: "lines", lines }];
  }

  const segments: DiffFoldSegment[] = [];
  let i = 0;
  while (i < lines.length) {
    if (visible[i]) {
      const chunk: DiffLine[] = [];
      while (i < lines.length && visible[i]) {
        chunk.push(lines[i]!);
        i += 1;
      }
      segments.push({ type: "lines", lines: chunk });
    } else {
      const chunk: DiffLine[] = [];
      while (i < lines.length && !visible[i]) {
        chunk.push(lines[i]!);
        i += 1;
      }
      segments.push({ type: "fold", lines: chunk });
    }
  }
  return segments;
}
