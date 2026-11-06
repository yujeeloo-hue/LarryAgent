import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { chatCompletionOnce, llmEndpointKey } from "./openaiCompatibleClient.js";
import {
  isLlmEndpointRecentlyActive,
  msSinceLlmEndpointActivity,
  resetLlmHealthActivityForTests,
} from "./healthActivity.js";
import type { OpenAiCompatibleClientConfig } from "./types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetLlmHealthActivityForTests();
});

const CONFIG: OpenAiCompatibleClientConfig = {
  baseUrl: "https://copilot.example.com/v2",
  apiKey: "secret-key-1",
  model: "some-model",
};

describe("llm client → health activity wiring", () => {
  it("chatCompletionOnce OK response records endpoint activity", async () => {
    resetLlmHealthActivityForTests();
    let requestedUrl = "";
    globalThis.fetch = (async (input: unknown): Promise<Response> => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    await chatCompletionOnce(CONFIG, {
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 1_000,
    });

    const key = llmEndpointKey(CONFIG);
    // Key endpoint must match the URL that was actually requested.
    assert.ok(key.startsWith(`${requestedUrl}|`), key);
    assert.equal(msSinceLlmEndpointActivity(key) !== null, true);
    assert.equal(isLlmEndpointRecentlyActive(key, 60_000), true);
  });

  it("transport failure records no activity", async () => {
    resetLlmHealthActivityForTests();
    globalThis.fetch = (async (): Promise<Response> => {
      throw new Error("boom");
    }) as typeof fetch;
    await assert.rejects(
      () =>
        chatCompletionOnce(CONFIG, {
          messages: [{ role: "user", content: "hi" }],
          timeoutMs: 1_000,
        }),
    );
    const key = llmEndpointKey(CONFIG);
    assert.equal(isLlmEndpointRecentlyActive(key, 60_000), false);
  });

  it("HTTP error status records no activity", async () => {
    resetLlmHealthActivityForTests();
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(JSON.stringify({ error: { message: "bad key" } }), {
        status: 401,
      })) as typeof fetch;
    await assert.rejects(
      () =>
        chatCompletionOnce(CONFIG, {
          messages: [{ role: "user", content: "hi" }],
          timeoutMs: 1_000,
        }),
    );
    const key = llmEndpointKey(CONFIG);
    assert.equal(isLlmEndpointRecentlyActive(key, 60_000), false);
  });

  it("rawEndpoint keys use the baseUrl verbatim", () => {
    const raw = llmEndpointKey({ ...CONFIG, rawEndpoint: true });
    const joined = llmEndpointKey(CONFIG);
    assert.ok(raw.startsWith("https://copilot.example.com/v2|"));
    assert.ok(joined.startsWith("https://copilot.example.com/v2/chat/completions|"));
    assert.notEqual(raw, joined);
  });
});
