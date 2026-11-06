import { boundedDiffLines } from "../../../../../tools/lineDiff.js";
import type { DiffLine } from "./diffTypes.js";

function linesFromChangeValue(value: string): string[] {
  if (value.length === 0) return [];
  const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
  return normalized.split("\n");
}

export type BuildHunkLineDiffOptions = {
  /** 1-based starting line in the old file (default 1). */
  startOldLine?: number;
  /** 1-based starting line in the new file (default 1). */
  startNewLine?: number;
};

/**
 * Build a line-oriented hunk diff for UI (add / del / equal).
 * Line numbers default to snippet-relative (start at 1); pass start* for
 * absolute file line numbers when known.
 */
export function buildHunkLineDiff(
  before: string,
  after: string,
  options?: BuildHunkLineDiffOptions,
): DiffLine[] {
  const parts = boundedDiffLines(before, after);
  const out: DiffLine[] = [];
  let oldLine = options?.startOldLine ?? 1;
  let newLine = options?.startNewLine ?? 1;

  if (!parts) {
    // Too dissimilar to align within the budget — render a whole-block replace
    // rather than freezing the renderer on an oversized Myers search.
    for (const text of linesFromChangeValue(before)) {
      out.push({ kind: "del", text, oldLine: oldLine++, newLine: null });
    }
    for (const text of linesFromChangeValue(after)) {
      out.push({ kind: "add", text, oldLine: null, newLine: newLine++ });
    }
    return out;
  }

  for (const part of parts) {
    const lines = linesFromChangeValue(part.value);
    if (part.added) {
      for (const text of lines) {
        out.push({ kind: "add", text, oldLine: null, newLine: newLine++ });
      }
    } else if (part.removed) {
      for (const text of lines) {
        out.push({ kind: "del", text, oldLine: oldLine++, newLine: null });
      }
    } else {
      for (const text of lines) {
        out.push({
          kind: "equal",
          text,
          oldLine: oldLine++,
          newLine: newLine++,
        });
      }
    }
  }

  return out;
}

/** Count inserted / deleted lines between two snippets. */
export function countHunkLineChanges(
  before: string,
  after: string,
): { added: number; removed: number } {
  const lines = buildHunkLineDiff(before, after);
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "del") removed += 1;
  }
  return { added, removed };
}

export function editStringsFromArgs(args: unknown): {
  path?: string;
  oldString: string;
  newString: string;
} | null {
  if (!args || typeof args !== "object") return null;
  const raw = args as Record<string, unknown>;
  if (typeof raw.old_string !== "string" || typeof raw.new_string !== "string") {
    return null;
  }
  return {
    ...(typeof raw.path === "string" ? { path: raw.path } : {}),
    oldString: raw.old_string,
    newString: raw.new_string,
  };
}
