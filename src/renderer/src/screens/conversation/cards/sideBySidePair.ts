import type { DiffLine } from "./diffTypes.js";
import { segmentDiffLines } from "./diffFold.js";

export type SideBySideRow =
  | { kind: "equal"; left: DiffLine; right: DiffLine }
  | { kind: "change"; left: DiffLine | null; right: DiffLine | null };

export type SideBySideSegment =
  | { type: "rows"; rows: SideBySideRow[] }
  | { type: "fold"; lines: DiffLine[] };

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
