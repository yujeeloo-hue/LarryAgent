export type LspRange = {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
};

export type LspTextEdit = LspRange & { newText: string };

export type LspFileEdit = { path: string; edits: LspTextEdit[] };

export type LspWorkspaceEditResult =
  | { ok: true; files: LspFileEdit[] }
  | { ok: false; message: string };

export const RENAME_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const MALFORMED_EDIT = "Language server returned a rename edit that could not be read.";

function positionOf(raw: unknown): { line: number; character: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const { line, character } = raw as { line?: unknown; character?: unknown };
  return typeof line === "number" && typeof character === "number" ? { line, character } : null;
}

export function lspRangeOf(raw: unknown): LspRange | null {
  if (!raw || typeof raw !== "object") return null;
  const { start, end } = raw as { start?: unknown; end?: unknown };
  const s = positionOf(start);
  const e = positionOf(end ?? start);
  if (!s || !e) return null;
  return {
    line: s.line + 1,
    column: s.character + 1,
    endLine: e.line + 1,
    endColumn: e.character + 1,
  };
}

function textEditOf(raw: unknown): LspTextEdit | null {
  if (!raw || typeof raw !== "object") return null;
  const { range, newText } = raw as { range?: unknown; newText?: unknown };
  const parsed = lspRangeOf(range);
  if (!parsed || typeof newText !== "string") return null;
  return { ...parsed, newText };
}

export function parsePrepareRenameResult(raw: unknown): { range: LspRange | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { defaultBehavior?: unknown; range?: unknown; start?: unknown };
  if (value.defaultBehavior !== undefined) return { range: null };
  if (value.range !== undefined) {
    const range = lspRangeOf(value.range);
    return range ? { range } : null;
  }
  const range = lspRangeOf(value);
  return range ? { range } : null;
}

export function parseWorkspaceEdit(
  raw: unknown,
  uriToPath: (uri: string) => string | null,
): LspWorkspaceEditResult {
  if (raw === null || raw === undefined) return { ok: true, files: [] };
  if (typeof raw !== "object") return { ok: false, message: MALFORMED_EDIT };
  const { changes, documentChanges } = raw as { changes?: unknown; documentChanges?: unknown };
  const byPath = new Map<string, LspTextEdit[]>();
  const seen = new Set<string>();
  let failure: string | null = null;

  const addFile = (uri: unknown, edits: unknown): void => {
    if (failure) return;
    if (typeof uri !== "string" || !Array.isArray(edits)) {
      failure = MALFORMED_EDIT;
      return;
    }
    const path = uriToPath(uri);
    if (!path) {
      failure = `Rename would change a file that cannot be opened (${uri}). Nothing was changed.`;
      return;
    }
    const list = byPath.get(path) ?? [];
    for (const entry of edits) {
      const parsed = textEditOf(entry);
      if (!parsed) {
        failure = MALFORMED_EDIT;
        return;
      }
      const key = `${path}\u0000${JSON.stringify(parsed)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(parsed);
    }
    byPath.set(path, list);
  };

  if (changes && typeof changes === "object" && !Array.isArray(changes)) {
    for (const [uri, edits] of Object.entries(changes)) addFile(uri, edits);
  }
  if (Array.isArray(documentChanges)) {
    for (const change of documentChanges as unknown[]) {
      if (!change || typeof change !== "object") {
        failure = MALFORMED_EDIT;
        break;
      }
      const entry = change as { kind?: unknown; textDocument?: { uri?: unknown }; edits?: unknown };
      if (entry.kind !== undefined) {
        failure = "Rename would create, move or delete files, which is not supported. Nothing was changed.";
        break;
      }
      addFile(entry.textDocument?.uri, entry.edits);
    }
  }
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    files: [...byPath.entries()]
      .filter(([, edits]) => edits.length > 0)
      .map(([path, edits]) => ({ path, edits })),
  };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function offsetOf(text: string, starts: readonly number[], line: number, column: number): number {
  if (line < 1 || line > starts.length || column < 1) {
    throw new Error("Rename edit is outside the file.");
  }
  const lineStart = starts[line - 1]!;
  const lineEnd = line < starts.length ? starts[line]! : text.length;
  let contentEnd = lineEnd;
  if (contentEnd > lineStart && text.charCodeAt(contentEnd - 1) === 10) contentEnd -= 1;
  if (contentEnd > lineStart && text.charCodeAt(contentEnd - 1) === 13) contentEnd -= 1;
  if (column - 1 > contentEnd - lineStart) {
    throw new Error("Rename edit is outside the file.");
  }
  return lineStart + column - 1;
}

export function lspRangeText(text: string, range: LspRange): string {
  const starts = lineStarts(text);
  const start = offsetOf(text, starts, range.line, range.column);
  const end = offsetOf(text, starts, range.endLine, range.endColumn);
  if (end < start) throw new Error("Rename edit is outside the file.");
  return text.slice(start, end);
}

export function applyLspTextEdits(text: string, edits: readonly LspTextEdit[]): string {
  const starts = lineStarts(text);
  const resolved = edits
    .map((edit) => ({
      start: offsetOf(text, starts, edit.line, edit.column),
      end: offsetOf(text, starts, edit.endLine, edit.endColumn),
      newText: edit.newText,
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let cursor = 0;
  for (const edit of resolved) {
    if (edit.end < edit.start || edit.start < cursor) {
      throw new Error("Overlapping rename edits.");
    }
    out += text.slice(cursor, edit.start) + edit.newText;
    cursor = edit.end;
  }
  return out + text.slice(cursor);
}
