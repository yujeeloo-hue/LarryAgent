
import type { CppGotoTarget } from "./cppLanguageFeatures.js";
import { modelUriToPath } from "./cppLanguageFeatures.js";
import { resolveEnclosingContainer } from "./cppContainerContext.js";
import { compactParameterDocumentation, compactSignatureLabel, formatCompactHover, semanticHoverParts, type CompactSignature } from "./compactLanguagePopover.js";
import {
  bufferIdentifiers,
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
import {
  planUeReflectionCompletion,
  ueValueItems,
} from "./unrealReflectionSpecifiers.js";
import {
  existingIncludes,
  includeInsertionLine,
  normalizeFsPath,
  planAutoImport,
} from "../../../shared/cppIncludes.js";

const CONTROL_KEYWORDS = new Set(["if", "else", "for", "while", "do", "switch"]);

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

export type ClangdTextEdit = {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  newText: string;
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
          additionalTextEdits?: ClangdTextEdit[];
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


export const COMPLETION_KIND_MAP: Record<number, number> = {
  1: 18,
  2: 0,
  3: 1,
  4: 2,
  5: 3,
  6: 4,
  7: 5,
  8: 7,
  9: 8,
  10: 9,
  11: 12,
  12: 13,
  13: 15,
  14: 17,
  15: 28,
  16: 19,
  17: 20,
  18: 21,
  19: 23,
  20: 16,
  21: 14,
  22: 6,
  23: 10,
  24: 11,
  25: 24,
};

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


const OPEN_FOR: Record<string, string> = { ")": "(", ">": "<", "]": "[", "}": "{" };

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
  showParameterHints: boolean;
};

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


export async function clangdGotoDefinition(
  rootPath: string,
  model: MinimalModel,
  position: MinimalPosition,
  signal?: AbortSignal,
): Promise<CppGotoTarget[] | null> {
  const api = bridge();
  const request = requestFor(model, position);
  if (!api || !(await clangdAvailable(rootPath)) || !request) return null;
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
  CompletionItemKind?: Record<string, number>;
  CompletionItemInsertTextRule?: { InsertAsSnippet: number };
  editor?: {
    getEditors(): ReadonlyArray<BareSuggestEditor>;
  };
};

export type BareSuggestEditor = {
  getModel(): MinimalModel | null;
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
  clangdIncludeDirs?: (
    rootPath: string,
    filePath: string,
  ) => Promise<{ ok: true; dirs: string[] } | { ok: false; message: string }>;
};

export function mergeIndexHits(
  semantic: readonly CppIndexCompletionHit[],
  text: readonly CppIndexCompletionHit[],
): CppIndexCompletionHit[] {
  const textByName = new Map<string, CppIndexCompletionHit>();
  for (const hit of text) if (!textByName.has(hit.name)) textByName.set(hit.name, hit);
  const enriched = semantic.map((hit): CppIndexCompletionHit => {
    const twin = textByName.get(hit.name);
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

const CLANGD_DEADLINE_MS = 1500;
const CLANGD_COLD_DEADLINE_MS = 400;
const CLANGD_COLD_WINDOW_MS = 8000;
const CLANGD_INVOKE_DEADLINE_MS = 4000;
const COMPLETION_TRIGGER_INVOKE = 0;
const COMPLETION_TRIGGER_INCOMPLETE = 2;
const COMPLETION_RESULT_LIMIT = 20;
const LOCAL_NAME_SLOTS = 8;

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

const TEXT_INDEX_LIMIT = 150;
const CLANGD_SCOPE_CAP_HINT = 90;
const CLANGD_GLOBAL_CAP = 60;
const CLANGD_TOTAL_CAP = 400;

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

export function canReuseIndexSlot(slot: IndexSlotReuse, key: string, prefix: string): boolean {
  if (slot.key !== key) return false;
  if (!prefix.toLowerCase().startsWith(slot.queryPrefix.toLowerCase())) return false;
  if (prefix.length === slot.queryPrefix.length) return true;
  if (slot.truncated) return false;
  return !(slot.bare && !slot.queryPrefix);
}

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
  fast: Promise<CppTextCompletionItem[]>;
  full: Promise<IndexAnswer>;
};

const EMPTY_SOURCES: IndexSources = {
  fast: Promise.resolve([]),
  full: Promise.resolve({ items: [], truncated: false }),
};

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
): { dismissSuggest(editor: BareSuggestEditor): boolean; dispose(): void } {
  const kindFor = (lspKind: number): number => {
    const mapped = COMPLETION_KIND_MAP[lspKind];
    if (mapped !== undefined) return mapped;
    return monaco.CompletionItemKind?.Field ?? 5;
  };
  const insertAsSnippet =
    monaco.CompletionItemInsertTextRule?.InsertAsSnippet ?? 4;

  type IndexSlot = IndexSlotReuse & {
    line: number;
    wordStart: number;
    fast: Promise<CppTextCompletionItem[]>;
    full: Promise<IndexAnswer>;
    items: CppTextCompletionItem[] | null;
    done: boolean;
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
  const cachedIndexItems = (items: readonly CppTextCompletionItem[], prefix: string): CppTextCompletionItem[] =>
    items.filter((item) => retainCachedCompletionItem(item, prefix));
  const suggestModelOf = (editor: BareSuggestEditor) =>
    editor.getContribution?.("editor.contrib.suggestController")?.model;
  const suggestIsOpen = (editor: BareSuggestEditor): boolean => {
    const state = suggestModelOf(editor)?.state;
    return typeof state === "number" && state !== 0;
  };
  const dismissedSites = new Map<string, number>();
  const DISMISS_TTL_MS = 4_000;
  const dismissSiteKey = (path: string, line: number, wordStart: number, prefixLength: number): string =>
    `${path}|${line}|${wordStart}|${prefixLength}`;
  const isDismissed = (path: string, slot: IndexSlot): boolean => {
    const key = dismissSiteKey(path, slot.line, slot.wordStart, slot.queryPrefix.length);
    const at = dismissedSites.get(key);
    if (at === undefined) return false;
    if (Date.now() - at > DISMISS_TTL_MS) {
      dismissedSites.delete(key);
      return false;
    }
    return true;
  };
  const dismissSuggest = (editor: BareSuggestEditor): boolean => {
    if (!suggestIsOpen(editor)) return false;
    const model = editor.getModel();
    const position = editor.getPosition?.() ?? null;
    const path = model ? modelUriToPath(model.uri) : null;
    if (model && position && path) {
      const wordStart = caretWordStart(model, position);
      dismissedSites.set(
        dismissSiteKey(path, position.lineNumber, wordStart, position.column - wordStart),
        Date.now(),
      );
      refreshUntil.delete(path);
    }
    try {
      editor.trigger("keyboard", "hideSuggestWidget", {});
    } catch {
    }
    if (suggestIsOpen(editor)) {
      const controller = editor.getContribution?.("editor.contrib.suggestController") as {
        cancelSuggestWidget?: () => void;
      } | null;
      controller?.cancelSuggestWidget?.();
    }
    return true;
  };
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
  const refreshSuggest = (model: MinimalModel, path: string, slot: IndexSlot): void => {
    if (isDismissed(path, slot)) return;
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
    void path;
    return root;
  };

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
    additionalTextEdits?: readonly ClangdTextEdit[];
  };
  const monacoEdit = (edit: ClangdTextEdit) => ({
    range: {
      startLineNumber: edit.line,
      startColumn: edit.column,
      endLineNumber: edit.endLine,
      endColumn: edit.endColumn,
    },
    text: edit.newText,
  });
  type SuggestionExtra = {
    include?: string;
    edits?: readonly ClangdTextEdit[];
    monacoEdits?: readonly { range: Record<string, number>; text: string }[];
  };
  const toSuggestion = (
    item: SuggestionSource,
    insertion: ClangdInsertion,
    index: number,
    range: unknown,
    extra?: SuggestionExtra,
  ) => {
    const description = [item.detail, extra?.include].filter(Boolean).join(" · ");
    const lspEdits = extra?.edits ?? item.additionalTextEdits;
    const additionalTextEdits = extra?.monacoEdits
      ?? (lspEdits && lspEdits.length > 0 ? lspEdits.map(monacoEdit) : []);
    return {
      label: {
        label: item.label,
        ...(item.signature ? { detail: item.signature } : {}),
        ...(description ? { description } : {}),
      },
      kind: kindFor(item.kind),
      ...(item.detail ? { detail: item.detail } : {}),
      ...(item.documentation ? { documentation: { value: item.documentation } } : {}),
      insertText: insertion.insertText,
      ...(insertion.isSnippet ? { insertTextRules: insertAsSnippet } : {}),
      ...(additionalTextEdits.length > 0 ? { additionalTextEdits } : {}),
      filterText: item.filterText ?? item.label,
      range,
      sortText: item.sortText ?? String(index).padStart(4, "0"),
      ...(insertion.showParameterHints
        ? { command: { id: "editor.action.triggerParameterHints", title: "" } }
        : {}),
    };
  };

  const INCLUDE_DIRS_TTL_MS = 10 * 60_000;
  const includeDirsByFile = new Map<string, { at: number; dirs: string[] }>();
  const includeDirsPending = new Map<string, Promise<string[]>>();
  const includeDirsFor = (root: string, path: string): Promise<string[]> => {
    const key = `${root}|${path}`;
    const cached = includeDirsByFile.get(key);
    if (cached && Date.now() - cached.at < INCLUDE_DIRS_TTL_MS) {
      return Promise.resolve(cached.dirs);
    }
    const pending = includeDirsPending.get(key);
    if (pending) return pending;
    const api = textIndexBridge();
    if (!api.clangdIncludeDirs) return Promise.resolve([]);
    const request = api
      .clangdIncludeDirs(root, path)
      .then((result) => (result.ok ? result.dirs : []))
      .catch(() => [] as string[])
      .then((dirs) => {
        includeDirsPending.delete(key);
        if (dirs.length > 0) includeDirsByFile.set(key, { at: Date.now(), dirs });
        return dirs;
      });
    includeDirsPending.set(key, request);
    return request;
  };
  const cachedIncludeDirs = (root: string, path: string): string[] | null => {
    const entry = includeDirsByFile.get(`${root}|${path}`);
    return entry && Date.now() - entry.at < INCLUDE_DIRS_TTL_MS ? entry.dirs : null;
  };
  const AUTO_IMPORT_KINDS = new Set([7, 8, 13, 22]);

  const autoImports = (
    root: string,
    path: string,
    text: string,
    items: readonly CppTextCompletionItem[],
  ): Map<string, { include: string; monacoEdits: { range: Record<string, number>; text: string }[] }> => {
    const out = new Map<
      string,
      { include: string; monacoEdits: { range: Record<string, number>; text: string }[] }
    >();
    const candidates = items.filter(
      (item) => item.headerPath && AUTO_IMPORT_KINDS.has(item.kind) && normalizeFsPath(item.headerPath) !== normalizeFsPath(path),
    );
    if (candidates.length === 0) return out;
    const dirs = cachedIncludeDirs(root, path);
    if (!dirs) {
      if (!includeDirsPending.has(`${root}|${path}`)) void includeDirsFor(root, path);
      return out;
    }
    if (dirs.length === 0) return out;
    const included = existingIncludes(text);
    const line = includeInsertionLine(text);
    for (const item of candidates) {
      const plan = planAutoImport(item.headerPath, dirs, path, included, line);
      if (!plan) continue;
      out.set(item.label, {
        include: `#include "${plan.specifier}"`,
        monacoEdits: [
          {
            range: {
              startLineNumber: plan.insertion.line,
              startColumn: 1,
              endLineNumber: plan.insertion.line,
              endColumn: 1,
            },
            text: plan.insertion.text,
          },
        ],
      });
    }
    return out;
  };

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
    if (triggerCharacter) request.triggerCharacter = triggerCharacter;
    const queryId = newQueryId();
    const cancelSub = token?.onCancellationRequested(() => {
      void api.clangdCancelQuery(queryId).catch(() => {});
    });
    const pending = api
      .clangdCompletion(root, request, queryId)
      .then((result) => {
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
      void api.clangdCancelQuery(queryId).catch(() => {});
    }
    return result;
  };

  const completionProvider = {
    triggerCharacters: [".", ":", ">", "#", "<", "/", ","],
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
      if (trigger === ">" && !lineBefore.endsWith("->")) return null;
      if (trigger === ":" && !lineBefore.endsWith("::")) return null;

      const word = model.getWordAtPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word ? word.startColumn : position.column,
        endColumn: position.column,
      };

      const refresh = consumeRefresh(path);
      const explicit = context?.triggerKind === COMPLETION_TRIGGER_INVOKE && !refresh;
      const ctx = completionContextAt(lineBefore);

      const uePlan = planUeReflectionCompletion(text, caret);
      if (trigger === "," && !uePlan) return null;
      if (uePlan) {
        if (uePlan.kind === "items") {
          return uePlan.items.length > 0
            ? {
                suggestions: uePlan.items.map((item, index) =>
                  toSuggestion(item, item, index, range),
                ),
              }
            : null;
        }
        if (uePlan.kind === "value") {
          const container = resolveEnclosingContainer(text, position.lineNumber).container;
          const api = textIndexBridge();
          if (!container || !api.completeCppSymbols) return null;
          let hits: CppIndexCompletionHit[] = [];
          try {
            hits = await api.completeCppSymbols(root, {
              prefix: uePlan.prefix,
              container,
              memberOf: container,
              limit: TEXT_INDEX_LIMIT,
            });
          } catch {
            hits = [];
          }
          if (token?.isCancellationRequested) return null;
          const words = bufferIdentifiers(text, caret, uePlan.prefix, 60, true);
          const items = ueValueItems(uePlan.valueKind, uePlan.specifier, hits, words);
          return items.length > 0
            ? {
                suggestions: items
                  .slice(0, COMPLETION_RESULT_LIMIT)
                  .map((item, index) => toSuggestion(item, item, index, range)),
              }
            : null;
        }
        return null;
      }

      const memberAccess =
        ctx.access === "member" || ctx.access === "this" || ctx.access === "scope";
      const snippets =
        trigger === undefined && ctx.access === "none" && (ctx.prefix || explicit)
          ? controlFlowSnippets(lineBefore, ctx.prefix, cachedBraceStyle(path, text))
          : [];
      const snippetSuggestions = snippets.map((item, index) =>
        toSuggestion(item, item, index, range),
      );

      const askClangd = explicit || (!memberAccess && trigger !== undefined);
      const clangdList = (result: NonNullable<Awaited<ReturnType<typeof clangdItems>>>) => {
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
        return {
          suggestions: [...snippetSuggestions, ...suggestions],
          incomplete: result.isIncomplete === true,
        };
      };
      const result = askClangd
        ? await clangdItems(root, model, position, path, trigger, token, explicit)
        : null;
      if (result && result.items.length > 0) return clangdList(result);
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
        await slot.full;
      } else if (slot.items === null && ctx.access !== "none") {
        await slot.fast;
      }
      if (token?.isCancellationRequested) return null;
      const memberSite = memberAccess || ctx.access === "member-unknown";
      if (memberSite && !askClangd && !(slot.items && cachedIndexItems(slot.items, ctx.prefix).length > 0)) {
        const semantic = await clangdItems(root, model, position, path, trigger, token, false);
        if (token?.isCancellationRequested) return null;
        if (semantic && semantic.items.length > 0) return clangdList(semantic);
      }
      const extra = slot.items ? cachedIndexItems(slot.items, ctx.prefix) : [];
      const bareLocals =
        ctx.access === "none" ? quickBareCompletionItems(text, caret, ctx.prefix, explicit) : [];
      const seen = new Set(bareLocals.map((item) => item.label));
      const merged = [...bareLocals, ...extra.filter((item) => !seen.has(item.label))];
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
      const autoImport = ctx.access === "none" ? autoImports(root, path, text, items) : null;
      if (token?.isCancellationRequested) return null;
      const suggestions = items.map((item, index) =>
        toSuggestion(
          { ...item, filterText: completionFilterText(item.label, ctx.prefix) },
          item,
          index,
          range,
          autoImport?.get(item.label),
        ),
      );
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
    dismissSuggest,
    dispose(): void {
      d1.dispose();
      d2?.dispose();
      d3.dispose();
    },
  };
}
