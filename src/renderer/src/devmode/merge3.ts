/**
 * Line-level 3-way merge for Dev Mode's agent↔editor sync (plan decision #8).
 *
 *   base  = tab's last synced content (load / save / merge point)
 *   ours  = user's dirty editor buffer
 *   theirs= agent's new on-disk content
 *
 * Semantics (Socratic-round decision):
 * - hunks that don't collide: both sides' edits kept, automatically
 * - colliding hunks: **theirs wins** — the agent's version of that region
 *   directly replaces the user's (no markers, no dialog); the whole merge
 *   is applied as one editor transaction so a single Cmd+Z reverts it.
 *
 * Implementation: line arrays + an EOF sentinel line (so trailing-newline
 * changes participate in the normal cluster logic) via jsdiff's diffArrays.
 * Insertions are treated as epsilon-width intervals so two insertions at the
 * same point collide (git semantics) while insertion-at-edge-of-replacement
 * only collides when inside/at the start of the replaced range.
 */
import { diffArrays } from "diff";

const EOF_NEWLINE = "\u0000__JB_EOF_NL__";
const EOF_NONE = "\u0000__JB_EOF_NONE__";

export type Merge3Result = {
  merged: string;
  /** Collisions where both sides changed differently (theirs won each). */
  conflictCount: number;
  /** Regions where only the user's edits applied (preserved). */
  oursOnlyCount: number;
  /** Regions where only the agent's edits applied (merged in). */
  theirsOnlyCount: number;
};

type LineSplit = {
  /** Content lines plus the EOF sentinel as the last element. */
  lines: string[];
  eol: "\n" | "\r\n";
};

function splitForMerge(text: string): LineSplit {
  const eol: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
  const eof = text.length > 0 && /\r?\n$/.test(text) ? EOF_NEWLINE : EOF_NONE;
  const body =
    text.length === 0
      ? []
      : eof === EOF_NEWLINE
        ? text.split(/\r?\n/).slice(0, -1)
        : text.split(/\r?\n/);
  return { lines: [...body, eof], eol };
}

function joinFromMerge(lines: string[], eol: string): string {
  const body = lines.filter((l) => l !== EOF_NEWLINE && l !== EOF_NONE);
  const hasTrailingNewline = lines.includes(EOF_NEWLINE);
  if (body.length === 0) return "";
  return body.join(eol) + (hasTrailingNewline ? eol : "");
}

type Hunk = {
  /** Half-open base-line range [start, end). */
  start: number;
  end: number;
  /** Replacement lines (empty = pure deletion). */
  lines: string[];
  /** Pure insertion (empty base range). */
  insert: boolean;
};

/** Diff base→modified into base-coordinate hunks (tolerant of added/removed order). */
function toHunks(oldLines: string[], newLines: string[]): Hunk[] {
  const hunks: Array<
    Hunk & { awaitingAdd?: boolean; awaitingRemove?: boolean }
  > = [];
  let oldIdx = 0;
  for (const change of diffArrays(oldLines, newLines)) {
    const lines = change.value as string[];
    const last = hunks[hunks.length - 1];
    if (change.added) {
      if (last?.awaitingAdd) {
        last.lines = lines;
        last.awaitingAdd = false;
      } else {
        hunks.push({
          start: oldIdx,
          end: oldIdx,
          lines,
          insert: true,
          awaitingRemove: true,
        });
      }
    } else if (change.removed) {
      if (last?.awaitingRemove) {
        // added-first emission of a replace: this removed run sets the range
        last.end = oldIdx + change.count;
        last.insert = false;
        last.awaitingRemove = false;
      } else {
        hunks.push({
          start: oldIdx,
          end: oldIdx + change.count,
          lines: [],
          insert: false,
          awaitingAdd: true,
        });
      }
      oldIdx += change.count;
    } else {
      oldIdx += change.count;
    }
  }
  return hunks.map(({ awaitingAdd: _a, awaitingRemove: _r, ...hunk }) => hunk);
}

/** Virtual interval end: insertions get epsilon width so same-point inserts collide. */
function endV(hunk: Hunk): number {
  return hunk.insert ? hunk.end + 0.5 : hunk.end;
}

type Cluster = {
  start: number;
  end: number;
  endV: number;
  ours: Hunk[];
  theirs: Hunk[];
};

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Apply one side's (non-overlapping, sorted) hunks to a base slice. */
function applyHunks(
  baseLines: readonly string[],
  regionStart: number,
  regionEnd: number,
  hunks: readonly Hunk[],
): string[] {
  const out: string[] = [];
  let cursor = regionStart;
  for (const h of hunks) {
    if (h.start > cursor) out.push(...baseLines.slice(cursor, h.start));
    out.push(...h.lines);
    cursor = Math.max(cursor, h.end);
  }
  if (cursor < regionEnd) out.push(...baseLines.slice(cursor, regionEnd));
  return out;
}

export function merge3(
  base: string,
  ours: string,
  theirs: string,
): Merge3Result {
  const b = splitForMerge(base);
  const ourHunks = toHunks(b.lines, splitForMerge(ours).lines);
  const theirHunks = toHunks(b.lines, splitForMerge(theirs).lines);

  if (ourHunks.length === 0 && theirHunks.length === 0) {
    return {
      merged: base,
      conflictCount: 0,
      oursOnlyCount: 0,
      theirsOnlyCount: 0,
    };
  }

  // Cluster sweep: join hunks whose virtual intervals overlap.
  const tagged = [
    ...ourHunks.map((hunk) => ({ hunk, side: 0 })),
    ...theirHunks.map((hunk) => ({ hunk, side: 1 })),
  ].sort((x, y) => x.hunk.start - y.hunk.start || x.hunk.end - y.hunk.end);

  const clusters: Cluster[] = [];
  for (const { hunk, side } of tagged) {
    const active = clusters[clusters.length - 1];
    if (active && hunk.start < active.endV) {
      active.end = Math.max(active.end, hunk.end);
      active.endV = Math.max(active.endV, endV(hunk));
      (side === 0 ? active.ours : active.theirs).push(hunk);
    } else {
      clusters.push({
        start: hunk.start,
        end: hunk.end,
        endV: endV(hunk),
        ours: side === 0 ? [hunk] : [],
        theirs: side === 1 ? [hunk] : [],
      });
    }
  }

  const out: string[] = [];
  let cursor = 0;
  let conflictCount = 0;
  let oursOnlyCount = 0;
  let theirsOnlyCount = 0;

  for (const cluster of clusters) {
    if (cluster.start > cursor) out.push(...b.lines.slice(cursor, cluster.start));
    const baseSlice = b.lines.slice(cluster.start, cluster.end);
    const ourText = applyHunks(b.lines, cluster.start, cluster.end, cluster.ours);
    const theirText = applyHunks(
      b.lines,
      cluster.start,
      cluster.end,
      cluster.theirs,
    );

    if (arraysEqual(ourText, theirText)) {
      out.push(...ourText);
    } else if (cluster.ours.length === 0 || arraysEqual(ourText, baseSlice)) {
      out.push(...theirText);
      theirsOnlyCount++;
    } else if (cluster.theirs.length === 0 || arraysEqual(theirText, baseSlice)) {
      out.push(...ourText);
      oursOnlyCount++;
    } else {
      // Both changed the same region differently → agent wins (decision #8).
      out.push(...theirText);
      conflictCount++;
    }
    cursor = cluster.end;
  }
  if (cursor < b.lines.length) out.push(...b.lines.slice(cursor));

  return {
    merged: joinFromMerge(out, b.eol),
    conflictCount,
    oursOnlyCount,
    theirsOnlyCount,
  };
}
