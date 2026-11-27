import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "monaco-editor/editor/standalone/common/monarch/monarchCompile.js";
import { MonarchTokenizer } from "monaco-editor/editor/standalone/common/monarch/monarchLexer.js";
import { language as stockCppLanguage } from "monaco-editor/languages/definitions/cpp/cpp.js";

import {
  UE_EXTRA_KEYWORDS,
  UE_MACRO_WORDS,
  UE_REFLECTION_MACROS,
  UE_SPECIFIER_WORDS,
  buildUnrealCppLanguage,
  isUeMacroWord,
  isUeReflectionMacro,
  isUeSpecifierWord,
  looksLikeUeBool,
  looksLikeUeType,
  type StockCppLanguage,
} from "./unrealCppTokens.ts";
import {
  UE_SPECIFIER_ALIAS_SPELLINGS,
  UE_SPECIFIERS,
} from "./unrealReflectionSpecifiers.ts";

function fakeStockLanguage(): StockCppLanguage {
  return {
    defaultToken: "",
    tokenPostfix: ".cpp",
    keywords: ["class", "public", "virtual", "override"],
    tokenizer: {
      root: [
        [
          /@encoding?R"(?=\()/.source,
          { token: "string.raw" },
        ],
        [
          /[a-zA-Z_]\w*/,
          {
            cases: {
              "@keywords": { token: "keyword.$0" },
              "@default": "identifier",
            },
          },
        ],
      ],
      whitespace: [[/[ \t\r\n]+/, "white"]],
      string: [[/(\\.|[^"\\])+/, "string"]],
    },
  };
}

function cppTokenTypes(source: string, words: string[]): string[] {
  const tokenizer = new MonarchTokenizer(
    {},
    {},
    "cpp",
    compile("cpp", buildUnrealCppLanguage(stockCppLanguage)),
    {
      getValue: () => 20_000,
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
  );
  try {
    let state = tokenizer.getInitialState();
    const lines = source.split("\n").map((line) => {
      const result = tokenizer.tokenize(line, true, state);
      state = result.endState;
      return { line, tokens: result.tokens };
    });
    return words.map((word) => {
      const entry = lines.find(({ line }) => line.includes(word));
      assert.ok(entry, `missing word: ${word}`);
      const offset = entry.line.indexOf(word);
      const token = entry.tokens.findLast((token) => token.offset <= offset);
      assert.ok(token, `missing token: ${word}`);
      return token.type;
    });
  } finally {
    tokenizer.dispose();
  }
}

test("C++ call names have function tokens while receivers and fields remain identifiers", () => {
  assert.deepEqual(
    cppTokenTypes(
      `RenderEffectMgr->CancelAllMeshModification();
RenderEffectMgr.CancelOne ();
Effects::CancelPending();
CancelEverything();
RenderEffectMgr->IsActive;
RenderEffectMgr->UIRefresh();`,
      ["RenderEffectMgr", "CancelAllMeshModification", "CancelOne", "Effects", "CancelPending", "CancelEverything", "IsActive", "UIRefresh"],
    ),
    ["identifier.cpp", "function.cpp", "function.cpp", "identifier.cpp", "function.cpp", "function.cpp", "identifier.cpp", "function.cpp"],
  );
});

test("C++ call coloring preserves keywords, Unreal macros, and type references", () => {
  assert.deepEqual(
    cppTokenTypes(
      `if (Ready) { sizeof(Value); }
UE_LOG(LogTemp, Warning, TEXT("message"));
check(IsValid());
GENERATED_BODY()
DECLARE_DYNAMIC_MULTICAST_DELEGATE(FOnReady);
UFUNCTION(BlueprintCallable, meta=(DisplayName="Run"))
void Run();
FVector Position;`,
      ["if", "sizeof", "UE_LOG", "TEXT", "check", "IsValid", "GENERATED_BODY", "DECLARE_DYNAMIC_MULTICAST_DELEGATE", "UFUNCTION", "BlueprintCallable", "DisplayName", "Run();", "FVector"],
    ),
    ["keyword.if.cpp", "keyword.sizeof.cpp", "keyword.ue.cpp", "keyword.ue.cpp", "keyword.ue.cpp", "function.cpp", "keyword.ue.cpp", "keyword.ue.cpp", "annotation.ue.cpp", "annotation.ue.meta.cpp", "annotation.ue.meta.cpp", "function.cpp", "type.ue.cpp"],
  );
});

test("C++ call-like text stays inside comments, strings, and multiline raw strings", () => {
  assert.deepEqual(
    cppTokenTypes(
      `// CancelInLineComment()
/* CancelInBlockComment()
   StillInComment() */
const char* Text = "CancelInString()";
const auto Raw = R"cpp(CancelInRawString()
StillInRawString())cpp";
CancelAfterRawString();`,
      ["CancelInLineComment", "CancelInBlockComment", "StillInComment", "CancelInString", "CancelInRawString", "StillInRawString", "CancelAfterRawString"],
    ),
    ["comment.cpp", "comment.cpp", "comment.cpp", "string.cpp", "string.raw.cpp", "string.raw.cpp", "function.cpp"],
  );
});

test("UE type heuristic accepts engine and project conventions", () => {
  for (const word of [
    "FVector",
    "FVector2D",
    "FString",
    "AActor",
    "ACharacter",
    "ANFCharacter",
    "UWorld",
    "UNFHealthComponent",
    "ETraceTypeQuery",
    "IAbilityInterface",
    "TArray",
    "TObjectPtr",
    "SWidget",
    "SNFButton",
    "FLinearColor",
  ]) {
    assert.ok(looksLikeUeType(word), `expected type: ${word}`);
  }
});

test("UE type heuristic rejects non-types", () => {
  for (const word of [
    "TRUE",
    "FALSE",
    "INT_MAX",
    "UE_BUILD_DEBUG",
    "BeginPlay",
    "OnConstruction",
    "Super",
    "bCanEverTick",
    "playerController",
    "TEXT",
    "UPROPERTY",
    "R",
    "Pimpl",
  ]) {
    assert.ok(!looksLikeUeType(word), `expected non-type: ${word}`);
  }
});

test("UE bool heuristic matches UE bool naming only", () => {
  assert.ok(looksLikeUeBool("bReplicates"));
  assert.ok(looksLikeUeBool("bCanEverTick"));
  assert.ok(looksLikeUeBool("bIsActive"));
  assert.ok(!looksLikeUeBool("b"));
  assert.ok(!looksLikeUeBool("bX"));
  assert.ok(!looksLikeUeBool("bUISTHREE"));
  assert.ok(!looksLikeUeBool("BeginPlay"));
  assert.ok(!looksLikeUeBool("blueprintClass"));
});

test("reflection/macro/specifier membership checks", () => {
  assert.ok(isUeReflectionMacro("UPROPERTY"));
  assert.ok(isUeReflectionMacro("UFUNCTION"));
  assert.ok(!isUeReflectionMacro("GENERATED_BODY"));
  assert.ok(isUeMacroWord("GENERATED_BODY"));
  assert.ok(isUeMacroWord("UE_LOG"));
  assert.ok(isUeMacroWord("TEXT"));
  assert.ok(isUeMacroWord("check"));
  assert.ok(isUeMacroWord("ensureMsgf"));
  assert.ok(!isUeMacroWord("checkThat"));
  assert.ok(isUeSpecifierWord("EditAnywhere"));
  assert.ok(isUeSpecifierWord("meta"));
  assert.ok(isUeSpecifierWord("BlueprintReadWrite"));
  assert.ok(isUeSpecifierWord("ReplicatedUsing"));
  assert.ok(!isUeSpecifierWord("EditAnywhereMaybe"));
});

test("word lists have no duplicates and stay sorted-free but unique", () => {
  const lists = [
    UE_REFLECTION_MACROS,
    UE_MACRO_WORDS,
    UE_SPECIFIER_WORDS,
    UE_EXTRA_KEYWORDS,
  ];
  for (const list of lists) {
    const seen = new Set<string>();
    for (const word of list) {
      assert.ok(!seen.has(word), `duplicate word: ${word}`);
      seen.add(word);
    }
  }
});

test("colorizer specifier words are derived from the reflection vocabulary", () => {
  const declared = Object.values(UE_SPECIFIERS).flatMap((list) =>
    list.map((specifier) => specifier.name),
  );
  for (const word of [...declared, ...UE_SPECIFIER_ALIAS_SPELLINGS]) {
    assert.ok(UE_SPECIFIER_WORDS.includes(word), `missing from colorizer: ${word}`);
    assert.ok(isUeSpecifierWord(word), `not colorized: ${word}`);
  }
  assert.ok(!isUeSpecifierWord("EditAnywhereMaybe"));
});

test("buildUnrealCppLanguage keeps raw-string rule first and layers UE rules", () => {
  const base = fakeStockLanguage();
  const rawStringRule = base.tokenizer.root[0];
  const stockIdentifier = base.tokenizer.root[1];
  const extended = buildUnrealCppLanguage(base);

  const root = extended.tokenizer.root as unknown[];
  assert.notStrictEqual(root[0], undefined);
  assert.strictEqual(root[0], rawStringRule, "raw-string rule must stay first");

  const reflectionRuleIdx = root.findIndex(
    (rule) =>
      Array.isArray(rule) &&
      typeof rule[0] === "object" &&
      String((rule[0] as RegExp).source).includes("UPROPERTY"),
  );
  assert.ok(reflectionRuleIdx > 0, "reflection rule injected");
  assert.notStrictEqual(root[reflectionRuleIdx], rawStringRule);

  const identifierIdxs = root
    .map((rule, idx) => ({ rule, idx }))
    .filter(({ rule }) => {
      if (!Array.isArray(rule)) return false;
      const [pattern, action] = rule as unknown[];
      if (!(pattern instanceof RegExp) || pattern.source !== "[a-zA-Z_]\\w*")
        return false;
      return JSON.stringify(action).includes("ueMacros");
    })
    .map(({ idx }) => idx);
  assert.strictEqual(identifierIdxs.length, 1, "exactly one UE identifier rule");
  assert.ok(identifierIdxs[0] > 0, "identifier rule after raw-string rule");
  const stockIdx = root.indexOf(stockIdentifier);
  assert.ok(stockIdx > identifierIdxs[0], "stock identifier rule still present after ours");

  assert.strictEqual((base.tokenizer.root as unknown[]).length, 2);
  assert.ok(!(base.tokenizer as Record<string, unknown>).ueargs);

  assert.deepStrictEqual(extended.ueMacros, UE_MACRO_WORDS);
  assert.deepStrictEqual(extended.ueSpecifiers, UE_SPECIFIER_WORDS);
  assert.ok(Array.isArray(extended.tokenizer.ueargs));
  assert.ok((extended.keywords ?? []).includes("Super"));
  assert.ok((extended.keywords ?? []).includes("override"));
});

test("reflection rule consumes the opening paren for balanced ueargs nesting", () => {
  const extended = buildUnrealCppLanguage(fakeStockLanguage());
  const root = extended.tokenizer.root as Array<[unknown, unknown]>;
  const rule = root.find(
    (entry) =>
      Array.isArray(entry) &&
      entry[0] instanceof RegExp &&
      entry[0].source.includes("UPROPERTY"),
  ) as [RegExp, unknown[]];
  assert.ok(rule, "reflection rule exists");
  assert.match("UPROPERTY(", rule[0] as RegExp);
  assert.doesNotMatch("UPROPERTYX(", rule[0] as RegExp);
  const actions = rule[1] as Array<{ token?: string; next?: string } | string>;
  assert.strictEqual(actions[0].token, "annotation.ue");
  const parenAction = actions[actions.length - 1];
  assert.strictEqual(typeof parenAction === "object" ? parenAction.next : undefined, "@ueargs");

  const ueargs = extended.tokenizer.ueargs as Array<[unknown, unknown]>;
  const parenPush = ueargs.find(
    (entry) => Array.isArray(entry) && entry[0] instanceof RegExp && entry[0].source === "\\(",
  ) as [RegExp, { next: string }];
  assert.strictEqual(parenPush?.[1]?.next, "@ueargs");
  const parenPop = ueargs.find(
    (entry) => Array.isArray(entry) && entry[0] instanceof RegExp && entry[0].source === "\\)",
  ) as [RegExp, { next: string }];
  assert.strictEqual(parenPop?.[1]?.next, "@pop");
  const specRule = ueargs.find(
    (entry) => Array.isArray(entry) && JSON.stringify(entry[1]).includes("ueSpecifiers"),
  );
  assert.ok(specRule, "specifier cases rule inside ueargs");
});

test("macro-family regex rules cover GENERATED_/DECLARE_/IMPLEMENT_ families", () => {
  const extended = buildUnrealCppLanguage(fakeStockLanguage());
  const root = extended.tokenizer.root as Array<[unknown, unknown]>;
  const generatedRule = root.find(
    (entry) =>
      Array.isArray(entry) &&
      entry[0] instanceof RegExp &&
      entry[0].source.includes("GENERATED"),
  ) as [RegExp, unknown];
  assert.ok(generatedRule, "GENERATED rule exists");
  assert.match("GENERATED_BODY", generatedRule[0] as RegExp);
  assert.match("GENERATED_USTRUCT_BODY", generatedRule[0] as RegExp);
  assert.doesNotMatch("GENERATED_body", generatedRule[0] as RegExp);

  const declareRule = root.find(
    (entry) =>
      Array.isArray(entry) &&
      entry[0] instanceof RegExp &&
      String((entry[0] as RegExp).source).includes("DECLARE"),
  ) as [RegExp, unknown];
  assert.ok(declareRule, "DECLARE rule exists");
  assert.match("DECLARE_DYNAMIC_MULTICAST_DELEGATE_FourParams", declareRule[0] as RegExp);
  assert.match("IMPLEMENT_PRIMARY_GAME_MODULE", declareRule[0] as RegExp);
  assert.doesNotMatch("DECLARE_", declareRule[0] as RegExp);
});
