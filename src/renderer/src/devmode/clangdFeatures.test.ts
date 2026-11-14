/**
 * clangdFeatures pure helpers — Rider-style insert text for clangd
 * completions (argument placeholders collapse to `Foo(|)`) and signature
 * parameter ranges. The monaco provider itself is covered by manual NF
 * verification; these tests pin the text transforms.
 */

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

test("bare words re-query once they reach the globals length; members do not", () => {
  const bare = { key: "k", queryPrefix: "GetA", truncated: false, bare: true };
  assert.equal(canReuseIndexSlot(bare, "k", "GetAc"), false);
  assert.equal(canReuseIndexSlot({ ...bare, queryPrefix: "GetAc" }, "k", "GetAct"), true);
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
  assert.equal(COMPLETION_KIND_MAP[2], 0); // Method
  assert.equal(COMPLETION_KIND_MAP[3], 1); // Function
  assert.equal(COMPLETION_KIND_MAP[6], 4); // Variable
  assert.equal(COMPLETION_KIND_MAP[7], 5); // Class
  assert.equal(COMPLETION_KIND_MAP[22], 6); // Struct
});
