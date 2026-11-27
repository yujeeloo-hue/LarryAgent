import { fileURLToPath, pathToFileURL } from "node:url";
import type { LuaLsCompletionItem, LuaLsLocation } from "./types.js";

export const LUA_COMPLETION_LIMIT = 1000;

export function luaFileUri(path: string): string {
  return pathToFileURL(path).href;
}

export function luaUriToPath(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function textOf(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw || undefined;
  if (raw && typeof raw === "object" && typeof (raw as { value?: unknown }).value === "string") {
    return (raw as { value: string }).value || undefined;
  }
  return undefined;
}

export function identifierPrefixAt(text: string, line: number, column: number): string {
  const content = text.split(/\r?\n/)[line - 1] ?? "";
  const before = content.slice(0, Math.max(0, column - 1));
  return /[A-Za-z_][\w]*$/.exec(before)?.[0] ?? "";
}

export function fuzzyMatches(candidate: string, prefix: string): boolean {
  if (!prefix) return true;
  const hay = candidate.toLowerCase();
  let at = 0;
  for (const ch of prefix.toLowerCase()) {
    at = hay.indexOf(ch, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
}

export function toLuaCompletionItems(
  raw: unknown,
  prefix: string,
  limit = LUA_COMPLETION_LIMIT,
): { items: LuaLsCompletionItem[]; isIncomplete: boolean } {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : [];
  const serverIncomplete =
    !!raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { isIncomplete?: unknown }).isIncomplete === true;
  const items: LuaLsCompletionItem[] = [];
  let truncated = false;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.label !== "string" || !item.label) continue;
    const filterText = typeof item.filterText === "string" ? item.filterText : undefined;
    if (!fuzzyMatches(filterText ?? item.label, prefix)) continue;
    if (items.length >= limit) {
      truncated = true;
      break;
    }
    const edit = item.textEdit as { newText?: unknown } | undefined;
    const insertText =
      typeof edit?.newText === "string"
        ? edit.newText
        : typeof item.insertText === "string"
          ? item.insertText
          : item.label;
    const detail = typeof item.detail === "string" && item.detail ? item.detail : undefined;
    const documentation = textOf(item.documentation);
    items.push({
      label: item.label,
      kind: typeof item.kind === "number" ? item.kind : 1,
      insertText,
      isSnippet: item.insertTextFormat === 2,
      ...(detail ? { detail } : {}),
      ...(documentation ? { documentation } : {}),
      ...(typeof item.sortText === "string" ? { sortText: item.sortText } : {}),
      ...(filterText ? { filterText } : {}),
    });
  }
  return { items, isIncomplete: truncated || serverIncomplete };
}

export type SemanticLegend = { tokenTypes: readonly string[]; tokenModifiers: readonly string[] };

export function readSemanticLegend(capabilities: Record<string, unknown> | null): SemanticLegend | null {
  const provider = capabilities?.semanticTokensProvider as { legend?: unknown } | undefined;
  const legend = provider?.legend as { tokenTypes?: unknown; tokenModifiers?: unknown } | undefined;
  if (!Array.isArray(legend?.tokenTypes)) return null;
  return {
    tokenTypes: legend.tokenTypes.filter((t): t is string => typeof t === "string"),
    tokenModifiers: Array.isArray(legend.tokenModifiers)
      ? legend.tokenModifiers.filter((m): m is string => typeof m === "string")
      : [],
  };
}

export function remapSemanticTokens(raw: unknown, server: SemanticLegend, client: SemanticLegend): number[] {
  const data = (raw as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const typeMap = server.tokenTypes.map((type) => client.tokenTypes.indexOf(type));
  const modifierMap = server.tokenModifiers.map((modifier) => client.tokenModifiers.indexOf(modifier));
  const out: number[] = [];
  let line = 0;
  let start = 0;
  let lastLine = 0;
  let lastStart = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const [deltaLine, deltaStart, length, type, modifiers] = data.slice(i, i + 5) as number[];
    line += deltaLine!;
    start = deltaLine === 0 ? start + deltaStart! : deltaStart!;
    const mapped = typeMap[type!] ?? -1;
    if (mapped < 0) continue;
    let bits = 0;
    for (let bit = 0; bit < modifierMap.length; bit++) {
      const target = modifierMap[bit]!;
      if (target >= 0 && (modifiers! & (1 << bit)) !== 0) bits |= 1 << target;
    }
    out.push(line - lastLine, line === lastLine ? start - lastStart : start, length!, mapped, bits);
    lastLine = line;
    lastStart = start;
  }
  return out;
}

export function luaHoverMarkdown(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const contents = (raw as { contents?: unknown }).contents;
  const parts = Array.isArray(contents) ? contents : [contents];
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      if (part) out.push(part);
    } else if (part && typeof part === "object") {
      const { value, language } = part as { value?: unknown; language?: unknown };
      if (typeof value !== "string" || !value) continue;
      out.push(typeof language === "string" ? `\`\`\`${language}\n${value}\n\`\`\`` : value);
    }
  }
  const markdown = out.join("\n\n").trim();
  return markdown ? markdown : null;
}

export function toLuaLocations(raw: unknown): LuaLsLocation[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: LuaLsLocation[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const loc = entry as { uri?: unknown; targetUri?: unknown; range?: unknown; targetSelectionRange?: unknown };
    const uri = typeof loc.uri === "string" ? loc.uri : typeof loc.targetUri === "string" ? loc.targetUri : null;
    const range = (loc.range ?? loc.targetSelectionRange) as { start?: { line?: unknown; character?: unknown } } | undefined;
    const start = range?.start;
    if (!uri || typeof start?.line !== "number" || typeof start.character !== "number") continue;
    const path = luaUriToPath(uri);
    if (!path) continue;
    out.push({ path, line: start.line + 1, column: start.character + 1 });
  }
  return out;
}
