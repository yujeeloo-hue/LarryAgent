/**
 * Monaco language features for the (Unreal) C++ editing experience:
 * - DefinitionProvider: F12 / Ctrl+click via the workspace symbol index,
 *   with container-qualified ranking (`Class::Method`), enclosing-class
 *   ranking (L2, cppContainerContext.ts), decl↔impl pairing
 *   (Public/*.h ↔ Private/*.cpp) and live-buffer overrides.
 * - HoverProvider: signature + declaration/implementation locations, plus
 *   short Unreal reflection-macro / type cheat-sheet lines.
 *
 * Pure ranking/formatting helpers are exported for node --test; the monaco
 * dependency is structural (never imported at module scope).
 */

import { resolveEnclosingContainer } from "./cppContainerContext.js";
import { resolveCppLocalBinding } from "./cppLocalBindings.js";
import type { CppUsageTarget } from "./cppFindUsages.js";
import {
  isCppSiblingFile,
  scanCppIndexSymbols,
  type CppSymbolEntry,
  type CppWorkspaceIndex,
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
  /**
   * In-memory index used by tests. The editor passes `lookupSymbols` instead
   * and does not build this index.
   */
  index?: CppWorkspaceIndex;
  /** Persisted workspace symbols for one identifier (SQLite). */
  lookupSymbols?: (word: string) => Promise<CppSymbolEntry[]>;
  /** Workspace root (or null when Dev Mode has no workspace). */
  getWorkspaceRoot: () => string | null;
  /**
   * Engine source root for UE workspaces (`<install>/Engine`, or null).
   * Powers F12/hover fallbacks for engine types (FVector, AActor…).
   */
  getEngineRoot?: () => Promise<string | null>;
  /** Text reader used to locate declarations inside engine headers. */
  readEngineTextFile?: (path: string) => Promise<string | null>;
  /** Semantic content is merged into this provider, avoiding duplicate hover rows. */
  getSemanticHover?: (model: MinimalModel, position: MinimalPosition) => Promise<string | null>;
};

// -------------------------------------------------- engine type fallback

/**
 * Common engine types → candidate files under `<Engine>/Source`. Paths are
 * relative to the engine source root; multiple candidates absorb engine
 * version drift (e.g. FName moved between UE4 and UE5).
 */
export const UE_ENGINE_TYPE_FILES: Readonly<Record<string, readonly string[]>> = {
  FVector: ["Runtime/Core/Public/Math/Vector.h"],
  FVector2D: ["Runtime/Core/Public/Math/Vector2D.h"],
  FVector3f: ["Runtime/Core/Public/Math/Vector3f.h", "Runtime/Core/Public/Math/Vector.h"],
  FVector4: ["Runtime/Core/Public/Math/Vector4.h"],
  FRotator: ["Runtime/Core/Public/Math/Rotator.h"],
  FQuat: ["Runtime/Core/Public/Math/Quat.h"],
  FTransform: ["Runtime/Core/Public/Math/Transform.h"],
  FColor: ["Runtime/Core/Public/Math/Color.h"],
  FLinearColor: ["Runtime/Core/Public/Math/Color.h"],
  FGuid: ["Runtime/Core/Public/Misc/Guid.h"],
  FString: ["Runtime/Core/Public/Containers/UnrealString.h"],
  FName: ["Runtime/Core/Public/UObject/NameTypes.h", "Runtime/Core/Public/Misc/NameTypes.h"],
  FText: ["Runtime/Core/Public/Internationalization/Text.h"],
  TArray: ["Runtime/Core/Public/Containers/Array.h"],
  TSet: ["Runtime/Core/Public/Containers/Set.h"],
  TMap: ["Runtime/Core/Public/Containers/Map.h"],
  TObjectPtr: ["Runtime/Core/Public/UObject/ObjectPtr.h"],
  TSubclassOf: ["Runtime/Core/Public/Templates/SubclassOf.h"],
  TSoftObjectPtr: ["Runtime/Core/Public/UObject/SoftObjectPtr.h"],
  TSoftClassPtr: ["Runtime/Core/Public/UObject/SoftObjectPath.h"],
  TWeakObjectPtr: ["Runtime/Core/Public/Templates/WeakObjectPtr.h"],
  UObject: ["Runtime/Core/Public/UObject/Object.h"],
  UClass: ["Runtime/Core/Public/UObject/Class.h"],
  UFunction: ["Runtime/Core/Public/UObject/Class.h"],
  UStruct: ["Runtime/Core/Public/UObject/Class.h"],
  AActor: ["Runtime/Engine/Classes/GameFramework/Actor.h"],
  APawn: ["Runtime/Engine/Classes/GameFramework/Pawn.h"],
  ACharacter: ["Runtime/Engine/Classes/GameFramework/Character.h"],
  AController: ["Runtime/Engine/Classes/GameFramework/Controller.h"],
  APlayerController: ["Runtime/Engine/Classes/GameFramework/PlayerController.h"],
  AGameModeBase: ["Runtime/Engine/Classes/GameFramework/GameModeBase.h"],
  AGameStateBase: ["Runtime/Engine/Classes/GameFramework/GameStateBase.h"],
  APlayerState: ["Runtime/Engine/Classes/GameFramework/PlayerState.h"],
  AHUD: ["Runtime/Engine/Classes/GameFramework/HUD.h"],
  UActorComponent: ["Runtime/Engine/Classes/Components/ActorComponent.h"],
  USceneComponent: ["Runtime/Engine/Classes/Components/SceneComponent.h"],
  UPrimitiveComponent: ["Runtime/Engine/Classes/Components/PrimitiveComponent.h"],
  UStaticMeshComponent: ["Runtime/Engine/Classes/Components/StaticMeshComponent.h"],
  USkeletalMeshComponent: ["Runtime/Engine/Classes/Engine/SkeletalMeshComponent.h"],
  UStaticMesh: ["Runtime/Engine/Classes/Engine/StaticMesh.h"],
  UWorld: ["Runtime/Engine/Classes/Engine/World.h"],
  UGameInstance: ["Runtime/Engine/Classes/Engine/GameInstance.h"],
  ULevel: ["Runtime/Engine/Classes/Engine/Level.h"],
  UCameraComponent: ["Runtime/Engine/Classes/Camera/CameraComponent.h"],
  USpringArmComponent: ["Runtime/Engine/Classes/GameFramework/SpringArmComponent.h"],
  UPROPERTY: ["Runtime/Core/Public/UObject/ObjectMacros.h"],
  UFUNCTION: ["Runtime/Core/Public/UObject/ObjectMacros.h"],
  UCLASS: ["Runtime/Core/Public/UObject/ObjectMacros.h"],
  USTRUCT: ["Runtime/Core/Public/UObject/ObjectMacros.h"],
  UENUM: ["Runtime/Core/Public/UObject/ObjectMacros.h"],
  UINTERFACE: ["Runtime/Core/Public/UObject/ObjectMacros.h"],
};

export type UeEngineTypeLocation = {
  /** Absolute path of the engine header. */
  path: string;
  /** 1-based declaration line (1 when the header opens without a match). */
  line: number;
};

/** Jump target for the editor's F12 (path + 1-based line). */
export type CppGotoTarget = { path: string; line: number };

/** Find `struct|class|enum|using|typedef … WORD` inside an engine header. */
export function findUeEngineDeclLine(
  text: string,
  word: string,
): number {
  const re = new RegExp(
    `^\\s*(?:enum\\s+class|enum\\s+struct|struct|class|enum)\\s+(?:[A-Za-z_]\\w*_API\\s+)?${word}\\b|^\\s*(?:using|typedef)\\b[^;]*\\b${word}\\b`,
  );
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]!)) return i + 1;
  }
  return 1;
}

/**
 * Engine-header fallback for F12/hover: when the workspace index has no
 * declaration for a well-known engine type, point at its engine source
 * header instead. Resolved lazily; cache per (engineRoot, word).
 */
export async function resolveUeEngineTypeLocation(
  word: string,
  engineRoot: string | null,
  readTextFile: (path: string) => Promise<string | null>,
  cache?: Map<string, UeEngineTypeLocation | null>,
): Promise<UeEngineTypeLocation | null> {
  const candidates = UE_ENGINE_TYPE_FILES[word];
  if (!candidates || candidates.length === 0 || !engineRoot) return null;
  const root = engineRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const cacheKey = `${root}|${word}`;
  if (cache) {
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit;
  }
  let resolved: UeEngineTypeLocation | null = null;
  for (const rel of candidates) {
    const path = `${root}/Source/${rel}`;
    const text = await readTextFile(path);
    if (text == null) continue;
    resolved = { path, line: findUeEngineDeclLine(text, word) };
    break;
  }
  cache?.set(cacheKey, resolved);
  return resolved;
}

// ------------------------------------------------------------- word context

/**
 * `ANFCharacter::BeginPlay` with the caret on `BeginPlay` → the qualifier
 * chain before the word. `Super::` resolves to the (unknown) base class and
 * is deliberately dropped — unqualified lookup gives better results.
 */
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

/**
 * `Super::BeginPlay<caret>` — the qualifier names the *base* class, so the
 * enclosing class (L2) is the one answer we know is wrong. Callers suppress
 * the enclosing-container boost when this is true. Resolving the actual base
 * class is L4 (parse `: public X` off the class head).
 */
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

// ----------------------------------------------------------------- ranking

export type CppDefinitionLookup = {
  word: string;
  currentPath: string | null;
  /** Qualifier before the word at the call site, if any (`A::B<caret>`). */
  qualifiedContainer?: string | null;
  /**
   * Class enclosing the caret (L2 — `resolveEnclosingContainer`). Boost-only:
   * a same-class candidate gains, a different-class candidate loses nothing,
   * so a bad guess can never demote what the ranker would have chosen.
   */
  enclosingContainer?: string | null;
  /** Caret line — the location under the cursor itself is skipped. */
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
    // L2: no qualifier was spelled out, but the caret sits inside a class.
    // Boost-only (see CppDefinitionLookup.enclosingContainer) — and worth
    // more than the same-file bonus so a cross-file member of *this* class
    // outranks an unrelated same-file symbol.
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
    score += 4; // no context: a declaration is the stable landing spot
  }
  if (looksLikeUeType(lookup.word) && TYPE_KINDS.has(entry.kind)) {
    score += 12;
  }
  if (lookup.currentPath) {
    // Toggle behaviour: from a header prefer the implementation, and vice
    // versa — F12 becomes a decl↔impl switch inside the same class.
    const entryIsHeader = !entry.isImpl;
    const currentIsHeader = /\.(?:h|hpp|hxx|hh|inl)$/i.test(lookup.currentPath);
    if (entryIsHeader !== currentIsHeader) score += 8;
  }
  return score;
}

/**
 * Drop persisted rows for the file under the caret and replace them with a
 * scan of the live buffer, so unsaved edits win over the database.
 */
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

/**
 * Rank already-fetched hits for a definition lookup.
 * Go-to-definition skips the caret line so F12 does not land on the
 * symbol you are already on. Hover passes `includeCaretLine` — the
 * declaration under the mouse is the type we want to show.
 */
export function rankCppDefinitions(
  entries: readonly CppSymbolEntry[],
  lookup: CppDefinitionLookup,
  options?: { includeCaretLine?: boolean },
): CppSymbolEntry[] {
  if (entries.length === 0) return [];
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
    if (out.length >= 8) break;
  }
  return out;
}

/** Rank index hits for a definition lookup. Empty when nothing plausible. */
export function findCppDefinitions(
  index: CppWorkspaceIndex,
  lookup: CppDefinitionLookup,
  options?: { includeCaretLine?: boolean },
): CppSymbolEntry[] {
  return rankCppDefinitions(index.getEntries(lookup.word), lookup, options);
}

// ------------------------------------------------------------------- hover

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

/** Hover markdown: symbol identity, signature, up to 3 locations, UE docs. */
export function formatCppHoverMarkdown(
  word: string,
  entries: readonly CppSymbolEntry[],
  root: string | null,
  engineLocation?: UeEngineTypeLocation | null,
  semanticMarkdown?: string | null,
): string | null {
  if (
    entries.length === 0 &&
    !(word in UE_WORD_DOCS) &&
    !engineLocation &&
    !semanticMarkdown
  ) {
    return null;
  }
  const top = entries[0];
  const semantic = semanticMarkdown ? semanticHoverParts(semanticMarkdown) : null;
  const locations: PopoverLocation[] = [];
  for (const entry of entries) {
    locations.push({ role: entry.isImpl ? "Impl" : "Decl", path: relPathFor(entry.path, root), line: entry.line });
  }
  if (engineLocation) {
    const engineRel = engineLocation.path.replace(
      /^.*?[\/\\]Engine[\/\\]Source[\/\\]/i,
      "",
    );
    locations.push({ role: "Engine", path: `Engine/Source/${engineRel}`, line: engineLocation.line });
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

// ------------------------------------------------------------ registration

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

/**
 * Register the cpp definition + hover providers. Call `dispose()` when the
 * Dev Mode editor is torn down.
 */
export type CppLanguageFeatureRegistration = {
  dispose(): void;
  /**
   * Ranked F12 targets for the editor's own go-to-definition handler
   * (best first; engine fallback included). null = not applicable,
   * [] = C++ lookup with no match.
   */
  gotoDefinition(
    model: MinimalModel,
    position: MinimalPosition,
  ): Promise<CppGotoTarget[] | null>;
  resolveUsageTarget(
    model: MinimalModel,
    position: MinimalPosition,
  ): Promise<CppUsageTarget | null>;
};

export function registerCppLanguageFeatures(
  monaco: MonacoLike,
  deps: CppLanguageFeatureDeps,
): CppLanguageFeatureRegistration {
  const locationFor = (entry: CppSymbolEntry) => ({
    uri: monaco.Uri.file(entry.path),
    range: {
      startLineNumber: entry.line,
      startColumn: 1,
      endLineNumber: entry.line,
      endColumn: 1,
    },
  });

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

  const resolveEntries = async (
    ctx: NonNullable<ReturnType<typeof prepareLookup>>,
    caretLine: number,
    rank?: { includeCaretLine?: boolean },
  ): Promise<CppSymbolEntry[]> => {
    if (ctx.path) {
      const local = resolveCppLocalBinding(
        ctx.text,
        caretLine,
        ctx.range.startColumn,
      );
      if (local?.name === ctx.word) {
        return [
          {
            name: local.name,
            kind: "variable",
            path: ctx.path,
            line: local.declarationLine,
            returnType: local.inferredType ?? local.type,
          },
        ];
      }
    }
    // `Super::X` names the base class — the enclosing class is knowably the
    // wrong hint there, so the L2 boost is suppressed (L4 would resolve it).
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
    if (deps.lookupSymbols) {
      const persisted = await deps.lookupSymbols(ctx.word);
      const merged = ctx.path
        ? overlayLiveCppSymbols(persisted, ctx.path, ctx.text, ctx.word)
        : [...persisted];
      return rankCppDefinitions(merged, lookup, rank);
    }
    const index = deps.index;
    const root = deps.getWorkspaceRoot();
    if (!index || !root) return [];
    if (ctx.path) index.upsertFile(ctx.path, ctx.text);
    await index.ensure(root);
    return findCppDefinitions(index, lookup, rank);
  };

  const engineCache = new Map<string, UeEngineTypeLocation | null>();
  const engineLocationFor = async (
    word: string,
  ): Promise<UeEngineTypeLocation | null> => {
    const read = deps.readEngineTextFile;
    if (!read) return null;
    try {
      const engineRoot = (await deps.getEngineRoot?.()) ?? null;
      return await resolveUeEngineTypeLocation(word, engineRoot, read, engineCache);
    } catch {
      return null;
    }
  };
  const engineLocationToRange = (location: UeEngineTypeLocation) => ({
    uri: monaco.Uri.file(location.path),
    range: {
      startLineNumber: location.line,
      startColumn: 1,
      endLineNumber: location.line,
      endColumn: 1,
    },
  });

  const definitionProvider = {
    provideDefinition: async (model: MinimalModel, position: MinimalPosition) => {
      const root = deps.getWorkspaceRoot();
      if (!root) return null;
      const ctx = prepareLookup(model, position);
      if (!ctx) return null;
      const entries = await resolveEntries(ctx, position.lineNumber);
      if (entries.length === 0) {
        // Workspace has no declaration (engine type): fall back to the
        // engine's own source header when the engine root is resolvable.
        const engineLocation = await engineLocationFor(ctx.word);
        return engineLocation ? [engineLocationToRange(engineLocation)] : null;
      }
      // Single best target only: Monaco's Ctrl+click opens its (unstyled)
      // multi-definition peek widget when a provider returns several. Our
      // F12 handler owns multi-candidate ranking; here one answer keeps the
      // editor-opener jump path.
      return [locationFor(entries[0]!)];
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
      const engineLocation =
        entries.length === 0 ? await engineLocationFor(ctx.word) : null;
      const markdown = formatCppHoverMarkdown(
        ctx.word,
        entries,
        root,
        engineLocation,
        await semanticPending,
      );
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
    /**
     * Same lookup as the definition provider, exposed for the editor's F12
     * handler: ranked targets (best first) so a keypress jumps straight to
     * the top match instead of opening the built-in peek widget. Engine
     * fallback included. Returns null when this lookup does not apply (no
     * workspace root / no word at the caret); [] when C++ has no match.
     */
    async gotoDefinition(
      model: MinimalModel,
      position: MinimalPosition,
    ): Promise<CppGotoTarget[] | null> {
      const root = deps.getWorkspaceRoot();
      if (!root) return null;
      const ctx = prepareLookup(model, position);
      if (!ctx) return null;
      const entries = await resolveEntries(ctx, position.lineNumber);
      if (entries.length > 0) {
        return entries.map((e) => ({ path: e.path, line: e.line }));
      }
      const engineLocation = await engineLocationFor(ctx.word);
      return engineLocation
        ? [{ path: engineLocation.path, line: engineLocation.line }]
        : [];
    },
    async resolveUsageTarget(
      model: MinimalModel,
      position: MinimalPosition,
    ): Promise<CppUsageTarget | null> {
      const ctx = prepareLookup(model, position);
      if (!ctx?.path) return null;
      const local = resolveCppLocalBinding(
        ctx.text,
        position.lineNumber,
        ctx.range.startColumn,
      );
      if (local?.name === ctx.word) {
        return {
          kind: "local",
          word: ctx.word,
          path: ctx.path,
          text: ctx.text,
          binding: local,
        };
      }
      const entries = await resolveEntries(ctx, position.lineNumber);
      const primary = entries[0];
      if (!primary) return null;
      let allEntries = entries;
      if (deps.lookupSymbols) {
        const persisted = await deps.lookupSymbols(ctx.word);
        allEntries = overlayLiveCppSymbols(
          persisted,
          ctx.path,
          ctx.text,
          ctx.word,
        );
      } else if (deps.index) {
        allEntries = deps.index.getEntries(ctx.word);
      }
      const related = allEntries.filter(
        (entry) =>
          entry.name === primary.name &&
          entry.kind === primary.kind &&
          entry.container === primary.container,
      );
      return {
        kind: "symbol",
        word: ctx.word,
        entries: related.length > 0 ? related : [primary],
        primary,
      };
    },
  };
}
