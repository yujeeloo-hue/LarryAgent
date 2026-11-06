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
  clangdInsertFor,
  mergeIndexHits,
  signatureParameterRanges,
} from "./clangdFeatures.js";

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

test("LSP completion kinds map onto monaco's enum", () => {
  assert.equal(COMPLETION_KIND_MAP[2], 0); // Method
  assert.equal(COMPLETION_KIND_MAP[3], 1); // Function
  assert.equal(COMPLETION_KIND_MAP[6], 4); // Variable
  assert.equal(COMPLETION_KIND_MAP[7], 5); // Class
  assert.equal(COMPLETION_KIND_MAP[22], 6); // Struct
});
