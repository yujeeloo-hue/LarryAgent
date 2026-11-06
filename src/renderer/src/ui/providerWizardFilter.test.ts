import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { modelMatchesQuery } from "./providerWizardFilter.js";

describe("modelMatchesQuery", () => {
  it("matches when every word appears in the id", () => {
    assert.equal(
      modelMatchesQuery("anthropic/claude-sonnet-4.5", "claude sonnet"),
      true,
    );
    assert.equal(modelMatchesQuery("openai/gpt-4o", "gpt"), true);
    assert.equal(modelMatchesQuery("qwen/qwen3-coder", "QWEN coder"), true);
  });

  it("rejects a catalogue entry that misses a word", () => {
    assert.equal(modelMatchesQuery("openai/gpt-4o", "claude"), false);
    assert.equal(modelMatchesQuery("anthropic/claude-sonnet-4.5", "claude haiku"), false);
  });

  it("treats a blank query as no filter", () => {
    assert.equal(modelMatchesQuery("openai/text-embedding-3-small", "   "), true);
  });
});
