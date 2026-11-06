import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../../../../session/types.js";
import { splitGlobalProtectIterations, walkProtectBoundary } from "./splitIterations.js";

const SCOPE = "scope-a";

function nativeTurn(i: number): Message[] {
  return [
    { id: `u${i}`, role: "user", createdAt: i, parts: [{ type: "text", text: `question ${i}` }] },
    { id: `a${i}`, role: "assistant", createdAt: i, parts: [
      { type: "text", text: `answer ${i}` },
      { type: "model_response", providerScope: SCOPE, responseId: `r${i}`, status: "completed", stored: true, output: [
        { type: "reasoning", encrypted_content: "x".repeat(40_000) },
      ] },
    ] },
  ];
}

test("protect estimate counts replayed native model_response when the wire scope is supplied", () => {
  const messages = [1, 2, 3].flatMap(nativeTurn);
  const without = splitGlobalProtectIterations(messages)[0]!.tokens;
  const withScope = splitGlobalProtectIterations(messages, { reasoningScope: SCOPE })[0]!.tokens;
  assert.ok(withScope > without + 9_000, `expected native replay in estimate (${without} → ${withScope})`);
});

test("protect walk with wire scope stops at the real budget instead of protecting everything", () => {
  const messages = [1, 2, 3].flatMap(nativeTurn);
  const options = { contextLimitTokens: 50_000, rawIterationCount: 10, tokenRatio: 0.35 };
  assert.equal(walkProtectBoundary(messages, options).boundary, undefined);
  const scoped = walkProtectBoundary(messages, { ...options, reasoningScope: SCOPE });
  assert.ok(scoped.boundary, "native-heavy iterations must exceed the protect budget");
  assert.ok(scoped.protectedTokens < scoped.protectBudget);
});
