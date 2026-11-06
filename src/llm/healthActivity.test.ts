import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fnv1aHex,
  isLlmEndpointRecentlyActive,
  llmActivityKey,
  msSinceLlmEndpointActivity,
  recordLlmEndpointActivity,
  resetLlmHealthActivityForTests,
} from "./healthActivity.js";

describe("llm health activity", () => {
  it("fnv1aHex is deterministic and differentiates inputs", () => {
    assert.equal(fnv1aHex("abc"), fnv1aHex("abc"));
    assert.notEqual(fnv1aHex("abc"), fnv1aHex("abd"));
    assert.match(fnv1aHex("x"), /^[0-9a-f]{8}$/);
  });

  it("unknown endpoint is never recently active", () => {
    resetLlmHealthActivityForTests();
    const key = llmActivityKey({
      endpointUrl: "https://gw.example.com/v2/chat/completions",
      apiKey: "k1",
    });
    assert.equal(msSinceLlmEndpointActivity(key, 1000), null);
    assert.equal(isLlmEndpointRecentlyActive(key, 60_000, 1000), false);
  });

  it("records activity and reports within/beyond the window", () => {
    resetLlmHealthActivityForTests();
    const key = llmActivityKey({ endpointUrl: "e", apiKey: "k" });
    recordLlmEndpointActivity(key, 10_000);
    // 59s later — inside the 60s window.
    assert.equal(msSinceLlmEndpointActivity(key, 69_000), 59_000);
    assert.equal(isLlmEndpointRecentlyActive(key, 60_000, 69_000), true);
    // Exactly at the window boundary counts as stale (interval fires).
    assert.equal(isLlmEndpointRecentlyActive(key, 60_000, 70_000), false);
    recordLlmEndpointActivity(key, 70_000);
    // Re-record resets the clock; 55s later still inside.
    assert.equal(isLlmEndpointRecentlyActive(key, 60_000, 125_000), true);
    // Exactly one full window later — stale again.
    assert.equal(isLlmEndpointRecentlyActive(key, 60_000, 130_000), false);
  });

  it("keys isolate endpoints and credentials", () => {
    resetLlmHealthActivityForTests();
    const a = llmActivityKey({ endpointUrl: "ep-a", apiKey: "k1" });
    const bSameUrlDiffKey = llmActivityKey({
      endpointUrl: "ep-a",
      apiKey: "k2",
    });
    const cDiffUrl = llmActivityKey({ endpointUrl: "ep-b", apiKey: "k1" });
    recordLlmEndpointActivity(a, 5_000);
    assert.equal(isLlmEndpointRecentlyActive(bSameUrlDiffKey, 60_000, 6_000), false);
    assert.equal(isLlmEndpointRecentlyActive(cDiffUrl, 60_000, 6_000), false);
    assert.equal(isLlmEndpointRecentlyActive(a, 60_000, 6_000), true);
  });

  it("reset clears all entries", () => {
    resetLlmHealthActivityForTests();
    const key = llmActivityKey({ endpointUrl: "e", apiKey: "k" });
    recordLlmEndpointActivity(key);
    resetLlmHealthActivityForTests();
    assert.equal(msSinceLlmEndpointActivity(key), null);
  });
});
