import type { DiffLine } from "./diffTypes.js";
import { segmentDiffLines } from "./diffFold.js";

/** One aligned side-by-side row: equal lines share both sides; change rows
 *  pair a deleted (left) with an added (right) line, either may be null. */
export type SideBySideRow =
  | { kind: "equal"; left: DiffLine; right: DiffLine }
  | { kind: "change"; left: DiffLine | null; right: DiffLine | null };

export type SideBySideSegment =
  | { type: "rows"; rows: SideBySideRow[] }
  | { type: "fold"; lines: DiffLine[] };

/**
 * Pair a line diff into side-by-side rows. Consecutive del runs are zipped
 * with the immediately following add run (a "modified" line shows red on the
 * left, green on the right); leftovers get a null side.
 */
export function pairSideBySideRows(lines: DiffLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind === "equal") {
      rows.push({ kind: "equal", left: line, right: line });
      i += 1;
      continue;
    }
    const dels: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === "del") {
      dels.push(lines[i]!);
      i += 1;
    }
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === "add") {
      adds.push(lines[i]!);
      i += 1;
    }
    const pairs = Math.max(dels.length, adds.length);
    for (let k = 0; k < pairs; k += 1) {
      rows.push({
        kind: "change",
        left: dels[k] ?? null,
        right: adds[k] ?? null,
      });
    }
  }
  return rows;
}

/**
 * Split a full-file line diff into visible side-by-side row segments plus
 * foldable equal runs (same context rules as the unified view).
 */
export function buildSideBySideSegments(
  lines: DiffLine[],
  context?: number,
): SideBySideSegment[] {
  const segments: SideBySideSegment[] = [];
  for (const segment of segmentDiffLines(lines, context)) {
    if (segment.type === "fold") {
      segments.push({ type: "fold", lines: segment.lines });
    } else {
      segments.push({ type: "rows", rows: pairSideBySideRows(segment.lines) });
    }
  }
  return segments;
}
