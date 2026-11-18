import { diffLines } from "diff";

export type DiffLineKind = "equal" | "add" | "del";

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

function linesFromChangeValue(value: string): string[] {
  if (value.length === 0) return [];
  const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
  return normalized.split("\n");
}

const LINE_DIFF_BUDGET_CELLS = 1_000_000;
const MIN_LINE_DIFF_EDIT_LENGTH = 64;

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

export function boundedDiffLines(
  before: string,
  after: string,
): ReturnType<typeof diffLines> | null {
  const widest = Math.max(1, countLines(before), countLines(after));
  const maxEditLength = Math.max(
    MIN_LINE_DIFF_EDIT_LENGTH,
    Math.floor(LINE_DIFF_BUDGET_CELLS / widest),
  );
  return diffLines(before, after, { maxEditLength }) ?? null;
}

export function lineNumberAtIndex(text: string, index: number): number {
  let line = 1;
  const end = Math.min(Math.max(0, index), text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export type BuildLineDiffOptions = {
  startOldLine?: number;
  startNewLine?: number;
};

export const EDIT_DIFF_CONTEXT_LINES = 3;

export function buildLineDiff(
  before: string,
  after: string,
  options?: BuildLineDiffOptions,
): DiffLine[] {
  const parts = boundedDiffLines(before, after);
  const out: DiffLine[] = [];
  let oldLine = options?.startOldLine ?? 1;
  let newLine = options?.startNewLine ?? 1;

  if (!parts) {
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

export function buildEditHunkWithContext(
  fileBefore: string,
  fileAfter: string,
  oldString: string,
  newString: string,
  contextLines: number = EDIT_DIFF_CONTEXT_LINES,
): DiffLine[] {
  const index = fileBefore.indexOf(oldString);
  if (index < 0) {
    return buildLineDiff(oldString, newString);
  }

  const startLine = lineNumberAtIndex(fileBefore, index);
  const core = buildLineDiff(oldString, newString, {
    startOldLine: startLine,
    startNewLine: startLine,
  });

  let firstChangeLine = Infinity;
  let lastChangeOld = -Infinity;
  let lastChangeNew = -Infinity;
  for (const line of core) {
    if (line.kind === "equal") continue;
    if (line.oldLine !== null) {
      firstChangeLine = Math.min(firstChangeLine, line.oldLine);
      lastChangeOld = Math.max(lastChangeOld, line.oldLine);
    }
    if (line.newLine !== null) {
      firstChangeLine = Math.min(firstChangeLine, line.newLine);
      lastChangeNew = Math.max(lastChangeNew, line.newLine);
    }
  }

  if (firstChangeLine === Infinity) return core;

  const beforeLines = linesFromChangeValue(fileBefore);
  const afterLines = linesFromChangeValue(fileAfter);
  if (beforeLines.length === 0 && afterLines.length === 0) return core;

  const ctx = Math.max(0, Math.floor(contextLines));
  const ctxStart = Math.max(1, firstChangeLine - ctx);
  const ctxEndOld = Math.min(
    beforeLines.length,
    Math.max(lastChangeOld, firstChangeLine) + ctx,
  );
  const ctxEndNew = Math.min(
    afterLines.length,
    Math.max(lastChangeNew, firstChangeLine) + ctx,
  );

  const beforeSnippet = beforeLines.slice(ctxStart - 1, ctxEndOld).join("\n");
  const afterSnippet = afterLines
    .slice(ctxStart - 1, Math.max(ctxStart - 1, ctxEndNew))
    .join("\n");

  return buildLineDiff(beforeSnippet, afterSnippet, {
    startOldLine: ctxStart,
    startNewLine: ctxStart,
  });
}

export function countLineChanges(
  before: string,
  after: string,
): { added: number; removed: number } {
  const lines = buildLineDiff(before, after);
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "del") removed += 1;
  }
  return { added, removed };
}

export function serializeLineDiff(lines: DiffLine[]): string {
  return JSON.stringify({ lines });
}

