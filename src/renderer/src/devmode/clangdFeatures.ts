/**
 * clangd-backed language features for the (Unreal) C++ editing experience.
 *
 * Thin adapter over the `clangd:*` preload bridge: when the workspace has a
 * compile_commands.json, clangd answers completion / hover / signature help
 * / definition / references with compiler accuracy; the text-level
 * cppSymbols providers stay registered and serve as the fallback when
 * clangd is unavailable (null/[] results let them take over).
 *
 * Pure helpers are exported for node --test; monaco types stay structural.
 */

import type { CppGotoTarget } from "./cppLanguageFeatures.js";
import { modelUriToPath } from "./cppLanguageFeatures.js";
import { resolveEnclosingContainer } from "./cppContainerContext.js";
import { compactParameterDocumentation, compactSignatureLabel, formatCompactHover, semanticHoverParts, type CompactSignature } from "./compactLanguagePopover.js";
import {
  localNamesInScope,
  quickBareCompletionItems,
  buildTextCompletionItems,
  callContextAt,
  commonTypeHits,
  completionContextAt,
  completionFilterText,
  matchesTypedPrefix,
  controlFlowSnippets,
  detectBraceStyle,
  keywordItems,
  localTypeOf,
  signatureFromHit,
  ueMacroHits,
  type CppCompletionContext,
  type CppIndexCompletionHit,
  type CppTextCompletionItem,
} from "./cppTextCompletion.js";

/** clangd keyword / code-pattern items replaced by our block snippets. */
const CONTROL_KEYWORDS = new Set(["if", "else", "for", "while", "do", "switch"]);

/**
 * Cached bare-identifier rows kept as the typed word grows. Locals (band 1)
 * and keywords (band 5) are rebuilt every keystroke. `ANFCharacter` stays
 * visible while the word is `NFCharacter`.
 */
export function retainCachedCompletionItem(
  item: { label: string; sortText: string },
  prefix: string,
): boolean {
  const band = item.sortText[0];
  if (band === "1" || band === "5") return false;
  return matchesTypedPrefix(item.label, prefix);
}

export type ClangdPositionRequestInput = {
  path: string;
  line: number;
  column?: number;
  symbol?: string;
  text?: string;
  triggerCharacter?: string;
};

type ClangdBridge = {
  clangdStatus: (rootPath: string) => Promise<{ ok: boolean }>;
  clangdReferences: (
    rootPath: string,
    request: ClangdPositionRequestInput,
  ) => Promise<
    | {
        ok: true;
        references: {
          path: string;
          line: number;
          column: number;
          endLine: number;
          endColumn: number;
        }[];
      }
    | { ok: false; message: string }
  >;
  clangdDefinition: (
    rootPath: string,
    request: ClangdPositionRequestInput,
    queryId?: string,
  ) => Promise<
    | { ok: true; definitions: { path: string; line: number; column: number }[] }
    | { ok: false; message: string }
  >;
  clangdCancelQuery: (queryId: string) => Promise<boolean>;
  clangdWorkspaceSymbols: (
    rootPath: string,
    query: string,
  ) => Promise<
    | {
        ok: true;
        symbols: {
          name: string;
          path: string;
          line: number;
          column: number;
          symbolKind: string;
          container?: string;
        }[];
      }
    | { ok: false; message: string }
  >;
  clangdHover: (
    rootPath: string,
    request: ClangdPositionRequestInput,
  ) => Promise<{ ok: true; markdown: string | null } | { ok: false; message: string }>;
  clangdCompletion: (
    rootPath: string,
    request: ClangdPositionRequestInput,
    queryId?: string,
  ) => Promise<
    | {
        ok: true;
        items: {
          label: string;
          kind: number;
          detail?: string;
          documentation?: string;
          signature?: string;
          insertText?: string;
          isSnippet?: boolean;
          sortText?: string;
          filterText?: string;
        }[];
        isIncomplete?: boolean;
      }
    | { ok: false; message: string }
  >;
  clangdSignatureHelp: (
    rootPath: string,
    request: ClangdPositionRequestInput,
  ) => Promise<
    | {
        ok: true;
        signatures: CompactSignature[];
        activeSignature?: number;
      }
    | { ok: false; message: string }
  >;
};

function bridge(): ClangdBridge | null {
  const jb = (window as { jellybot?: Partial<ClangdBridge> }).jellybot;
  if (
    !jb?.clangdStatus ||
    !jb.clangdReferences ||
    !jb.clangdDefinition ||
    !jb.clangdCancelQuery ||
    !jb.clangdWorkspaceSymbols ||
    !jb.clangdHover ||
    !jb.clangdCompletion ||
    !jb.clangdSignatureHelp
  ) {
    return null;
  }
  return jb as ClangdBridge;
}

// "Available" is sticky per workspace root; "unavailable" is re-probed after
// a short TTL (compile db generated / clangd downloaded mid-session).
const availabilityCache = new Map<string, { ok: boolean; at: number }>();
const UNAVAILABLE_RETRY_MS = 15_000;

export function resetClangdAvailabilityCache(): void {
  availabilityCache.clear();
}

export async function clangdAvailable(rootPath: string): Promise<boolean> {
  const cached = availabilityCache.get(rootPath);
  if (cached && (cached.ok || Date.now() - cached.at < UNAVAILABLE_RETRY_MS)) {
    return cached.ok;
  }
  const api = bridge();
  let available = false;
  if (api) {
    try {
      available = (await api.clangdStatus(rootPath)).ok;
    } catch {
      available = false;
    }
  }
  availabilityCache.set(rootPath, { ok: available, at: Date.now() });
  return available;
}

/** Shared with the workspace provider so Monaco receives one symbol hover. */
export async function clangdSymbolHover(root: string, model: MinimalModel, position: MinimalPosition): Promise<string | null> {
  const api = bridge();
  const request = requestFor(model, position);
  if (!api || !request || !(await clangdAvailable(root))) return null;
  try {
    const result = await withDeadline(api.clangdHover(root, request), 350);
    return result?.ok ? result.markdown : null;
  } catch { return null; }
}

export function compactSignatureInformation(sig: CompactSignature, activeParameter: number) {
  const label = compactSignatureLabel(sig.label, sig.parameters);
  const active = Math.max(0, Math.min(sig.activeParameter ?? activeParameter, Math.max(0, sig.parameters.length - 1)));
  const paramDocs = sig.parameterDocumentation?.[active];
  return {
    label,
    activeParameter: active,
    ...(sig.documentation && !paramDocs ? { documentation: { value: sig.documentation } } : {}),
    parameters: signatureParameterRanges(label, sig.parameters).map((range, i) => ({
      label: range,
      documentation: {
        value: compactParameterDocumentation(sig.parameters[i]!, i, sig.parameters.length, sig.parameterDocumentation?.[i]),
        supportHtml: true,
      },
    })),
  };
}

// ------------------------------------------------------------ LSP → monaco

/** LSP CompletionItemKind (1-based) → monaco.languages.CompletionItemKind. */
export const COMPLETION_KIND_MAP: Record<number, number> = {
  1: 18, // Text
  2: 0, // Method
  3: 1, // Function
  4: 2, // Constructor
  5: 3, // Field
  6: 4, // Variable
  7: 5, // Class
  8: 7, // Interface
  9: 8, // Module
  10: 9, // Property
  11: 12, // Unit
  12: 13, // Value
  13: 15, // Enum
  14: 17, // Keyword
  15: 28, // Snippet
  16: 19, // Color
  17: 20, // File
  18: 21, // Reference
  19: 23, // Folder
  20: 16, // EnumMember
  21: 14, // Constant
  22: 6, // Struct
  23: 10, // Event
  24: 11, // Operator
  25: 24, // TypeParameter
};

/** LSP Method / Function / Constructor. */
const CALLABLE_LSP_KINDS = new Set([2, 3, 4]);

export type MinimalModel = {
  getValue(): string;
  getOffsetAt(position: { lineNumber: number; column: number }): number;
  getWordAtPosition(position: {
    lineNumber: number;
    column: number;
  }): { word: string; startColumn: number; endColumn: number } | null;
  getLineContent?(lineNumber: number): string;
  uri: { scheme: string; path: string };
};

export type MinimalPosition = { lineNumber: number; column: number };

function requestFor(
  model: MinimalModel,
  position: MinimalPosition,
): ClangdPositionRequestInput | null {
  const path = modelUriToPath(model.uri);
  if (!path) return null;
  return {
    path,
    line: position.lineNumber,
    column: position.column,
    text: model.getValue(),
  };
}

// ------------------------------------------------------------ insert text

const OPEN_FOR: Record<string, string> = { ")": "(", ">": "<", "]": "[", "}": "{" };

/** Index of the bracket opening the group that closes at `end`, or -1. */
function matchingOpenIndex(text: string, end: number): number {
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    const ch = text[i]!;
    if (ch in OPEN_FOR) depth++;
    else if (ch === "(" || ch === "<" || ch === "[" || ch === "{") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export type ClangdInsertion = {
  insertText: string;
  isSnippet: boolean;
  /** Open parameter info after insert (call with arguments). */
  showParameterHints: boolean;
};

/**
 * Rider-style insertion for one clangd completion item. clangd's snippet
 * pre-fills every argument (`Foo(${1:int A}, ${2:float B})`); instead the
 * call becomes `Foo(|)` with parameter info when it takes arguments, or
 * `Foo()|` when it takes none. A trailing template argument list collapses
 * the same way (`TArray<|>`). Non-snippet items insert clangd's text as-is.
 */
export function clangdInsertFor(item: {
  label: string;
  kind: number;
  insertText?: string;
  isSnippet?: boolean;
}): ClangdInsertion {
  const base = item.insertText ?? item.label;
  if (!item.isSnippet) {
    return { insertText: base, isSnippet: false, showParameterHints: false };
  }
  const text = base.replace(/\$0$/, "");
  const close = text[text.length - 1];
  const open = close ? OPEN_FOR[close] : undefined;
  if (open === "(" || open === "<") {
    const openIndex = matchingOpenIndex(text, text.length - 1);
    if (openIndex > 0 && text[openIndex] === open) {
      const prefix = text.slice(0, openIndex);
      const inner = text.slice(openIndex + 1, -1).trim();
      const hasArgs = inner !== "";
      if (open === "(") {
        return {
          insertText: `${prefix}${hasArgs ? "($0)" : "()"}`,
          isSnippet: true,
          showParameterHints: hasArgs && CALLABLE_LSP_KINDS.has(item.kind),
        };
      }
      return {
        insertText: `${prefix}${hasArgs ? "<$0>" : "<>"}`,
        isSnippet: true,
        showParameterHints: false,
      };
    }
  }
  return { insertText: base, isSnippet: true, showParameterHints: false };
}

/**
 * Monaco highlights the active parameter by `[start, end)` offsets into the
 * signature label; locate each parameter left-to-right after the `(`.
 */
export function signatureParameterRanges(
  label: string,
  parameters: string[],
): [number, number][] {
  const paren = label.indexOf("(");
  let from = paren < 0 ? 0 : paren + 1;
  return parameters.map((param) => {
    if (!param) return [0, 0];
    const index = label.indexOf(param, from);
    if (index < 0) return [0, 0];
    from = index + param.length;
    return [index, from];
  });
}

// ---------------------------------------------------------------- queries

/** F12 targets from clangd (null = unavailable; [] = no semantic target). */
export async function clangdGotoDefinition(
  rootPath: string,
  model: MinimalModel,
  position: MinimalPosition,
  signal?: AbortSignal,
): Promise<CppGotoTarget[] | null> {
  const api = bridge();
  const request = requestFor(model, position);
  if (!api || !(await clangdAvailable(rootPath)) || !request) return null;
  // No wall-clock timeout: cold UE headers can pay a 30s+ preamble build.
  // The caller cancels via `signal` (ESC) — relayed to clangd $/cancelRequest.
  const queryId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `q-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (signal) {
    if (signal.aborted) return null;
    signal.addEventListener(
      "abort",
      () => {
        void api.clangdCancelQuery(queryId).catch(() => {});
      },
      { once: true },
    );
  }
  try {
    const result = await api.clangdDefinition(rootPath, request, queryId);
    if (!result.ok) return null;
    return result.definitions.map((def) => ({ path: def.path, line: def.line }));
  } catch {
    return null;
  }
}

/**
 * Whole-index symbol lookup (`workspace/symbol`) for Quick Open — catches
 * macro-generated types (UHT delegates etc.) the text scanner cannot see.
 * Returns [] when clangd is unavailable or the query fails.
 */
export async function clangdWorkspaceSymbols(
  rootPath: string,
  query: string,
): Promise<
  Array<{ name: string; path: string; line: number; column: number; symbolKind: string; container?: string }>
> {
  const api = bridge();
  if (!api || !query.trim()) return [];
  if (!(await clangdAvailable(rootPath))) return [];
  try {
    const result = await api.clangdWorkspaceSymbols(rootPath, query);
    if (!result.ok) return [];
    return result.symbols;
  } catch {
    return [];
  }
}

/** Semantic references for Find Usages (Shift+F12). */
export async function clangdFindReferences(
  rootPath: string,
  model: MinimalModel,
  position: MinimalPosition,
): Promise<
  | { path: string; line: number; column: number }[]
  | null
> {
  const api = bridge();
  const request = requestFor(model, position);
  if (!api || !(await clangdAvailable(rootPath)) || !request) return null;
  try {
    const result = await api.clangdReferences(rootPath, request);
    if (!result.ok) return null;
    return result.references.map((ref) => ({
      path: ref.path,
      line: ref.line,
      column: ref.column,
    }));
  } catch {
    return null;
  }
}

// ------------------------------------------------------- monaco providers

export type ClangdMonacoLike = {
  languages: {
    registerCompletionItemProvider(
      languageId: string,
      provider: unknown,
    ): { dispose(): void };
    registerHoverProvider(
      languageId: string,
      provider: unknown,
    ): { dispose(): void };
    registerSignatureHelpProvider(
      languageId: string,
      provider: unknown,
    ): { dispose(): void };
  };
  /** monaco.languages.CompletionItemKind-shaped enum holder. */
  CompletionItemKind?: Record<string, number>;
  /** monaco.languages.CompletionItemInsertTextRule-shaped enum holder. */
  CompletionItemInsertTextRule?: { InsertAsSnippet: number };
  /** Used to fold class members and globals into an open local-name list. */
  editor?: {
    getEditors(): ReadonlyArray<BareSuggestEditor>;
  };
};

type BareSuggestEditor = {
  getModel(): { uri: { path: string } } | null;
  getPosition?(): MinimalPosition | null;
  hasTextFocus?(): boolean;
  getContribution?(id: string): {
    model?: {
      state?: number;
      trigger?(options: { auto: boolean; retrigger?: boolean; triggerKind?: number }): void;
    };
  } | null;
  trigger(source: string, handlerId: string, payload: unknown): void;
};

/** Monaco passes this as the 3rd provideCompletionItems argument. */
type MinimalCompletionContext = {
  triggerKind: number;
  triggerCharacter?: string;
};

type MinimalCancellationToken = {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
};

function newQueryId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `q-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type TextIndexBridge = {
  completeCppSymbols?: (
    rootPath: string,
    request: {
      prefix: string;
      container?: string;
      memberOf?: string;
      receiver?: string;
      chain?: string[];
      limit?: number;
    },
  ) => Promise<CppIndexCompletionHit[]>;
  lookupCppSymbols?: (
    rootPath: string,
    word: string,
  ) => Promise<{ name: string; kind: string; container?: string; params?: string; returnType?: string }[]>;
  clangdIndexComplete?: (
    rootPath: string,
    request: {
      prefix: string;
      container?: string;
      memberOf?: string;
      receiver?: string;
      chain?: string[];
    },
  ) => Promise<CppIndexCompletionHit[]>;
};

/**
 * clangd-index members first (AST-accurate, engine bases included), text
 * index after; same-name text hits lend their params / return type.
 */
export function mergeIndexHits(
  semantic: readonly CppIndexCompletionHit[],
  text: readonly CppIndexCompletionHit[],
): CppIndexCompletionHit[] {
  const textByName = new Map<string, CppIndexCompletionHit>();
  for (const hit of text) if (!textByName.has(hit.name)) textByName.set(hit.name, hit);
  const enriched = semantic.map((hit): CppIndexCompletionHit => {
    const twin = textByName.get(hit.name);
    // Index rows carry no signature: without a text twin the arity is unknown.
    if (!twin) return hit.kind === "function" ? { ...hit, paramsUnknown: true } : hit;
    return {
      ...hit,
      ...(hit.params === undefined ? { params: twin.params ?? "" } : {}),
      ...(twin.returnType !== undefined && hit.returnType === undefined
        ? { returnType: twin.returnType }
        : {}),
    };
  });
  return [...enriched, ...text];
}

function textIndexBridge(): TextIndexBridge {
  return (window as { jellybot?: TextIndexBridge }).jellybot ?? {};
}

/**
 * How long a keystroke waits for clangd before the text index answers.
 * A file whose last clangd query timed out / failed (preamble still
 * building) gets the short budget for a while so typing stays responsive.
 */
const CLANGD_DEADLINE_MS = 1500;
const CLANGD_COLD_DEADLINE_MS = 400;
const CLANGD_COLD_WINDOW_MS = 8000;
/** Explicit Ctrl+Space: the user asked, so wait longer for semantic results. */
const CLANGD_INVOKE_DEADLINE_MS = 4000;
/** monaco.languages.CompletionTriggerKind.Invoke (Ctrl+Space / triggerSuggest). */
const COMPLETION_TRIGGER_INVOKE = 0;
/** monaco.languages.CompletionTriggerKind.TriggerForIncompleteCompletions. */
const COMPLETION_TRIGGER_INCOMPLETE = 2;
/**
 * Candidates per list — matches clangd `--limit-results`. Lists are marked
 * incomplete, so each keystroke re-queries the next best 20.
 */
const COMPLETION_RESULT_LIMIT = 20;
/** Locals kept in the top 20 even when inherited members would crowd them out. */
const LOCAL_NAME_SLOTS = 8;

/** Settles with `null` after `ms` unless `promise` settles first. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Text-index request row cap (`cpp-symbols:complete` limit). */
const TEXT_INDEX_LIMIT = 150;
/** clangd answers ≤100 per `workspace/symbol` scope query; this close means cut. */
const CLANGD_SCOPE_CAP_HINT = 90;
/** ClangdIndexCompletion MAX_GLOBAL_RESULTS / MAX_RESULTS. */
const CLANGD_GLOBAL_CAP = 60;
const CLANGD_TOTAL_CAP = 400;
/** ClangdIndexCompletion.globals only runs from this prefix length. */
const GLOBAL_PREFIX_MIN = 5;

/**
 * True when either index stopped at its row cap, so a longer prefix may
 * match names this answer never contained and must be queried again.
 */
export function indexHitsTruncated(
  semantic: readonly CppIndexCompletionHit[],
  text: readonly CppIndexCompletionHit[],
  textLimit = TEXT_INDEX_LIMIT,
): boolean {
  if (text.length >= textLimit || semantic.length >= CLANGD_TOTAL_CAP) return true;
  const perScope = new Map<string, number>();
  for (const hit of semantic) {
    const scope = hit.container ?? "";
    perScope.set(scope, (perScope.get(scope) ?? 0) + 1);
  }
  for (const [scope, count] of perScope) {
    if (count >= (scope ? CLANGD_SCOPE_CAP_HINT : CLANGD_GLOBAL_CAP)) return true;
  }
  return false;
}

export type IndexSlotReuse = {
  key: string;
  queryPrefix: string;
  truncated: boolean;
  bare: boolean;
};

/**
 * One index query per completion site: later letters filter its answer
 * unless it was cut at a cap, or a bare word just reached the globals length.
 */
export function canReuseIndexSlot(slot: IndexSlotReuse, key: string, prefix: string): boolean {
  if (slot.key !== key) return false;
  if (!prefix.toLowerCase().startsWith(slot.queryPrefix.toLowerCase())) return false;
  if (prefix.length === slot.queryPrefix.length) return true;
  if (slot.truncated) return false;
  return !(slot.bare && slot.queryPrefix.length < GLOBAL_PREFIX_MIN && prefix.length >= GLOBAL_PREFIX_MIN);
}

/** Identifies the spot a completion list belongs to (word start + receiver). */
export function indexSiteKey(
  path: string,
  lineNumber: number,
  wordStart: number,
  ctx: CppCompletionContext,
): string {
  const receiver = ctx.chain?.join(".") ?? ctx.name ?? "";
  return `${path}:${lineNumber}:${wordStart}:${ctx.access}:${receiver}`;
}

type IndexCompletionRequest = {
  prefix: string;
  container?: string;
  memberOf?: string;
  receiver?: string;
  chain?: string[];
  limit: number;
};

/** Index request for the caret; null when nothing can be resolved from text. */
function indexRequestAt(
  text: string,
  caret: number,
  lineNumber: number,
): { ctx: CppCompletionContext; request: IndexCompletionRequest } | null {
  const textBefore = text.slice(0, caret);
  const lineBefore = textBefore.slice(textBefore.lastIndexOf("\n") + 1);
  if (/^\s*#/.test(lineBefore)) return null;
  const ctx = completionContextAt(lineBefore);
  if (ctx.access === "member-unknown") return null;
  const container = resolveEnclosingContainer(text, lineNumber).container ?? undefined;
  const request: IndexCompletionRequest = { prefix: ctx.prefix, limit: TEXT_INDEX_LIMIT };
  if (container) request.container = container;
  if (ctx.access === "this") {
    if (!container) return null;
    request.memberOf = container;
  } else if (ctx.access === "scope" && ctx.name) {
    request.memberOf = ctx.name;
  } else if (ctx.access === "member" && ctx.name) {
    // `Target->Audio->` : Target's type from the buffer, then walk Audio.
    // A single `Weapon->` stays a receiver lookup on the enclosing class.
    const segments = ctx.chain ?? [ctx.name];
    let fields = segments;
    if (fields[0] === "this") {
      if (!container) return null;
      request.memberOf = container;
      fields = fields.slice(1);
    } else {
      const local = localTypeOf(textBefore, fields[0]!);
      if (local) {
        request.memberOf = local;
        fields = fields.slice(1);
      }
    }
    const only = fields.length === 1 ? fields[0] : undefined;
    if (fields.length > 1 || (only && request.memberOf)) request.chain = fields;
    else if (only) request.receiver = only;
  }
  return { ctx, request };
}

type IndexAnswer = { items: CppTextCompletionItem[]; truncated: boolean };

type IndexSources = {
  /** Text index only (SQLite, milliseconds). */
  fast: Promise<CppTextCompletionItem[]>;
  /** clangd index merged in (may take seconds while shards load). */
  full: Promise<IndexAnswer>;
};

const EMPTY_SOURCES: IndexSources = {
  fast: Promise.resolve([]),
  full: Promise.resolve({ items: [], truncated: false }),
};

/**
 * Text-index completion entries for the caret: own class → base classes
 * (main) + buffer identifiers + globals. Empty when the receiver type of a
 * member access cannot be recovered.
 */
function textCompletionSources(
  root: string,
  text: string,
  caret: number,
  lineNumber: number,
  explicit = false,
): IndexSources {
  const site = indexRequestAt(text, caret, lineNumber);
  if (!site) return EMPTY_SOURCES;
  const { ctx, request } = site;
  const api = textIndexBridge();
  const { limit: _limit, ...indexRequest } = request;
  const textHits = api.completeCppSymbols
    ? api.completeCppSymbols(root, request).catch(() => [] as CppIndexCompletionHit[])
    : Promise.resolve([] as CppIndexCompletionHit[]);
  const semantic = api.clangdIndexComplete
    ? api.clangdIndexComplete(root, indexRequest).catch(() => [] as CppIndexCompletionHit[])
    : Promise.resolve([] as CppIndexCompletionHit[]);
  const bare = ctx.access === "none";
  const words = bare ? localNamesInScope(text, caret, ctx.prefix, 40, explicit) : [];
  const macros = bare ? ueMacroHits(ctx.prefix) : [];
  const keywords = bare ? keywordItems(ctx.prefix) : [];
  // Curated types go first so their name wins the de-dupe and keeps the
  // higher rank when the index returns the same symbol.
  const common = bare ? commonTypeHits(ctx.prefix) : [];
  const build = (hits: CppIndexCompletionHit[]) => [
    ...buildTextCompletionItems([...common, ...hits, ...macros], words),
    ...keywords,
  ];
  return {
    fast: textHits.then(build),
    full: Promise.all([semantic, textHits]).then(([s, t]) => ({
      items: build(mergeIndexHits(s, t)),
      truncated: indexHitsTruncated(s, t, request.limit),
    })),
  };
}

/** Signature help from the text index (`Foo(a, |` → indexed `Foo` params). */
async function textSignatureHelp(
  root: string,
  text: string,
  caret: number,
  lineNumber: number,
): Promise<{ signatures: { label: string; parameters: string[] }[]; activeParameter: number } | null> {
  const call = callContextAt(text.slice(0, caret));
  const lookup = textIndexBridge().lookupCppSymbols;
  if (!call || !lookup) return null;
  let hits: Awaited<ReturnType<NonNullable<TextIndexBridge["lookupCppSymbols"]>>> = [];
  try {
    hits = await lookup(root, call.name);
  } catch {
    return null;
  }
  const container = resolveEnclosingContainer(text, lineNumber).container;
  const preferred = call.owner ?? container;
  const functions = hits
    .filter((hit) => hit.kind === "function" && hit.name === call.name)
    .sort((a, b) => Number(b.container === preferred) - Number(a.container === preferred));
  const seen = new Set<string>();
  const signatures: { label: string; parameters: string[] }[] = [];
  for (const hit of functions) {
    const sig = signatureFromHit(hit);
    if (seen.has(sig.label)) continue;
    seen.add(sig.label);
    signatures.push(sig);
    if (signatures.length >= 8) break;
  }
  if (signatures.length === 0) return null;
  return { signatures, activeParameter: call.activeParameter };
}

export function registerClangdProviders(
  monaco: ClangdMonacoLike,
  deps: { getWorkspaceRoot: () => string | null; registerHover?: boolean },
): { dispose(): void } {
  const kindFor = (lspKind: number): number => {
    const mapped = COMPLETION_KIND_MAP[lspKind];
    if (mapped !== undefined) return mapped;
    return monaco.CompletionItemKind?.Field ?? 5;
  };
  const insertAsSnippet =
    monaco.CompletionItemInsertTextRule?.InsertAsSnippet ?? 4;

  // One index query per completion site per file. Locals render at once,
  // the text index lands next, the clangd index merges last — each answer
  // rebuilds the list in place. No deadline: a late answer still merges.
  type IndexSlot = IndexSlotReuse & {
    line: number;
    /** Column where the typed word begins (caret column after `->` / `::`). */
    wordStart: number;
    fast: Promise<CppTextCompletionItem[]>;
    full: Promise<IndexAnswer>;
    /** Best answer so far: provisional → text index → merged. */
    items: CppTextCompletionItem[] | null;
    done: boolean;
    /** The last provider call for this site showed nothing (no list open). */
    shownEmpty: boolean;
  };
  const indexSlots = new Map<string, IndexSlot>();
  const braceCache = new Map<string, { at: number; style: ReturnType<typeof detectBraceStyle> }>();
  const cachedBraceStyle = (path: string, text: string): ReturnType<typeof detectBraceStyle> => {
    const now = Date.now();
    const hit = braceCache.get(path);
    if (hit && now - hit.at < 2_000) return hit.style;
    const style = detectBraceStyle(text);
    braceCache.set(path, { at: now, style });
    return style;
  };
  /** Members and globals from a cached query, narrowed to the letters typed since. */
  const cachedIndexItems = (items: readonly CppTextCompletionItem[], prefix: string): CppTextCompletionItem[] =>
    items.filter((item) => retainCachedCompletionItem(item, prefix));
  const suggestModelOf = (editor: BareSuggestEditor) =>
    editor.getContribution?.("editor.contrib.suggestController")?.model;
  const suggestIsOpen = (editor: BareSuggestEditor): boolean => {
    const state = suggestModelOf(editor)?.state;
    return typeof state === "number" && state !== 0;
  };
  // A refresh must not count as Ctrl+Space: that would ask clangd's slow
  // unqualified completion. Marked here, consumed by the next provider call.
  const refreshUntil = new Map<string, number>();
  const consumeRefresh = (path: string): boolean => {
    const until = refreshUntil.get(path);
    refreshUntil.delete(path);
    return until !== undefined && until > Date.now();
  };
  const caretWordStart = (model: MinimalModel, position: MinimalPosition): number => {
    const line = model.getLineContent?.(position.lineNumber);
    if (typeof line === "string") {
      const prefix = /[A-Za-z_]\w*$/.exec(line.slice(0, position.column - 1))?.[0] ?? "";
      return position.column - prefix.length;
    }
    const word = model.getWordAtPosition(position);
    return word && word.endColumn >= position.column ? word.startColumn : position.column;
  };
  /**
   * Re-run the provider so a newly landed index answer shows: in place when
   * the list is open, or open it when this site has shown nothing yet (a
   * list the user dismissed stays closed).
   */
  const refreshSuggest = (model: MinimalModel, path: string, slot: IndexSlot): void => {
    for (const editor of monaco.editor?.getEditors() ?? []) {
      const current = editor.getModel();
      if (!current || current.uri.path !== model.uri.path) continue;
      if (editor.hasTextFocus && !editor.hasTextFocus()) continue;
      const position = editor.getPosition?.();
      if (!position || position.lineNumber !== slot.line) continue;
      if (caretWordStart(model, position) !== slot.wordStart) continue;
      const open = suggestIsOpen(editor);
      if (!open && !slot.shownEmpty) continue;
      refreshUntil.set(path, Date.now() + 250);
      try {
        const suggest = suggestModelOf(editor);
        if (suggest?.trigger) {
          suggest.trigger({
            auto: true,
            retrigger: open,
            triggerKind: COMPLETION_TRIGGER_INCOMPLETE,
          });
        } else {
          editor.trigger("index-complete", "editor.action.triggerSuggest", { auto: true });
        }
      } catch {
        // Editor already disposed.
      }
    }
  };
  const hasIndexItems = (items: readonly CppTextCompletionItem[]): boolean =>
    items.some((item) => {
      const band = item.sortText[0];
      return band === "0" || band === "2" || band === "4";
    });
  const startIndexSlot = (
    model: MinimalModel,
    path: string,
    key: string,
    line: number,
    wordStart: number,
    ctx: CppCompletionContext,
    previous: IndexSlot | undefined,
    sources: IndexSources,
  ): IndexSlot => {
    // The previous query at this site still answers the new prefix (a
    // subset): keep showing it instead of blanking until the re-query lands.
    const provisional =
      previous && previous.key === key && previous.items
        ? cachedIndexItems(previous.items, ctx.prefix)
        : null;
    const slot: IndexSlot = {
      key,
      queryPrefix: ctx.prefix,
      truncated: false,
      bare: ctx.access === "none",
      line,
      wordStart,
      fast: sources.fast,
      full: sources.full,
      items: provisional,
      done: false,
      shownEmpty: false,
    };
    indexSlots.set(path, slot);
    const landed = () => {
      if (indexSlots.get(path) !== slot || !slot.items || !hasIndexItems(slot.items)) return;
      refreshSuggest(model, path, slot);
    };
    void sources.fast.then((items) => {
      if (slot.done) return;
      const labels = new Set(items.map((item) => item.label));
      slot.items = [...items, ...(slot.items ?? []).filter((item) => !labels.has(item.label))];
      landed();
    });
    void sources.full.then((answer) => {
      slot.items = answer.items;
      slot.truncated = answer.truncated;
      slot.done = true;
      landed();
    });
    return slot;
  };

  const rootFor = (model: MinimalModel): string | null => {
    const root = deps.getWorkspaceRoot();
    if (!root) return null;
    const path = modelUriToPath(model.uri);
    // Only C++ workspaces: clangd serves cpp; other models skip early.
    void path;
    return root;
  };

  // Per file: clangd timed out / failed recently (cold preamble) until then.
  const coldUntil = new Map<string, number>();
  const isCold = (path: string) => (coldUntil.get(path) ?? 0) > Date.now();
  const markCold = (path: string) => coldUntil.set(path, Date.now() + CLANGD_COLD_WINDOW_MS);

  type SuggestionSource = {
    label: string;
    kind: number;
    detail?: string;
    documentation?: string;
    signature?: string;
    filterText?: string;
    sortText?: string;
  };
  const toSuggestion = (
    item: SuggestionSource,
    insertion: ClangdInsertion,
    index: number,
    range: unknown,
  ) => ({
    // Name + signature + type columns, like Rider's lookup list.
    label: {
      label: item.label,
      ...(item.signature ? { detail: item.signature } : {}),
      ...(item.detail ? { description: item.detail } : {}),
    },
    kind: kindFor(item.kind),
    ...(item.detail ? { detail: item.detail } : {}),
    ...(item.documentation ? { documentation: { value: item.documentation } } : {}),
    insertText: insertion.insertText,
    ...(insertion.isSnippet ? { insertTextRules: insertAsSnippet } : {}),
    filterText: item.filterText ?? item.label,
    range,
    // Server ranking first; index keeps server order as tiebreak.
    sortText: item.sortText ?? String(index).padStart(4, "0"),
    ...(insertion.showParameterHints
      ? { command: { id: "editor.action.triggerParameterHints", title: "" } }
      : {}),
  });

  /** clangd items within `deadlineMs`; null = unavailable / failed / late. */
  const clangdItems = async (
    root: string,
    model: MinimalModel,
    position: MinimalPosition,
    path: string,
    triggerCharacter: string | undefined,
    token: MinimalCancellationToken | undefined,
    explicit: boolean,
  ) => {
    const api = bridge();
    const request = requestFor(model, position);
    if (!api || !request || !(await clangdAvailable(root))) return null;
    if (token?.isCancellationRequested) return null;
    // Relay the editor trigger so clangd scopes the result (member
    // access after `.`/`->`, header names after `<`/`"` in includes).
    if (triggerCharacter) request.triggerCharacter = triggerCharacter;
    // Monaco cancels the token when a newer keystroke supersedes this
    // request — drop it in clangd too instead of queueing behind it.
    const queryId = newQueryId();
    const cancelSub = token?.onCancellationRequested(() => {
      void api.clangdCancelQuery(queryId).catch(() => {});
    });
    const pending = api
      .clangdCompletion(root, request, queryId)
      .then((result) => {
        // A late success still proves clangd is warm for the next keystroke.
        if (result.ok) coldUntil.delete(path);
        else markCold(path);
        return result.ok ? result : null;
      })
      .catch(() => null)
      .finally(() => cancelSub?.dispose());
    const deadline = explicit
      ? CLANGD_INVOKE_DEADLINE_MS
      : isCold(path)
        ? CLANGD_COLD_DEADLINE_MS
        : CLANGD_DEADLINE_MS;
    const result = await withDeadline(pending, deadline);
    if (!result) {
      markCold(path);
      // Late answers are never shown; free clangd for the next keystroke.
      void api.clangdCancelQuery(queryId).catch(() => {});
    }
    return result;
  };

  const completionProvider = {
    triggerCharacters: [".", ":", ">", "#", "<", "/"],
    provideCompletionItems: async (
      model: MinimalModel,
      position: MinimalPosition,
      context?: MinimalCompletionContext,
      token?: MinimalCancellationToken,
    ) => {
      const root = rootFor(model);
      const path = modelUriToPath(model.uri);
      if (!root || !path) return null;
      const text = model.getValue();
      const caret = model.getOffsetAt(position);
      const lineBefore = text.slice(text.lastIndexOf("\n", caret - 1) + 1, caret);
      const trigger = context?.triggerCharacter;
      // `>` / `:` only mean member / scope access as `->` / `::`.
      if (trigger === ">" && !lineBefore.endsWith("->")) return null;
      if (trigger === ":" && !lineBefore.endsWith("::")) return null;

      const word = model.getWordAtPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word ? word.startColumn : position.column,
        endColumn: position.column,
      };

      // Ctrl+Space forces a fresh semantic query even while clangd is cold.
      // An index-answer refresh also arrives as Invoke on some paths.
      const refresh = consumeRefresh(path);
      const explicit = context?.triggerKind === COMPLETION_TRIGGER_INVOKE && !refresh;
      const ctx = completionContextAt(lineBefore);
      // `.` / `->` / `::` are resolved from the index (receiver type, then
      // that type's members). clangd's semantic completion parses the whole
      // translation unit first and is what made `TargetCharacter->AudioTriggerCfg->`
      // sit empty. Ctrl+Space still asks clangd. `#include` triggers do too.
      const memberAccess =
        ctx.access === "member" || ctx.access === "this" || ctx.access === "scope";
      // `if` / `for` / `while` … at statement position expand to a full
      // block (parentheses + braces in the file's brace style).
      const snippets =
        trigger === undefined && ctx.access === "none" && (ctx.prefix || explicit)
          ? controlFlowSnippets(lineBefore, ctx.prefix, cachedBraceStyle(path, text))
          : [];
      const snippetSuggestions = snippets.map((item, index) =>
        toSuggestion(item, item, index, range),
      );

      // Bare identifiers skip clangd: its unqualified completion searches every
      // scope of the engine index (measured >8s on a UE .cpp). They are served
      // by current-file symbols + class members + global-scope index symbols.
      const askClangd = explicit || (!memberAccess && trigger !== undefined);
      const result = askClangd
        ? await clangdItems(root, model, position, path, trigger, token, explicit)
        : null;
      if (result && result.items.length > 0) {
        const items = snippets.length
          ? result.items.filter(
              (item) =>
                !((item.kind === 14 || item.kind === 15) &&
                  CONTROL_KEYWORDS.has(item.label.split(/[\s(]/)[0] ?? "")),
            )
          : result.items;
        const suggestions = items
          .slice(0, COMPLETION_RESULT_LIMIT)
          .map((item, index) => toSuggestion(item, clangdInsertFor(item), index, range));
        // clangd caps the list (default 100); when truncated, ask monaco to
        // re-query on the next keystroke instead of filtering a stale subset.
        return {
          suggestions: [...snippetSuggestions, ...suggestions],
          incomplete: result.isIncomplete === true,
        };
      }
      // Index path. One query per completion site, not per letter: later
      // letters filter its answer. Bare names show the function-scoped
      // search immediately; member access waits only for the text index.
      // Every later answer rebuilds the list through refreshSuggest.
      const wordStart = position.column - ctx.prefix.length;
      const siteKey = indexSiteKey(path, position.lineNumber, wordStart, ctx);
      const previous = indexSlots.get(path);
      const slot =
        previous && !askClangd && canReuseIndexSlot(previous, siteKey, ctx.prefix)
          ? previous
          : startIndexSlot(
              model,
              path,
              siteKey,
              position.lineNumber,
              wordStart,
              ctx,
              previous,
              textCompletionSources(root, text, caret, position.lineNumber, explicit),
            );
      if (askClangd) {
        // clangd had nothing: the user asked, so wait for the merged answer.
        await slot.full;
      } else if (slot.items === null && ctx.access !== "none") {
        await slot.fast;
      }
      if (token?.isCancellationRequested) return null;
      const extra = slot.items ? cachedIndexItems(slot.items, ctx.prefix) : [];
      const bareLocals =
        ctx.access === "none" ? quickBareCompletionItems(text, caret, ctx.prefix, explicit) : [];
      const seen = new Set(bareLocals.map((item) => item.label));
      const merged = [...bareLocals, ...extra.filter((item) => !seen.has(item.label))];
      // Rank by band before cutting. Keep a few in-scope names so a long
      // run of inherited members cannot push every local out of the top 20.
      const sorted = [...merged].sort((a, b) =>
        a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : 0,
      );
      const locals = sorted.filter((item) => item.sortText.startsWith("1")).slice(0, LOCAL_NAME_SLOTS);
      const localLabels = new Set(locals.map((item) => item.label));
      const items = [
        ...locals,
        ...sorted.filter((item) => !localLabels.has(item.label)),
      ].slice(0, COMPLETION_RESULT_LIMIT);
      if (token?.isCancellationRequested) return null;
      slot.shownEmpty = items.length === 0 && snippetSuggestions.length === 0;
      if (slot.shownEmpty) return null;
      const suggestions = items.map((item, index) =>
        toSuggestion(
          { ...item, filterText: completionFilterText(item.label, ctx.prefix) },
          item,
          index,
          range,
        ),
      );
      // Text answers are provisional — re-ask (clangd may be warm by then).
      return { suggestions: [...snippetSuggestions, ...suggestions], incomplete: true };
    },
  };

  const hoverProvider = {
    provideHover: async (model: MinimalModel, position: MinimalPosition) => {
      const root = rootFor(model);
      if (!root) return null;
      try {
        const markdown = await clangdSymbolHover(root, model, position);
        if (!markdown) return null;
        const parts = semanticHoverParts(markdown);
        return {
          range: {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: position.column,
            endColumn: position.column,
          },
          contents: [{ value: formatCompactHover({ name: model.getWordAtPosition(position)?.word ?? "Symbol", ...parts }), supportHtml: true }],
        };
      } catch {
        return null;
      }
    },
  };

  const signatureHelpProvider = {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [")"],
    provideSignatureHelp: async (
      model: MinimalModel,
      position: MinimalPosition,
    ) => {
      const root = rootFor(model);
      const path = modelUriToPath(model.uri);
      if (!root || !path) return null;
      const toValue = (
        signatures: CompactSignature[],
        activeSignature: number,
        activeParameter: number,
      ) => ({
        value: {
          activeSignature,
          activeParameter,
          signatures: signatures.map((sig) => compactSignatureInformation(sig, activeParameter)),
        },
        dispose: () => {},
      });

      const api = bridge();
      const request = requestFor(model, position);
      if (api && request && (await clangdAvailable(root))) {
        const pending = api.clangdSignatureHelp(root, request).catch(() => null);
        const result = await withDeadline(
          pending,
          isCold(path) ? CLANGD_COLD_DEADLINE_MS : CLANGD_DEADLINE_MS,
        );
        if (result?.ok && result.signatures.length > 0) {
          const signatures = result.signatures.slice(0, 8);
          const active = Math.min(result.activeSignature ?? 0, signatures.length - 1);
          return toValue(signatures, active, signatures[active]?.activeParameter ?? 0);
        }
      }
      const text = model.getValue();
      const fallback = await textSignatureHelp(
        root,
        text,
        model.getOffsetAt(position),
        position.lineNumber,
      );
      if (!fallback) return null;
      return toValue(fallback.signatures, 0, fallback.activeParameter);
    },
  };

  const d1 = monaco.languages.registerCompletionItemProvider("cpp", completionProvider);
  const d2 = deps.registerHover === false ? null : monaco.languages.registerHoverProvider("cpp", hoverProvider);
  const d3 = monaco.languages.registerSignatureHelpProvider("cpp", signatureHelpProvider);
  return {
    dispose(): void {
      d1.dispose();
      d2?.dispose();
      d3.dispose();
    },
  };
}
