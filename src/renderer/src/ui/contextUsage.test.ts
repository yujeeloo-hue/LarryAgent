import assert from "node:assert/strict";
import { it } from "node:test";
import { contextCacheHitRatio, contextUsageRows, mergeContextUsage, type ContextUsage } from "./contextUsage.js";

const measured: ContextUsage = {
  source: "provider",
  usedTokens: 1_001,
  limitTokens: 10_000,
  inputTokens: 1_001,
  cachedTokens: 500,
  breakdown: { conversation: 2, skillPrompts: 1, toolActivity: 5 },
};

it("orders the calibrated categories by size without adding tokens to the provider total", () => {
  const { occupied, estimated } = contextUsageRows(measured);
  assert.equal(estimated, true);
  assert.deepEqual(occupied, [
    { label: "Tool calls & results", tokens: 626 },
    { label: "Conversation", tokens: 250 },
    { label: "Skill prompts", tokens: 125 },
  ]);
  assert.equal(contextCacheHitRatio(measured), 500 / 1_001);
});

it("uses an aggregate when classification is unavailable and clears stale details on reset", () => {
  const fallback = mergeContextUsage(measured, { source: "provider", usedTokens: 1_440, inputTokens: null, cachedTokens: 500 });
  assert.deepEqual(contextUsageRows(fallback).occupied, [{ label: "Used", tokens: 1_440 }]);
  assert.equal(contextCacheHitRatio(fallback), undefined);
  const reset = mergeContextUsage(fallback, { source: "estimate", usedTokens: 0 });
  assert.deepEqual(contextUsageRows(reset).occupied, []);
  assert.equal(reset.breakdown, undefined);
  assert.equal(reset.cachedTokens, undefined);
});
