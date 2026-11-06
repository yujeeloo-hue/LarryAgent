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
import {
  localNamesInScope,
  quickBareCompletionItems,
  buildTextCompletionItems,
  callContextAt,
  commonTypeHits,
  completionContextAt,
  controlFlowSnippets,
  detectBraceStyle,
  keywordItems,
  localTypeOf,
  signatureFromHit,
  ueMacroHits,
  type CppIndexCompletionHit,
  type CppTextCompletionItem,
} from "./cppTextCompletion.js";

/** clangd keyword / code-pattern items replaced by our block snippets. */
const CONTROL_KEYWORDS = new Set(["if", "else", "for", "while", "do", "switch"]);

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
        signatures: { label: string; activeParameter: number; parameters: string[] }[];
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
  getContribution?(id: string): { model?: { state?: number } } | null;
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

/**
 * Text-index completion entries for the caret: own class → base classes
 * (main) + buffer identifiers + globals. Empty when the receiver type of a
 * member access cannot be recovered.
 */
async function textCompletionItems(
  root: string,
  text: string,
  caret: number,
  lineNumber: number,
  explicit = false,
): Promise<CppTextCompletionItem[]> {
  const textBefore = text.slice(0, caret);
  const lineBefore = textBefore.slice(textBefore.lastIndexOf("\n") + 1);
  if (/^\s*#/.test(lineBefore)) return [];
  const ctx = completionContextAt(lineBefore);
  if (ctx.access === "member-unknown") return [];
  const container = resolveEnclosingContainer(text, lineNumber).container ?? undefined;
  const request: {
    prefix: string;
    container?: string;
    memberOf?: string;
    receiver?: string;
    chain?: string[];
    limit: number;
  } = { prefix: ctx.prefix, limit: 150 };
  if (container) request.container = container;
  if (ctx.access === "this") {
    if (!container) return [];
    request.memberOf = container;
  } else if (ctx.access === "scope" && ctx.name) {
    request.memberOf = ctx.name;
  } else if (ctx.access === "member" && ctx.name) {
    // `Target->Audio->` : Target's type from the buffer, then walk Audio.
    // A single `Weapon->` stays a receiver lookup on the enclosing class.
    const segments = ctx.chain ?? [ctx.name];
    let fields = segments;
    if (fields[0] === "this") {
      if (!container) return [];
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
  const api = textIndexBridge();
  const { limit: _limit, ...indexRequest } = request;
  const [semantic, textHits] = await Promise.all([
    api.clangdIndexComplete
      ? api.clangdIndexComplete(root, indexRequest).catch(() => [] as CppIndexCompletionHit[])
      : Promise.resolve([] as CppIndexCompletionHit[]),
    api.completeCppSymbols
      ? api.completeCppSymbols(root, request).catch(() => [] as CppIndexCompletionHit[])
      : Promise.resolve([] as CppIndexCompletionHit[]),
  ]);
  const hits = mergeIndexHits(semantic, textHits);
  const bare = ctx.access === "none";
  const words = bare ? localNamesInScope(text, caret, ctx.prefix, 40, explicit) : [];
  const macros = bare ? ueMacroHits(ctx.prefix) : [];
  const keywords = bare ? keywordItems(ctx.prefix) : [];
  // Curated types go first so their name wins the de-dupe and keeps the
  // higher rank when the index returns the same symbol.
  const common = bare ? commonTypeHits(ctx.prefix) : [];
  return [...buildTextCompletionItems([...common, ...hits, ...macros], words), ...keywords];
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
  deps: { getWorkspaceRoot: () => string | null },
): { dispose(): void } {
  const kindFor = (lspKind: number): number => {
    const mapped = COMPLETION_KIND_MAP[lspKind];
    if (mapped !== undefined) return mapped;
    return monaco.CompletionItemKind?.Field ?? 5;
  };
  const insertAsSnippet =
    monaco.CompletionItemInsertTextRule?.InsertAsSnippet ?? 4;

  // One in-flight bare-identifier index query per file. Locals render
  // immediately; when this resolves, the open list is rebuilt with members
  // and globals merged in. No deadline — a late answer still merges.
  type BareIndexSlot = {
    /** path + line + column where the word began. Later letters reuse this. */
    key: string;
    /** Prefix the query was started with. Length < 5 means globals were not asked. */
    queryPrefix: string;
    promise: Promise<CppTextCompletionItem[]>;
    items: CppTextCompletionItem[] | null;
  };
  const bareIndex = new Map<string, BareIndexSlot>();
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
  const cachedIndexItems = (items: readonly CppTextCompletionItem[], prefix: string): CppTextCompletionItem[] => {
    const lower = prefix.toLowerCase();
    return items.filter((item) => {
      const band = item.sortText[0];
      if (band === "1" || band === "5") return false;
      return !lower || item.label.toLowerCase().startsWith(lower);
    });
  };
  const suggestIsOpen = (editor: BareSuggestEditor): boolean => {
    const state = editor.getContribution?.("editor.contrib.suggestController")?.model?.state;
    return typeof state === "number" && state !== 0;
  };
  const refreshOpenSuggest = (model: MinimalModel): boolean => {
    let triggered = false;
    for (const editor of monaco.editor?.getEditors() ?? []) {
      const current = editor.getModel();
      if (!current || current.uri.path !== model.uri.path) continue;
      if (!suggestIsOpen(editor)) continue;
      try {
        editor.trigger("bare-complete", "editor.action.triggerSuggest", {});
        triggered = true;
      } catch {
        // Editor already disposed.
      }
    }
    return triggered;
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
    if (!result) markCold(path);
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
      const explicit = context?.triggerKind === COMPLETION_TRIGGER_INVOKE;
      const ctx = completionContextAt(lineBefore);
      // `.` / `->` / `::` are resolved from the index (receiver type, then
      // that type's members). clangd's semantic completion parses the whole
      // translation unit first and is what made `TargetCharacter->AudioTriggerCfg->`
      // sit empty. Ctrl+Space still asks clangd. `#include` triggers do too.
      const memberAccess =
        ctx.access === "member" || ctx.access === "this" || ctx.access === "scope";
      const bareFast = ctx.access === "none" && trigger === undefined && !explicit;
      // One index query per word, not per letter. Later letters filter it.
      const wordStart = word?.startColumn ?? position.column;
      const bareKey = `${path}:${position.lineNumber}:${wordStart}`;
      let reuseBare = bareFast ? bareIndex.get(path) : undefined;
      if (
        reuseBare &&
        (reuseBare.key !== bareKey ||
          (ctx.prefix.length >= 5 && reuseBare.queryPrefix.length < 5))
      ) {
        reuseBare = undefined;
      }
      const fallback =
        reuseBare?.promise ??
        textCompletionItems(root, text, caret, position.lineNumber, explicit).catch(
          () => [] as CppTextCompletionItem[],
        );
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
      // Bare names: show the function-scoped search immediately. Class
      // members and globals merge into that open list once, when the
      // single query for this word returns.
      let merged: CppTextCompletionItem[];
      if (!bareFast) {
        merged = await fallback;
      } else {
        const slot: BareIndexSlot = reuseBare ?? {
          key: bareKey,
          queryPrefix: ctx.prefix,
          promise: fallback,
          items: null,
        };
        if (!reuseBare) {
          bareIndex.set(path, slot);
          void slot.promise.then((items) => {
            slot.items = items;
            const hasIndexHits = items.some((item) => {
              const band = item.sortText[0];
              return band === "0" || band === "2" || band === "4";
            });
            if (!hasIndexHits || bareIndex.get(path) !== slot) return;
            if (refreshOpenSuggest(model)) return;
            // The local list may still be opening; try once more next frame.
            requestAnimationFrame(() => {
              if (bareIndex.get(path) === slot) refreshOpenSuggest(model);
            });
          });
        }
        const locals = quickBareCompletionItems(text, caret, ctx.prefix, explicit);
        const extra = slot.items ? cachedIndexItems(slot.items, ctx.prefix) : [];
        const seen = new Set(locals.map((item) => item.label));
        merged = [...locals, ...extra.filter((item) => !seen.has(item.label))];
      }
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
      if (items.length === 0 && snippetSuggestions.length === 0) return null;
      const suggestions = items.map((item, index) => toSuggestion(item, item, index, range));
      // Text answers are provisional — re-ask (clangd may be warm by then).
      return { suggestions: [...snippetSuggestions, ...suggestions], incomplete: true };
    },
  };

  const hoverProvider = {
    provideHover: async (model: MinimalModel, position: MinimalPosition) => {
      const root = rootFor(model);
      const api = bridge();
      const request = requestFor(model, position);
      if (!root || !api || !request) return null;
      if (!(await clangdAvailable(root))) return null;
      try {
        const result = await api.clangdHover(root, request);
        if (!result.ok || !result.markdown) return null;
        return {
          range: {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: position.column,
            endColumn: position.column,
          },
          contents: [{ value: result.markdown }],
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
        signatures: { label: string; parameters: string[] }[],
        activeSignature: number,
        activeParameter: number,
      ) => ({
        value: {
          activeSignature,
          activeParameter,
          signatures: signatures.map((sig) => ({
            label: sig.label,
            parameters: signatureParameterRanges(sig.label, sig.parameters).map(
              (range) => ({ label: range }),
            ),
          })),
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
  const d2 = monaco.languages.registerHoverProvider("cpp", hoverProvider);
  const d3 = monaco.languages.registerSignatureHelpProvider("cpp", signatureHelpProvider);
  return {
    dispose(): void {
      d1.dispose();
      d2.dispose();
      d3.dispose();
    },
  };
}
