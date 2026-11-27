
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPLETION_KIND_MAP,
  canReuseIndexSlot,
  clangdInsertFor,
  indexHitsTruncated,
  indexSiteKey,
  mergeIndexHits,
  retainCachedCompletionItem,
  registerClangdProviders,
  signatureParameterRanges,
} from "./clangdFeatures.js";
import type { CppIndexCompletionHit } from "./cppTextCompletion.js";

test("index slots are reused while the typed word extends the query prefix", () => {
  const slot = { key: "k", queryPrefix: "G", truncated: false, bare: true };
  assert.equal(canReuseIndexSlot(slot, "k", "G"), true);
  assert.equal(canReuseIndexSlot(slot, "k", "get"), true, "case-insensitive extension");
  assert.equal(canReuseIndexSlot(slot, "other", "Ge"), false, "different site");
  assert.equal(canReuseIndexSlot(slot, "k", "X"), false, "prefix no longer extends");
  assert.equal(canReuseIndexSlot({ ...slot, queryPrefix: "Get" }, "k", "Ge"), false, "backspace re-asks");
});

test("a capped answer is re-queried on the next letter, but kept for its own prefix", () => {
  const slot = { key: "k", queryPrefix: "G", truncated: true, bare: true };
  assert.equal(canReuseIndexSlot(slot, "k", "G"), true);
  assert.equal(canReuseIndexSlot(slot, "k", "GetW"), false);
});

test("a bare word asked with no letters re-queries on the first one; members do not", () => {
  const bare = { key: "k", queryPrefix: "", truncated: false, bare: true };
  assert.equal(canReuseIndexSlot(bare, "k", "G"), false);
  assert.equal(canReuseIndexSlot({ ...bare, queryPrefix: "G" }, "k", "GetAct"), true);
  const member = { key: "k", queryPrefix: "", truncated: false, bare: false };
  assert.equal(canReuseIndexSlot(member, "k", "GetActorLocation"), true);
});

test("truncation is detected from either index's row caps", () => {
  const rows = (n: number, container?: string): CppIndexCompletionHit[] =>
    Array.from({ length: n }, (_, i) => ({
      name: `N${i}`,
      kind: "function" as const,
      ...(container ? { container } : {}),
    }));
  assert.equal(indexHitsTruncated(rows(10, "AActor"), rows(10)), false);
  assert.equal(indexHitsTruncated([], rows(150)), true, "text index limit");
  assert.equal(indexHitsTruncated(rows(95, "AActor"), []), true, "one clangd scope query capped");
  assert.equal(indexHitsTruncated([...rows(50, "AActor"), ...rows(50, "UObject")], []), false);
  assert.equal(indexHitsTruncated(rows(60), []), true, "clangd globals capped");
});

test("site keys separate receivers on the same column", () => {
  const a = indexSiteKey("f.cpp", 3, 10, { prefix: "", access: "member", name: "Weapon" });
  const b = indexSiteKey("f.cpp", 3, 10, { prefix: "", access: "member", name: "Target" });
  const c = indexSiteKey("f.cpp", 3, 10, { prefix: "G", access: "none" });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test("clangd-index hits lead; text twins lend params; no twin → arity unknown", () => {
  const merged = mergeIndexHits(
    [
      { name: "Attack", kind: "function", container: "ANFCharacter", depth: 0 },
      { name: "GetActorLocation", kind: "function", container: "AActor", depth: 3 },
      { name: "Health", kind: "variable", container: "ANFCharacter", depth: 0 },
    ],
    [
      { name: "Attack", kind: "function", container: "ANFCharacter", params: "float Damage", returnType: "void", depth: 0 },
      { name: "Reload", kind: "function", container: "ANFCharacter", depth: 0 },
    ],
  );
  assert.deepEqual(merged.map((h) => h.name), ["Attack", "GetActorLocation", "Health", "Attack", "Reload"]);
  assert.equal(merged[0]!.params, "float Damage");
  assert.equal(merged[0]!.returnType, "void");
  assert.equal(merged[0]!.paramsUnknown, undefined);
  assert.equal(merged[1]!.paramsUnknown, true);
  assert.equal(merged[2]!.paramsUnknown, undefined, "variables never carry arity");
});

const METHOD = 2;
const VARIABLE = 6;
const CLASS = 7;

test("plain (non-snippet) items insert clangd's text verbatim", () => {
  assert.deepEqual(
    clangdInsertFor({ label: "bIsAlive", kind: VARIABLE, insertText: "bIsAlive" }),
    { insertText: "bIsAlive", isSnippet: false, showParameterHints: false },
  );
  assert.deepEqual(clangdInsertFor({ label: "FVector", kind: CLASS }), {
    insertText: "FVector",
    isSnippet: false,
    showParameterHints: false,
  });
});

test("parameterless calls insert empty parens with the caret after them", () => {
  assert.deepEqual(
    clangdInsertFor({ label: "GetWorld", kind: METHOD, insertText: "GetWorld()", isSnippet: true }),
    { insertText: "GetWorld()", isSnippet: true, showParameterHints: false },
  );
});

test("calls with arguments collapse placeholders to Foo($0) and show hints", () => {
  assert.deepEqual(
    clangdInsertFor({
      label: "ApplyDamage",
      kind: METHOD,
      insertText: "ApplyDamage(${1:float Damage}, ${2:int32 StackCount})",
      isSnippet: true,
    }),
    { insertText: "ApplyDamage($0)", isSnippet: true, showParameterHints: true },
  );
});

test("nested template / function-type arguments still collapse as one group", () => {
  const r = clangdInsertFor({
    label: "ForEach",
    kind: METHOD,
    insertText: "ForEach(${1:TFunction<void(int32, float)> Body}, ${2:TArray<FString> &Out})$0",
    isSnippet: true,
  });
  assert.equal(r.insertText, "ForEach($0)");
  assert.equal(r.showParameterHints, true);
});

test("signature suffix never leaks into the insert (const / return type)", () => {
  const r = clangdInsertFor({
    label: "GetActorLocation",
    kind: METHOD,
    insertText: "GetActorLocation()",
    isSnippet: true,
  });
  assert.equal(r.insertText, "GetActorLocation()");
});

test("trailing template argument lists collapse to <$0>", () => {
  assert.deepEqual(
    clangdInsertFor({
      label: "TArray",
      kind: CLASS,
      insertText: "TArray<${1:typename InElementType}>",
      isSnippet: true,
    }),
    { insertText: "TArray<$0>", isSnippet: true, showParameterHints: false },
  );
});

test("snippets without a trailing group pass through", () => {
  assert.deepEqual(
    clangdInsertFor({ label: "Foo", kind: METHOD, insertText: "Foo", isSnippet: true }),
    { insertText: "Foo", isSnippet: true, showParameterHints: false },
  );
});

test("signature parameter ranges locate each parameter left-to-right", () => {
  const label = "void ApplyDamage(float Damage, float Damage2)";
  const ranges = signatureParameterRanges(label, ["float Damage", "float Damage2"]);
  assert.deepEqual(ranges.map(([s, e]) => label.slice(s, e)), [
    "float Damage",
    "float Damage2",
  ]);
  assert.ok(ranges[1]![0] > ranges[0]![0]);
  assert.deepEqual(signatureParameterRanges(label, ["missing"]), [[0, 0]]);
});

test("cached bare-identifier rows keep a UE type whose letter was not typed", () => {
  const character = { label: "ANFCharacter", sortText: "40000" };
  assert.equal(retainCachedCompletionItem(character, "NFCharacter"), true);
  assert.equal(retainCachedCompletionItem(character, "NFCha"), true);
  assert.equal(retainCachedCompletionItem(character, "ANF"), true);
  assert.equal(retainCachedCompletionItem({ label: "Attack", sortText: "00001" }, "NFChar"), false);
  assert.equal(
    retainCachedCompletionItem({ label: "ANFCharacter", sortText: "10000" }, "NFChar"),
    false,
    "band 1 locals are rebuilt every keystroke",
  );
  assert.equal(retainCachedCompletionItem({ label: "return", sortText: "50000" }, "ret"), false);
});

test("LSP completion kinds map onto monaco's enum", () => {
  assert.equal(COMPLETION_KIND_MAP[2], 0);
  assert.equal(COMPLETION_KIND_MAP[3], 1);
  assert.equal(COMPLETION_KIND_MAP[6], 4);
  assert.equal(COMPLETION_KIND_MAP[7], 5);
  assert.equal(COMPLETION_KIND_MAP[22], 6);
});


type CompletionSuggestion = {
  label: unknown;
  insertText: string;
  kind: number;
  additionalTextEdits?: { range: Record<string, number>; text: string }[];
};

type CompletionProvider = {
  triggerCharacters: string[];
  provideCompletionItems(
    model: unknown,
    position: { lineNumber: number; column: number },
    context?: { triggerCharacter?: string; triggerKind?: number },
  ): Promise<{ suggestions: CompletionSuggestion[] } | null>;
};

function modelAt(text: string, caret: number) {
  const lines = text.split("\n");
  const lineIndex = text.slice(0, caret).split("\n").length - 1;
  const position = { lineNumber: lineIndex + 1, column: caret - (text.slice(0, caret).lastIndexOf("\n") + 1) + 1 };
  const model = {
    uri: { scheme: "file", path: "/proj/Source/NFCharacter.h" },
    getValue: () => text,
    getOffsetAt: () => caret,
    getWordAtPosition: () => {
      const before = (lines[lineIndex] ?? "").slice(0, position.column - 1);
      const word = /[A-Za-z0-9_]+$/.exec(before)?.[0];
      return word
        ? { word, startColumn: position.column - word.length, endColumn: position.column }
        : null;
    },
  };
  return { model, position };
}

function completionProviderOf(): CompletionProvider {
  let captured: CompletionProvider | null = null;
  const monaco = {
    CompletionItemKind: { Field: 5 },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    languages: {
      registerCompletionItemProvider: (_languageId: string, provider: CompletionProvider) => {
        captured = provider;
        return { dispose() {} };
      },
      registerHoverProvider: () => ({ dispose() {} }),
      registerSignatureHelpProvider: () => ({ dispose() {} }),
    },
    editor: { getEditors: () => [] },
  };
  registerClangdProviders(monaco as never, { getWorkspaceRoot: () => "/proj", registerHover: false });
  assert.ok(captured, "completion provider registered");
  return captured!;
}

test("completion offers Unreal specifiers inside UPROPERTY( … )", async () => {
  const provider = completionProviderOf();
  assert.ok(provider.triggerCharacters.includes(","), "`,` retriggers the list");
  const text = "UPROPERTY(EditA)";
  const { model, position } = modelAt(text, "UPROPERTY(EditA".length);
  const result = await provider.provideCompletionItems(model, position);
  assert.deepEqual(
    result?.suggestions.map((suggestion) => suggestion.insertText),
    ["EditAnywhere"],
  );
});

test("`,` triggers specifiers after a comma, and nothing outside a macro", async () => {
  const provider = completionProviderOf();
  const macro = "UPROPERTY(EditAnywhere, )";
  const inMacro = modelAt(macro, "UPROPERTY(EditAnywhere, ".length);
  const after = await provider.provideCompletionItems(inMacro.model, inMacro.position, {
    triggerCharacter: ",",
  });
  assert.ok(
    after?.suggestions.some((suggestion) => suggestion.insertText === "BlueprintReadWrite"),
    "specifiers listed after a comma",
  );

  const call = "ApplyDamage(1, )";
  const inCall = modelAt(call, "ApplyDamage(1, ".length);
  assert.equal(
    await provider.provideCompletionItems(inCall.model, inCall.position, { triggerCharacter: "," }),
    null,
    "a comma in ordinary code never opens a list",
  );
});


test("a type completion carries the #include it needs", async () => {
  const provider = completionProviderOf();
  const includeDirs = ["/proj/Source", "/proj/Engine/Source/Runtime/Engine/Public"];
  installBridge(includeDirs, [
    {
      name: "UStaticMeshComponent",
      kind: "class",
      path: "/proj/Engine/Source/Runtime/Engine/Public/Components/StaticMeshComponent.h",
      line: 1,
    },
  ]);
  try {
    const text = ['#include "CoreMinimal.h"', "", "UStaticMesh"].join("\n");
    const { model, position } = modelAt(text, text.length);
    const cold = await provider.provideCompletionItems(model, position, { triggerKind: 0 });
    assert.equal(
      cold?.suggestions.find((entry) => JSON.stringify(entry.label).includes("UStaticMeshComponent"))
        ?.additionalTextEdits,
      undefined,
      "cold cache carries no edits",
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await provider.provideCompletionItems(model, position, { triggerKind: 0 });
    const suggestion = result?.suggestions.find(
      (entry) => JSON.stringify(entry.label).includes("UStaticMeshComponent"),
    );
    assert.ok(suggestion, "type offered");
    assert.deepEqual(suggestion.additionalTextEdits, [
      {
        range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
        text: '#include "Components/StaticMeshComponent.h"\n',
      },
    ]);
    assert.match(
      JSON.stringify(suggestion.label),
      /#include \\"Components\/StaticMeshComponent\.h\\"/,
      "the list shows which header will be added",
    );
  } finally {
    clearBridge();
  }
});

test("no include edit once the header is there or the symbol has no header path", async () => {
  const provider = completionProviderOf();
  installBridge(["E:/NF/Source/NF/Public"], [
    {
      name: "UStaticMeshComponent",
      kind: "class",
      path: "E:/NF/Source/NF/Public/UStaticMeshComponent.h",
      line: 1,
    },
  ]);
  try {
    const text = ['#include "UStaticMeshComponent.h"', "", "UStaticMesh"].join("\n");
    const { model, position } = modelAt(text, text.length);
    await provider.provideCompletionItems(model, position, { triggerKind: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await provider.provideCompletionItems(model, position, { triggerKind: 0 });
    const suggestion = result?.suggestions.find(
      (entry) => JSON.stringify(entry.label).includes("UStaticMeshComponent"),
    );
    assert.ok(suggestion, "type still offered");
    assert.equal(suggestion.additionalTextEdits, undefined, "already included");
  } finally {
    clearBridge();
  }
});

type FakeHit = { name: string; kind: string; path: string; line: number };

function installBridge(includeDirs: string[], hits: FakeHit[]): void {
  (globalThis as { window?: unknown }).window = {
    jellybot: {
      clangdStatus: async () => ({ ok: true }),
      clangdCompletion: async () => ({ ok: true, items: [] }),
      clangdIndexComplete: async () => hits,
      completeCppSymbols: async () => hits,
      clangdIncludeDirs: async () => ({ ok: true, dirs: includeDirs }),
    },
  };
}

function clearBridge(): void {
  delete (globalThis as { window?: unknown }).window;
}

function fakeSuggestEditor(model: unknown, position: { lineNumber: number; column: number }) {
  const calls: string[] = [];
  const state = { value: 0 };
  const contribution = {
    model: {
      get state() {
        return state.value;
      },
      trigger(options: { auto: boolean }) {
        calls.push(`retrigger:${options.auto}`);
      },
    },
    cancelSuggestWidget() {
      calls.push("cancel");
      state.value = 0;
    },
  };
  const editor = {
    getModel: () => model,
    getPosition: () => position,
    hasTextFocus: () => true,
    getContribution: (id: string) =>
      id === "editor.contrib.suggestController" ? contribution : null,
    trigger: (_source: string, handlerId: string) => {
      calls.push(handlerId);
      state.value = 0;
    },
  };
  return { editor, calls, state };
}

function providersWithEditor(editor: unknown): {
  provider: CompletionProvider;
  registration: ReturnType<typeof registerClangdProviders>;
} {
  let captured: CompletionProvider | null = null;
  const monaco = {
    CompletionItemKind: { Field: 5 },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    languages: {
      registerCompletionItemProvider: (_languageId: string, provider: CompletionProvider) => {
        captured = provider;
        return { dispose() {} };
      },
      registerHoverProvider: () => ({ dispose() {} }),
      registerSignatureHelpProvider: () => ({ dispose() {} }),
    },
    editor: { getEditors: () => [editor] },
  };
  const registration = registerClangdProviders(monaco as never, {
    getWorkspaceRoot: () => "/proj",
    registerHover: false,
  });
  assert.ok(captured, "completion provider registered");
  return { provider: captured!, registration };
}

function installDeferredBridge(pending: Promise<FakeHit[]>): void {
  (globalThis as { window?: unknown }).window = {
    jellybot: {
      clangdStatus: async () => ({ ok: true }),
      clangdCompletion: async () => ({ ok: true, items: [] }),
      clangdIndexComplete: () => pending,
      completeCppSymbols: () => pending,
      clangdIncludeDirs: async () => ({ ok: true, dirs: [] }),
    },
  };
}

const LATE_HITS: FakeHit[] = [
  { name: "GetActorLocation", kind: "class", path: "/proj/A.h", line: 3 },
];

async function lateIndexRun(dismiss: boolean): Promise<string[]> {
  const text = "int32 X = GetA";
  const { model, position } = modelAt(text, text.length);
  const { editor, calls, state } = fakeSuggestEditor(model, position);
  const { provider, registration } = providersWithEditor(editor);
  let release!: (hits: FakeHit[]) => void;
  installDeferredBridge(new Promise<FakeHit[]>((resolve) => (release = resolve)));
  try {
    assert.equal(
      await provider.provideCompletionItems(model, position),
      null,
      "the index has not answered yet",
    );
    if (dismiss) {
      state.value = 2;
      assert.equal(registration.dismissSuggest(editor), true, "the list owns Escape");
      assert.deepEqual(calls, ["hideSuggestWidget"]);
      assert.equal(registration.dismissSuggest(editor), false, "idle editor keeps Escape for others");
      calls.length = 0;
    }
    release(LATE_HITS);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return calls;
  } finally {
    clearBridge();
  }
}

test("a late index answer reopens the list when the user did not dismiss it", async () => {
  const calls = await lateIndexRun(false);
  assert.ok(calls.length > 0, "the pending answer pops the list open");
  assert.ok(calls.every((call) => call === "retrigger:true"), calls.join(","));
});

test("Escape cancels the completion and keeps the late index answer from reopening it", async () => {
  assert.deepEqual(await lateIndexRun(true), []);
});
