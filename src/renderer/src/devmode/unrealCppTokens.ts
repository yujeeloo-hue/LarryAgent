
import {
  UE_REFLECTION_MACRO_NAMES,
  isUeBoolName,
  isUeSpecifierName,
  ueSpecifierVocabulary,
  type UeReflectionMacroName,
} from "./unrealReflectionSpecifiers.js";

export type StockCppLanguage = {
  keywords?: string[];
  tokenizer: { root: unknown[] } & Record<string, unknown[]>;
  [key: string]: unknown;
};


export const UE_REFLECTION_MACROS: readonly UeReflectionMacroName[] =
  UE_REFLECTION_MACRO_NAMES;

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

export const UE_SPECIFIER_WORDS: readonly string[] = ueSpecifierVocabulary();


const REFLECTION_SET = new Set<string>(UE_REFLECTION_MACROS);
const MACRO_SET = new Set<string>(UE_MACRO_WORDS);

export function isUeReflectionMacro(word: string): boolean {
  return REFLECTION_SET.has(word);
}

export function isUeMacroWord(word: string): boolean {
  return MACRO_SET.has(word);
}

export function isUeSpecifierWord(word: string): boolean {
  return isUeSpecifierName(word);
}

export function looksLikeUeType(word: string): boolean {
  return /^[FAUESTI][A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$/.test(word);
}

export const looksLikeUeBool = isUeBoolName;

const REFLECTION_MACRO_ALT = UE_REFLECTION_MACROS.join("|");


const UE_ROOT_RULES = [
  [
    new RegExp(`\\b(${REFLECTION_MACRO_ALT})\\b(\\s*)(\\()`),
    [
      { token: "annotation.ue" },
      "",
      { token: "delimiter.parenthesis", next: "@ueargs" },
    ],
  ],
  [/\bGENERATED(?:_[A-Z0-9_]+)?\b/, "keyword.ue"],
  [/\b(?:DECLARE|IMPLEMENT|DEFINE)_[A-Z0-9_]+/, "keyword.ue"],
  // Calls must precede the UE name heuristics and the generic identifier rule.
  [
    /\b[a-zA-Z_]\w*(?=\s*\()/,
    {
      cases: {
        "@keywords": { token: "keyword.$0" },
        "@ueMacros": "keyword.ue",
        "@default": "function",
      },
    },
  ],
  [/\b[FAUESTI][A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*\b/, "type.ue"],
  [/\bb[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*\b/, "variable.ue"],
] as unknown[];

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

export function buildUnrealCppLanguage(base: StockCppLanguage): StockCppLanguage {
  const stockRoot = base.tokenizer.root;
  const rawStringRule = stockRoot[0];
  if (!Array.isArray(stockRoot) || rawStringRule === undefined) {
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
