import { rankSymbols, type RankFile, type RankSymbol } from "./quickOpenRank.js";

export type QuickOpenCategory = "All" | "Files" | "Types" | "Symbols" | "Text";

export const QUICK_OPEN_CATEGORIES: readonly QuickOpenCategory[] = [
  "All",
  "Files",
  "Types",
  "Symbols",
  "Text",
];

export type QuickOpenSymbolSource = "semantic" | "index";

export type QuickOpenTextHit = {
  path: string;
  rel: string;
  line: number;
  column: number;
  preview: string;
};

export type QuickOpenEntry =
  | { kind: "file"; path: string; rel: string }
  | {
      kind: "symbol";
      source: QuickOpenSymbolSource;
      name: string;
      path: string;
      rel: string;
      line: number;
      symbolKind: string;
      container?: string;
    }
  | {
      kind: "text";
      path: string;
      rel: string;
      line: number;
      column: number;
      preview: string;
    };

export type QuickOpenLayers = {
  semantic: readonly RankSymbol[];
  index: readonly RankSymbol[];
  text: readonly QuickOpenTextHit[];
  files: readonly RankFile[];
};

export type QuickOpenMergeLimits = {
  symbols: number;
  text: number;
  textOnly: number;
  files: number;
};

export const QUICK_OPEN_LIMITS: QuickOpenMergeLimits = {
  symbols: 30,
  text: 20,
  textOnly: 100,
  files: 50,
};

const TYPE_KINDS = new Set([
  "class",
  "struct",
  "interface",
  "enum",
  "type",
  "typealias",
  "record",
  "delegate",
  "trait",
]);

export function isTypeEntry(entry: QuickOpenEntry): boolean {
  return entry.kind === "symbol" && TYPE_KINDS.has(entry.symbolKind.toLowerCase());
}

export function quickOpenEntryKey(entry: QuickOpenEntry): string {
  if (entry.kind === "file") return `file|${entry.path}`;
  if (entry.kind === "text") return `text|${entry.path}|${entry.line}|${entry.column}`;
  return `symbol|${entry.name}|${entry.path}|${entry.line}`;
}

export function reselectQuickOpenIndex(
  pinnedKey: string | null,
  results: readonly QuickOpenEntry[],
  previousIndex: number,
): number {
  if (results.length === 0) return 0;
  if (pinnedKey !== null) {
    const index = results.findIndex((entry) => quickOpenEntryKey(entry) === pinnedKey);
    if (index >= 0) return index;
  }
  return Math.min(Math.max(0, previousIndex), results.length - 1);
}

function locationKey(path: string, line: number): string {
  return `${path.replace(/\\/g, "/").toLowerCase()}|${line}`;
}

function symbolMatchesCategory(symbol: RankSymbol, category: QuickOpenCategory): boolean {
  if (category === "All") return true;
  const type = TYPE_KINDS.has(symbol.symbolKind.toLowerCase());
  if (category === "Types") return type;
  if (category === "Symbols") return !type;
  return false;
}

function typesFirst(symbols: readonly RankSymbol[]): RankSymbol[] {
  const isType = (symbol: RankSymbol) => TYPE_KINDS.has(symbol.symbolKind.toLowerCase());
  return [...symbols.filter(isType), ...symbols.filter((symbol) => !isType(symbol))];
}

export function mergeQuickOpenLayers(input: {
  layers: QuickOpenLayers;
  query: string;
  category: QuickOpenCategory;
  keepSymbol?: (symbol: RankSymbol) => boolean;
  limits?: QuickOpenMergeLimits;
}): QuickOpenEntry[] {
  const limits = input.limits ?? QUICK_OPEN_LIMITS;
  const category = input.category;
  const keep = (symbol: RankSymbol) =>
    symbolMatchesCategory(symbol, category) && (input.keepSymbol?.(symbol) ?? true);
  const out: QuickOpenEntry[] = [];
  const located = new Set<string>();

  if (category === "All" || category === "Types" || category === "Symbols") {
    const semantic = typesFirst(rankSymbols(input.layers.semantic.filter(keep), input.query, limits.symbols));
    for (const symbol of semantic) {
      out.push({ kind: "symbol", source: "semantic", ...symbol });
      located.add(locationKey(symbol.path, symbol.line));
    }
    const room = limits.symbols - semantic.length;
    if (room > 0) {
      const fresh = input.layers.index.filter(
        (symbol) => keep(symbol) && !located.has(locationKey(symbol.path, symbol.line)),
      );
      for (const symbol of typesFirst(rankSymbols(fresh, input.query, room))) {
        out.push({ kind: "symbol", source: "index", ...symbol });
        located.add(locationKey(symbol.path, symbol.line));
      }
    }
  }

  if (category === "All" || category === "Text") {
    const cap = category === "Text" ? limits.textOnly : limits.text;
    let added = 0;
    for (const hit of input.layers.text) {
      if (added >= cap) break;
      const key = locationKey(hit.path, hit.line);
      if (located.has(key)) continue;
      located.add(key);
      out.push({ kind: "text", ...hit });
      added++;
    }
  }

  if (category === "All" || category === "Files") {
    for (const file of input.layers.files.slice(0, limits.files)) {
      out.push({ kind: "file", path: file.path, rel: file.rel });
    }
  }
  return out;
}

export function quickOpenGroupLabel(entry: QuickOpenEntry): string {
  if (entry.kind === "file") return "Files";
  if (entry.kind === "text") return "Text";
  return entry.source === "semantic" ? "Semantic" : "Symbols";
}
