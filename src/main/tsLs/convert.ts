import { fuzzyMatches, luaUriToPath } from "../luaLs/convert.js";
import type { TsLsCompletionItem, TsLsLocation, TsLsRange, TsLsResolvedCompletion, TsLsTextEdit } from "./types.js";

export const TS_COMPLETION_LIMIT = 1000;

type LspRange = { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } };

export function tsUriToPath(uri: string): string | null {
  const path = luaUriToPath(uri);
  return path ? path.replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`) : null;
}

export function tsIdentifierPrefixAt(text: string, line: number, column: number): string {
  const content = text.split(/\r?\n/)[line - 1] ?? "";
  const before = content.slice(0, Math.max(0, column - 1));
  return /[A-Za-z_$#][\w$]*$/.exec(before)?.[0] ?? "";
}

function toRange(raw: unknown): TsLsRange | undefined {
  const range = raw as LspRange | undefined;
  const { start, end } = range ?? {};
  if (
    typeof start?.line !== "number" ||
    typeof start.character !== "number" ||
    typeof end?.line !== "number" ||
    typeof end.character !== "number"
  ) {
    return undefined;
  }
  return {
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function textOf(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw || undefined;
  if (raw && typeof raw === "object" && typeof (raw as { value?: unknown }).value === "string") {
    return (raw as { value: string }).value || undefined;
  }
  return undefined;
}

export function toTsTextEdits(raw: unknown): TsLsTextEdit[] {
  if (!Array.isArray(raw)) return [];
  const out: TsLsTextEdit[] = [];
  for (const entry of raw) {
    const edit = entry as { range?: unknown; newText?: unknown } | null;
    const range = toRange(edit?.range);
    if (!range || typeof edit?.newText !== "string") continue;
    out.push({ range, text: edit.newText });
  }
  return out;
}

function editRange(raw: unknown): TsLsRange | undefined {
  const edit = raw as { range?: unknown; replace?: unknown } | undefined;
  return toRange(edit?.range) ?? toRange(edit?.replace);
}

export function toTsCompletionItems(
  raw: unknown,
  prefix: string,
  resolvePrefix: string | null,
  limit = TS_COMPLETION_LIMIT,
): { items: TsLsCompletionItem[]; isIncomplete: boolean } {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : [];
  const serverIncomplete =
    !!raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { isIncomplete?: unknown }).isIncomplete === true;
  const items: TsLsCompletionItem[] = [];
  let truncated = false;
  list.forEach((entry, index) => {
    if (truncated || !entry || typeof entry !== "object") return;
    const item = entry as Record<string, unknown>;
    if (typeof item.label !== "string" || !item.label) return;
    const filterText = typeof item.filterText === "string" ? item.filterText : undefined;
    if (!fuzzyMatches(filterText ?? item.label, prefix.replace(/^#/, ""))) return;
    if (items.length >= limit) {
      truncated = true;
      return;
    }
    const edit = item.textEdit as { newText?: unknown } | undefined;
    const insertText =
      typeof edit?.newText === "string"
        ? edit.newText
        : typeof item.insertText === "string"
          ? item.insertText
          : item.label;
    const range = editRange(item.textEdit);
    const detail = typeof item.detail === "string" && item.detail ? item.detail : undefined;
    const documentation = textOf(item.documentation);
    const additionalEdits = toTsTextEdits(item.additionalTextEdits);
    items.push({
      label: item.label,
      kind: typeof item.kind === "number" ? item.kind : 1,
      insertText,
      isSnippet: item.insertTextFormat === 2,
      ...(range ? { range } : {}),
      ...(detail ? { detail } : {}),
      ...(documentation ? { documentation } : {}),
      ...(typeof item.sortText === "string" ? { sortText: item.sortText } : {}),
      ...(filterText ? { filterText } : {}),
      ...(additionalEdits.length > 0 ? { additionalEdits } : {}),
      ...(resolvePrefix !== null ? { resolveId: `${resolvePrefix}:${index}` } : {}),
    });
  });
  return { items, isIncomplete: truncated || serverIncomplete };
}

export function toTsResolvedCompletion(raw: unknown): TsLsResolvedCompletion {
  if (!raw || typeof raw !== "object") return {};
  const item = raw as Record<string, unknown>;
  const detail = typeof item.detail === "string" && item.detail ? item.detail : undefined;
  const documentation = textOf(item.documentation);
  const additionalEdits = toTsTextEdits(item.additionalTextEdits);
  return {
    ...(detail ? { detail } : {}),
    ...(documentation ? { documentation } : {}),
    ...(additionalEdits.length > 0 ? { additionalEdits } : {}),
  };
}

export function toTsLocations(raw: unknown): TsLsLocation[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: TsLsLocation[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const loc = entry as { uri?: unknown; targetUri?: unknown; range?: unknown; targetSelectionRange?: unknown };
    const uri = typeof loc.uri === "string" ? loc.uri : typeof loc.targetUri === "string" ? loc.targetUri : null;
    const range = toRange(loc.targetSelectionRange ?? loc.range);
    if (!uri || !range) continue;
    const path = tsUriToPath(uri);
    if (!path) continue;
    out.push({ path, line: range.startLine, column: range.startColumn });
  }
  return out;
}
