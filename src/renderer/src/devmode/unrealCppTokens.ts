/**
 * Unreal C++ token colorization — extends the stock Monaco Monarch `cpp`
 * tokenizer with Unreal Engine vocabulary. Pure data + pure helpers (no
 * monaco import) so node --test can exercise it without the editor bundle.
 *
 * Token classes produced (themed in monacoSetup.defineTheme):
 * - `annotation.ue`       reflection macros: UPROPERTY( UFUNCTION( …
 * - `annotation.ue.meta`  specifiers inside those parens: EditAnywhere, meta=(…)
 * - `keyword.ue`          GENERATED_BODY / UE_LOG / DECLARE_* / check… / TEXT
 * - `type.ue`             UE naming convention: FVector, AActor, TArray, SWidget…
 * - `variable.ue`         UE bool convention: bReplicates, bCanEverTick
 *
 * Registration: monacoSetup.loadMonaco calls
 * `setMonarchTokensProvider("cpp", buildUnrealCppLanguage(stockCpp))`.
 */

/**
 * Stock cpp Monarch definition shape (opaque rule tuples — Monarch owns the
 * grammar). Only the fields we clone are typed.
 */
export type StockCppLanguage = {
  keywords?: string[];
  tokenizer: { root: unknown[] } & Record<string, unknown[]>;
  [key: string]: unknown;
};

// ------------------------------------------------------------- vocabulary

/** Reflection macros whose parenthesised argument list gets its own state. */
export const UE_REFLECTION_MACROS = [
  "UCLASS",
  "UENUM",
  "UFUNCTION",
  "UINTERFACE",
  "UMETA",
  "UPARAM",
  "UPROPERTY",
  "USTRUCT",
  "UDELEGATE",
] as const;

/** Word-matched UE macros (DECLARE_/IMPLEMENT_/GENERATED_* covered by regex). */
export const UE_MACRO_WORDS = [
  "GENERATED_BODY",
  "GENERATED_UCLASS_BODY",
  "GENERATED_USTRUCT_BODY",
  "GENERATED_UINTERFACE_BODY",
  "UE_LOG",
  "UE_LOG_VERBATIM",
  "DEFINE_LOG_CATEGORY",
  "DECLARE_LOG_CATEGORY_EXTERN",
  "DECLARE_LOG_CATEGORY_CLASS",
  "TEXT",
  "check",
  "checkf",
  "checkCode",
  "checkNoEntry",
  "checkNoReentry",
  "ensure",
  "ensureMsgf",
  "ensureAlways",
  "ensureAlwaysMsgf",
  "ensureNoMessage",
  "verify",
  "verifyf",
] as const;

/** C++ keywords UE adds that stock Monarch cpp lacks. */
export const UE_EXTRA_KEYWORDS = [
  "Super",
  "int8",
  "int16",
  "int32",
  "int64",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
] as const;

/**
 * Specifiers valid inside UPROPERTY/UFUNCTION/UCLASS/USTRUCT/UENUM parens
 * (and `meta=(…)`). Case-sensitive — UE accepts both `Config`/`config` style
 * for several, so both spellings are listed where they differ.
 */
export const UE_SPECIFIER_WORDS = [
  "AdvancedDisplay",
  "AllowPrivateAccess",
  "AssetRegistrySearchable",
  "BlueprintAssignable",
  "BlueprintCallable",
  "BlueprintImplementableEvent",
  "BlueprintNativeEvent",
  "BlueprintPure",
  "BlueprintReadWrite",
  "BlueprintReadOnly",
  "BlueprintSetter",
  "BlueprintGetter",
  "BlueprintType",
  "Blueprintable",
  "Category",
  "ClampMax",
  "ClampMin",
  "Config",
  "config",
  "customconstructor",
  "DontCollapseCategories",
  "DuplicateTransient",
  "EditAnywhere",
  "EditDefaultsOnly",
  "EditFixedSize",
  "EditInlineNew",
  "EditInstanceOnly",
  "Exec",
  "ExposeOnSpawn",
  "ExposeFunctionOnSpawn",
  "ForceUnits",
  "GlobalUserConfig",
  "hidecategories",
  "Instanced",
  "meta",
  "MinimalAPI",
  "NetMulticast",
  "NoClear",
  "Reliable",
  "Replicated",
  "ReplicatedUsing",
  "SaveGame",
  "Server",
  "showcategories",
  "SimpleDisplay",
  "Transient",
  "UIMax",
  "UIMin",
  "Units",
  "Unreliable",
  "VisibleAnywhere",
  "VisibleDefaultsOnly",
  "VisibleInstanceOnly",
  "WithValidation",
  "Within",
] as const;

// --------------------------------------------------------------- helpers

const REFLECTION_SET = new Set<string>(UE_REFLECTION_MACROS);
const MACRO_SET = new Set<string>(UE_MACRO_WORDS);
const SPECIFIER_SET = new Set<string>(UE_SPECIFIER_WORDS);

/** True for UPROPERTY/UFUNCTION/… reflection macros (word-level check). */
export function isUeReflectionMacro(word: string): boolean {
  return REFLECTION_SET.has(word);
}

/** True for UE macros with no jump target / no argument coloring. */
export function isUeMacroWord(word: string): boolean {
  return MACRO_SET.has(word);
}

/** True for specifiers that color inside reflection-macro parens. */
export function isUeSpecifierWord(word: string): boolean {
  return SPECIFIER_SET.has(word);
}

/**
 * UE type-name heuristic: single prefix letter from {F,U,A,E,I,T,S} followed
 * by an uppercase letter, with at least one lowercase letter somewhere —
 * covers engine AND project classes (ANFCharacter, UNFHealthComponent…).
 * All-caps macros (TRUE, INT_MAX, UE_BUILD_DEBUG) and CamelCase verbs
 * (BeginPlay, OnConstruction) fail the pattern, so they stay plain.
 */
export function looksLikeUeType(word: string): boolean {
  return /^[FAUESTI][A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$/.test(word);
}

/** UE bool convention: `b` + PascalCase remainder (bReplicates, bIsActive). */
export function looksLikeUeBool(word: string): boolean {
  return /^b[A-Z][A-Za-z0-9_]*[a-z]/.test(word);
}

const REFLECTION_MACRO_ALT = UE_REFLECTION_MACROS.join("|");

// ------------------------------------------------------------ monarch glue

/**
 * Rules prepended to the stock `root` (AFTER the raw-string rule — see
 * buildUnrealCppLanguage). Ordered: reflection macros → macro-family regexes
 * → type/bool heuristics. Each matches before the identifier-case rule.
 */
const UE_ROOT_RULES = [
  // UPROPERTY(…)/UFUNCTION(…) — consume the `(` so @ueargs nesting stays
  // balanced: inner `(` push, matching `)` pop, macro-closing `)` exits.
  [
    new RegExp(`\\b(${REFLECTION_MACRO_ALT})\\b(\\s*)(\\()`),
    [
      { token: "annotation.ue" },
      "",
      { token: "delimiter.parenthesis", next: "@ueargs" },
    ],
  ],
  // GENERATED_BODY / GENERATED_UCLASS_BODY / GENERATED_USTRUCT_BODY …
  [/\bGENERATED(?:_[A-Z0-9_]+)?\b/, "keyword.ue"],
  // DECLARE_DYNAMIC_MULTICAST_DELEGATE_FourParams / IMPLEMENT_CLASS /
  // DEFINE_LOG_CATEGORY … (no trailing \b — some families end in lowercase,
  // e.g. `_FourParams`, and a boundary there would block the whole match).
  [/\b(?:DECLARE|IMPLEMENT|DEFINE)_[A-Z0-9_]+/, "keyword.ue"],
  // UE type naming: FVector, AActor, TObjectPtr<FVector>, SNFWidget …
  [/\b[FAUESTI][A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*\b/, "type.ue"],
  // UE bool naming: bCanEverTick, bReplicates …
  [/\bb[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*\b/, "variable.ue"],
] as unknown[];

/**
 * Argument-list state entered from a reflection macro. Nested `meta=(…)`
 * pushes another level; the macro's closing paren pops back to root.
 * Unknown words stay plain identifiers so nothing inside reads wrong.
 */
const UE_ARGS_RULES = [
  { include: "@whitespace" },
  [/"/, { token: "string", next: "@string" }],
  [/\(/, { token: "delimiter.parenthesis", next: "@ueargs" }],
  [/\)/, { token: "delimiter.parenthesis", next: "@pop" }],
  [
    /[a-zA-Z_]\w*/,
    {
      cases: {
        "@ueSpecifiers": "annotation.ue.meta",
        "@default": "identifier",
      },
    },
  ],
  [/[=,]/, "delimiter"],
] as unknown[];

/**
 * Identifier rule that supersedes the stock one (kept first so the raw-string
 * rule still wins). Stock keyword behavior is preserved verbatim.
 */
const UE_IDENTIFIER_RULE = [
  /[a-zA-Z_]\w*/,
  {
    cases: {
      "@keywords": { token: "keyword.$0" },
      "@ueMacros": "keyword.ue",
      "@default": "identifier",
    },
  },
] as unknown;

/**
 * Clone the stock cpp Monarch language with Unreal vocabulary layered in.
 * Structure contract (tested):
 * - stock root[0] (C++11 raw strings) stays first — identifier-class rules
 *   must not eat the `R` of `R"(...)"`;
 * - UE rules follow, then our identifier rule, then the stock remainder
 *   (its identifier rule is dead code, harmless);
 * - `ueargs` state + `@ueMacros`/`@ueSpecifiers` word arrays are attached.
 */
export function buildUnrealCppLanguage(base: StockCppLanguage): StockCppLanguage {
  const stockRoot = base.tokenizer.root;
  const rawStringRule = stockRoot[0];
  if (!Array.isArray(stockRoot) || rawStringRule === undefined) {
    // Defensive: unexpected stock layout — fall back to append-only.
    return {
      ...base,
      keywords: [...(base.keywords ?? []), ...UE_EXTRA_KEYWORDS],
      tokenizer: {
        ...base.tokenizer,
        root: [...UE_ROOT_RULES, ...stockRoot],
        ueargs: UE_ARGS_RULES,
      },
      ueMacros: UE_MACRO_WORDS,
      ueSpecifiers: UE_SPECIFIER_WORDS,
    };
  }
  return {
    ...base,
    keywords: [...(base.keywords ?? []), ...UE_EXTRA_KEYWORDS],
    tokenizer: {
      ...base.tokenizer,
      root: [rawStringRule, ...UE_ROOT_RULES, UE_IDENTIFIER_RULE, ...stockRoot.slice(1)],
      ueargs: UE_ARGS_RULES,
    },
    ueMacros: UE_MACRO_WORDS,
    ueSpecifiers: UE_SPECIFIER_WORDS,
  };
}
