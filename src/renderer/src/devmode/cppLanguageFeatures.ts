
import { resolveEnclosingContainer } from "./cppContainerContext.js";
import { resolveCppLocalBinding } from "./cppLocalBindings.js";
import { isUhtGeneratedPath } from "./goToDefinition.js";
import {
  isCppSiblingFile,
  scanCppIndexSymbols,
  type CppSymbolEntry,
} from "./cppSymbolIndex.js";
import { looksLikeUeType } from "./unrealCppTokens.js";
import { formatCompactHover, semanticHoverParts, type PopoverLocation } from "./compactLanguagePopover.js";

export type MonacoLike = {
  languages: {
    registerDefinitionProvider(
      languageId: string,
      provider: unknown,
    ): { dispose(): void };
    registerHoverProvider(
      languageId: string,
      provider: unknown,
    ): { dispose(): void };
  };
  Uri: { file(path: string): unknown };
};

export type CppLanguageFeatureDeps = {
  lookupSymbols: (word: string) => Promise<CppSymbolEntry[]>;
  getWorkspaceRoot: () => string | null;
  getSemanticHover?: (model: MinimalModel, position: MinimalPosition) => Promise<string | null>;
  getSemanticDefinition?: (
    model: MinimalModel,
    position: MinimalPosition,
  ) => Promise<CppGotoTarget[] | null>;
};


export type CppGotoTarget = { path: string; line: number };

export function qualifiedContainerBefore(
  text: string,
  wordStart: number,
): string | null {
  const before = text.slice(Math.max(0, wordStart - 200), wordStart);
  const m = /([A-Za-z_]\w*(?:::\s*[A-Za-z_]\w*)*)\s*::\s*$/.exec(before);
  const chain = m?.[1];
  if (!chain) return null;
  const last = (chain.split("::").pop() ?? "").trim();
  if (!last || /^super$/i.test(last)) return null;
  return last;
}

export function hasSuperQualifierBefore(
  text: string,
  wordStart: number,
): boolean {
  const before = text.slice(Math.max(0, wordStart - 200), wordStart);
  return /\bsuper\s*::\s*$/i.test(before);
}

export function modelUriToPath(uri: {
  scheme: string;
  path: string;
}): string | null {
  if (uri.scheme !== "file" || !uri.path) return null;
  let path: string;
  try {
    path = decodeURIComponent(uri.path);
  } catch {
    path = uri.path;
  }
  return path.replace(/^\/([A-Za-z]:)(?=\/)/, "$1");
}


export type CppDefinitionLookup = {
  word: string;
  currentPath: string | null;
  qualifiedContainer?: string | null;
  enclosingContainer?: string | null;
  caretLine?: number | null;
};

export type ScoredCppSymbol = { entry: CppSymbolEntry; score: number };

const TYPE_KINDS: ReadonlySet<string> = new Set([
  "class",
  "interface",
  "struct",
  "enum",
  "type",
]);

function scoreCppEntry(
  entry: CppSymbolEntry,
  lookup: CppDefinitionLookup,
): number {
  let score = 0;
  if (entry.name === lookup.word) score += 40;
  if (entry.container && lookup.qualifiedContainer) {
    if (entry.container.toLowerCase() === lookup.qualifiedContainer.toLowerCase()) {
      score += 50;
    } else {
      score -= 25;
    }
  } else if (entry.container && lookup.enclosingContainer) {
    if (
      entry.container.toLowerCase() === lookup.enclosingContainer.toLowerCase()
    ) {
      score += 45;
    }
  }
  if (lookup.currentPath) {
    if (entry.path === lookup.currentPath) score += 40;
    else if (isCppSiblingFile(entry.path, lookup.currentPath)) score += 25;
  } else if (!entry.isImpl) {
    score += 4;
  }
  if (looksLikeUeType(lookup.word) && TYPE_KINDS.has(entry.kind)) {
    score += 12;
  }
  if (lookup.currentPath) {
    const entryIsHeader = !entry.isImpl;
    const currentIsHeader = /\.(?:h|hpp|hxx|hh|inl)$/i.test(lookup.currentPath);
    if (entryIsHeader !== currentIsHeader) score += 8;
  }
  return score;
}

export function overlayLiveCppSymbols(
  persisted: readonly CppSymbolEntry[],
  path: string,
  text: string,
  word: string,
): CppSymbolEntry[] {
  const norm = path.replace(/\\/g, "/");
  const wanted = word.toLowerCase();
  const live = scanCppIndexSymbols(text, norm, {
    maxSymbols: Number.POSITIVE_INFINITY,
  }).filter((entry) => entry.name.toLowerCase() === wanted);
  const rest = persisted.filter(
    (entry) => entry.path.replace(/\\/g, "/") !== norm,
  );
  return [...rest, ...live];
}

export function rankCppDefinitions(
  entries: readonly CppSymbolEntry[],
  lookup: CppDefinitionLookup,
  options?: { includeCaretLine?: boolean; limit?: number },
): CppSymbolEntry[] {
  if (entries.length === 0) return [];
  const limit = options?.limit ?? 8;
  const scored: ScoredCppSymbol[] = entries.map((entry) => ({
    entry,
    score: scoreCppEntry(entry, lookup),
  }));
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0) ||
      a.entry.line - b.entry.line,
  );
  const seen = new Set<string>();
  const out: CppSymbolEntry[] = [];
  for (const { entry } of scored) {
    if (
      !options?.includeCaretLine &&
      lookup.caretLine != null &&
      lookup.currentPath != null &&
      entry.path === lookup.currentPath &&
      entry.line === lookup.caretLine
    ) {
      continue;
    }
    const key = `${entry.path}:${entry.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

export type CppDefinitionReason = "local" | "unique" | "qualified" | "enclosing";

export type CppDefinitionAmbiguity =
  | "none"
  | "multiple"
  | "overloaded"
  | "member-access"
  | "unmatched-qualifier";

export type CppDefinitionAssessment = {
  certain: CppGotoTarget | null;
  reason: CppDefinitionReason | null;
  ambiguity: CppDefinitionAmbiguity | null;
};

export type CppDefinitionDecision = CppDefinitionAssessment & {
  candidates: CppGotoTarget[];
};

const MEMBER_ACCESS_BEFORE = /[\w)\]>]\s*(?:->|\.)\s*$/;
const THIS_ACCESS_BEFORE = /\bthis\s*->\s*$/;

export function isMemberAccessBefore(text: string, wordStart: number): boolean {
  const before = text.slice(Math.max(0, wordStart - 200), wordStart);
  return MEMBER_ACCESS_BEFORE.test(before) && !THIS_ACCESS_BEFORE.test(before);
}

function symbolFamily(kind: string): string {
  return TYPE_KINDS.has(kind) ? "type" : kind;
}

export function assessCppDefinition(input: {
  entries: readonly CppSymbolEntry[];
  lookup: CppDefinitionLookup;
  memberAccess: boolean;
}): CppDefinitionAssessment {
  const ambiguous = (ambiguity: CppDefinitionAmbiguity): CppDefinitionAssessment => ({
    certain: null,
    reason: null,
    ambiguity,
  });
  const exact = input.entries.filter(
    (entry) => entry.name === input.lookup.word && !isUhtGeneratedPath(entry.path),
  );
  if (exact.length === 0) return ambiguous("none");
  const groups = new Map<string, CppSymbolEntry[]>();
  for (const entry of exact) {
    const key = `${symbolFamily(entry.kind)}|${entry.container ?? ""}`;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  const all = [...groups.values()];
  const inContainer = (container: string | null | undefined) =>
    container ? all.filter((group) => group[0]!.container === container) : [];

  let chosen: CppSymbolEntry[];
  let reason: CppDefinitionReason;
  const qualified = input.lookup.qualifiedContainer;
  if (qualified) {
    const matches = inContainer(qualified);
    if (matches.length !== 1) return ambiguous(matches.length === 0 ? "unmatched-qualifier" : "multiple");
    chosen = matches[0]!;
    reason = "qualified";
  } else if (input.memberAccess) {
    if (all.length !== 1) return ambiguous("member-access");
    chosen = all[0]!;
    reason = "unique";
  } else {
    const enclosing = inContainer(input.lookup.enclosingContainer);
    if (enclosing.length === 1) {
      chosen = enclosing[0]!;
      reason = "enclosing";
    } else if (all.length === 1) {
      chosen = all[0]!;
      reason = "unique";
    } else {
      return ambiguous("multiple");
    }
  }

  const declarations = chosen.filter((entry) => !entry.isImpl);
  if (chosen[0]!.kind === "function") {
    const signatures = new Set(declarations.map((entry) => entry.params ?? ""));
    const implementations = chosen.filter((entry) => entry.isImpl);
    if (signatures.size > 1 || implementations.length > 1) return ambiguous("overloaded");
  } else if (declarations.length > 1) {
    return ambiguous("multiple");
  }
  const target = chosen[0]!;
  return { certain: { path: target.path, line: target.line }, reason, ambiguity: null };
}


export const UE_WORD_DOCS: Readonly<Record<string, string>> = {
  UPROPERTY: "Unreal reflection: exposes a property to the editor, BP, networking and serialization.",
  UFUNCTION: "Unreal reflection: exposes a function to BP / native calls (BlueprintCallable, Server, Client…).",
  UCLASS: "Unreal reflection: declares a UObject-derived class; pairs with the `ClassGroups`/`Config` specifier list.",
  USTRUCT: "Unreal reflection: declares a POD-ish reflected struct (USTRUCT() struct F…).",
  UENUM: "Unreal reflection: declares a reflected enum (usually `enum class E… : uint8`).",
  UINTERFACE: "Unreal reflection: declares a UInterface — pair with a matching `I…` C++ class.",
  UDELEGATE: "Unreal reflection: declares a delegate signature (DECLARE_DYNAMIC_*_DELEGATE).",
  GENERATED_BODY: "UHT marker: generates the reflection body for this class (required once per UCLASS/USTRUCT/UENUM).",
  GENERATED_UCLASS_BODY: "UHT marker: legacy variant of GENERATED_BODY with a generated constructor.",
  UE_LOG: "Logging macro: UE_LOG(LogCategory, Verbosity, TEXT(\"…\"), Args…).",
  TEXT: "Wraps a literal as TCHAR — always use it for UE string literals.",
  TArray: "Unreal dynamic array — Heap-allocated, reflected, BP-visible counterpart of std::vector.",
  TSet: "Unreal reflected hash set.",
  TMap: "Unreal reflected key→value hash map (TMap<Key, Value>).",
  TObjectPtr: "Garbage-collected, editor-reloadable object pointer — preferred over raw pointers in UPROPERTY() members.",
  TSubclassOf: "Type-safe UClass reference restricted to a class hierarchy.",
  TSoftObjectPtr: "Streamable weak object reference — resolve with FSoftObjectPath.",
  TSoftClassPtr: "Streamable weak class reference.",
  FVector: "Double-precision 3D vector (UE5) — see FVector3f for the float variant.",
  FVector2D: "Double-precision 2D vector.",
  FRotator: "Pitch/Yaw/Roll rotation (degrees).",
  FTransform: "Translation + rotation + scale, hierarchy-safe.",
  FText: "Localized, immutable display text — for UI, never FString.",
  FString: "Mutable TCHAR string — general-purpose, not localized.",
  FName: "Case-insensitive interned name — cheap identity for keys/refs.",
  Super: "Alias for the immediate base class — call Super::Method() to chain overrides.",
  check: "Fatal assertion (assert-like): halts the process when false in all builds.",
  checkf: "Fatal assertion with a formatted message.",
  verify: "Like check(), but the expression is kept in shipping builds.",
  verifyf: "verify() with a formatted message.",
  ensure: "Non-fatal assertion: logs an error once and continues — use for recoverable states.",
  ensureMsgf: "ensure() with a formatted message.",
};

function relPathFor(path: string, root: string | null): string {
  const norm = path.replace(/\\/g, "/");
  if (!root) return norm;
  const r = root.replace(/\\/g, "/").replace(/\/$/, "");
  return norm.toLowerCase().startsWith(`${r.toLowerCase()}/`)
    ? norm.slice(r.length + 1)
    : norm;
}

function signatureLine(entry: CppSymbolEntry): string | null {
  if (entry.kind === "function") {
    const params = entry.params ?? "";
    const owner = entry.container ? `${entry.container}::` : "";
    return `${entry.returnType ? `${entry.returnType} ` : ""}${owner}${entry.name}(${params})`;
  }
  if (entry.kind === "variable" && entry.returnType) {
    return `${entry.returnType} ${entry.name}`;
  }
  if (["class", "struct", "enum"].includes(entry.kind)) return `${entry.kind} ${entry.name}`;
  return null;
}

export function formatCppHoverMarkdown(
  word: string,
  entries: readonly CppSymbolEntry[],
  root: string | null,
  semanticMarkdown?: string | null,
): string | null {
  if (entries.length === 0 && !(word in UE_WORD_DOCS) && !semanticMarkdown) {
    return null;
  }
  const top = entries[0];
  const semantic = semanticMarkdown ? semanticHoverParts(semanticMarkdown) : null;
  const locations: PopoverLocation[] = [];
  for (const entry of entries) {
    locations.push({ role: entry.isImpl ? "Impl" : "Decl", path: relPathFor(entry.path, root), line: entry.line });
  }
  const signature = semantic?.signature ?? (top ? signatureLine(top) : null);
  const kind = top?.kind ?? (/^(?:class|struct)\b/m.test(signature ?? "") ? "class" : signature?.includes("(") ? "function" : "type");
  return formatCompactHover({
    name: top?.name ?? word,
    kind,
    signature,
    documentation: semantic?.documentation || UE_WORD_DOCS[word] || "",
    locations,
  });
}


type MinimalModel = {
  getValue(): string;
  getWordAtPosition(position: {
    lineNumber: number;
    column: number;
  }): { word: string; startColumn: number; endColumn: number } | null;
  getOffsetAt(position: {
    lineNumber: number;
    column: number;
  }): number;
  uri: { scheme: string; path: string };
};

type MinimalPosition = { lineNumber: number; column: number };

export type CppLanguageFeatureRegistration = {
  dispose(): void;
  resolveDefinition(
    model: MinimalModel,
    position: MinimalPosition,
  ): Promise<CppDefinitionDecision>;
};

export function registerCppLanguageFeatures(
  monaco: MonacoLike,
  deps: CppLanguageFeatureDeps,
): CppLanguageFeatureRegistration {
  const prepareLookup = (model: MinimalModel, position: MinimalPosition, minimumLength = 2) => {
    const path = modelUriToPath(model.uri);
    const word = model.getWordAtPosition(position);
    if (!word || word.word.length < minimumLength) return null;
    const text = model.getValue();
    const wordStart = model.getOffsetAt({
      lineNumber: position.lineNumber,
      column: word.startColumn,
    });
    return {
      path,
      word: word.word,
      text,
      wordStart,
      range: {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: word.endColumn,
      },
    };
  };

  type LookupContext = NonNullable<ReturnType<typeof prepareLookup>>;

  const localEntry = (ctx: LookupContext, caretLine: number): CppSymbolEntry | null => {
    if (!ctx.path) return null;
    const local = resolveCppLocalBinding(ctx.text, caretLine, ctx.range.startColumn);
    if (local?.name !== ctx.word) return null;
    return {
      name: local.name,
      kind: "variable",
      path: ctx.path,
      line: local.declarationLine,
      returnType: local.inferredType ?? local.type,
    };
  };

  const rankedEntries = async (
    ctx: LookupContext,
    caretLine: number,
    rank?: { includeCaretLine?: boolean; limit?: number },
  ): Promise<{ entries: CppSymbolEntry[]; lookup: CppDefinitionLookup }> => {
    const enclosing = hasSuperQualifierBefore(ctx.text, ctx.wordStart)
      ? null
      : resolveEnclosingContainer(ctx.text, caretLine).container;
    const lookup: CppDefinitionLookup = {
      word: ctx.word,
      currentPath: ctx.path,
      qualifiedContainer: qualifiedContainerBefore(ctx.text, ctx.wordStart),
      enclosingContainer: enclosing,
      caretLine,
    };
    const persisted = await deps.lookupSymbols(ctx.word);
    const merged = ctx.path
      ? overlayLiveCppSymbols(persisted, ctx.path, ctx.text, ctx.word)
      : [...persisted];
    return { entries: rankCppDefinitions(merged, lookup, rank), lookup };
  };

  const resolveEntries = async (
    ctx: LookupContext,
    caretLine: number,
    rank?: { includeCaretLine?: boolean },
  ): Promise<CppSymbolEntry[]> => {
    const local = localEntry(ctx, caretLine);
    if (local) return [local];
    return (await rankedEntries(ctx, caretLine, rank)).entries;
  };

  const targetRange = (location: CppGotoTarget) => ({
    uri: monaco.Uri.file(location.path),
    range: {
      startLineNumber: location.line,
      startColumn: 1,
      endLineNumber: location.line,
      endColumn: 1,
    },
  });

  const resolveDefinition = async (
    model: MinimalModel,
    position: MinimalPosition,
  ): Promise<CppDefinitionDecision> => {
    const none: CppDefinitionDecision = {
      certain: null,
      reason: null,
      ambiguity: "none",
      candidates: [],
    };
    if (!deps.getWorkspaceRoot()) return none;
    const ctx = prepareLookup(model, position);
    if (!ctx) return none;
    const local = localEntry(ctx, position.lineNumber);
    if (local) {
      const target = { path: local.path, line: local.line };
      return { certain: target, reason: "local", ambiguity: null, candidates: [target] };
    }
    const { entries, lookup } = await rankedEntries(ctx, position.lineNumber, {
      limit: Number.POSITIVE_INFINITY,
    });
    const assessment = assessCppDefinition({
      entries,
      lookup,
      memberAccess: isMemberAccessBefore(ctx.text, ctx.wordStart),
    });
    const candidates = entries.slice(0, 8).map((entry) => ({ path: entry.path, line: entry.line }));
    return { ...assessment, candidates };
  };

  const definitionProvider = {
    provideDefinition: async (model: MinimalModel, position: MinimalPosition) => {
      const decision = await resolveDefinition(model, position);
      if (decision.certain) return [targetRange(decision.certain)];
      const semantic = (await deps.getSemanticDefinition?.(model, position).catch(() => null)) ?? null;
      return semantic && semantic.length > 0 ? semantic.map(targetRange) : null;
    },
  };

  const hoverProvider = {
    provideHover: async (model: MinimalModel, position: MinimalPosition) => {
      const ctx = prepareLookup(model, position, 1);
      if (!ctx) return null;
      const root = deps.getWorkspaceRoot();
      const semanticPending = deps.getSemanticHover?.(model, position).catch(() => null);
      const entries = root
        ? await resolveEntries(ctx, position.lineNumber, { includeCaretLine: true })
        : [];
      const markdown = formatCppHoverMarkdown(ctx.word, entries, root, await semanticPending);
      if (!markdown) return null;
      return { range: ctx.range, contents: [{ value: markdown, supportHtml: true }] };
    },
  };

  const d1 = monaco.languages.registerDefinitionProvider(
    "cpp",
    definitionProvider,
  );
  const d2 = monaco.languages.registerHoverProvider("cpp", hoverProvider);
  return {
    dispose(): void {
      d1.dispose();
      d2.dispose();
    },
    resolveDefinition,
  };
}
