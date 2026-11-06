import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveDecisionTokens } from "./estimateTokens.js";

describe("resolveDecisionTokens", () => {
  it("prefers provider usedTokens when source is provider", () => {
    const result = resolveDecisionTokens(
      { usedTokens: 50_000, source: "provider" },
      80_000,
    );
    assert.deepEqual(result, {
      decisionTokens: 50_000,
      source: "provider",
    });
  });

  it("falls back to estimate when source is estimate", () => {
    const result = resolveDecisionTokens(
      { usedTokens: 12_000, source: "estimate" },
      15_000,
    );
    assert.deepEqual(result, {
      decisionTokens: 15_000,
      source: "estimate",
    });
  });

  it("falls back to estimate when provider usedTokens is 0", () => {
    const result = resolveDecisionTokens(
      { usedTokens: 0, source: "provider" },
      9_000,
    );
    assert.deepEqual(result, {
      decisionTokens: 9_000,
      source: "estimate",
    });
  });

  it("falls back to estimate when source is missing", () => {
    const result = resolveDecisionTokens({ usedTokens: 1_000 }, 2_000);
    assert.deepEqual(result, {
      decisionTokens: 2_000,
      source: "estimate",
    });
  });

  it("adds window growth since the measured request on top of the provider reading", () => {
    // Previous request was hard-truncated to ~30k (estimate); the full window is ~1.35M.
    const result = resolveDecisionTokens(
      { usedTokens: 24_474, source: "provider", requestEstimateTokens: 29_478 },
      1_353_733,
    );
    assert.deepEqual(result, {
      decisionTokens: 24_474 + (1_353_733 - 29_478),
      source: "provider",
    });
  });

  it("keeps the provider reading when the window has not grown", () => {
    const result = resolveDecisionTokens(
      { usedTokens: 50_000, source: "provider", requestEstimateTokens: 70_000 },
      68_000,
    );
    assert.deepEqual(result, { decisionTokens: 50_000, source: "provider" });
  });

  it("uses the estimate for a legacy provider reading far below the window", () => {
    const result = resolveDecisionTokens(
      { usedTokens: 24_474, source: "provider" },
      1_353_733,
    );
    assert.deepEqual(result, { decisionTokens: 1_353_733, source: "estimate" });
  });
});
