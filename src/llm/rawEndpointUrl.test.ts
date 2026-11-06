import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { chatCompletionOnce } from "./openaiCompatibleClient.js";
import type { OpenAiCompatibleClientConfig } from "./types.js";

const originalFetch = globalThis.fetch;
const requestedUrls: string[] = [];

function installFetchStub(): void {
  requestedUrls.length = 0;
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    requestedUrls.push(String(input));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function requestUrlWith(
  config: OpenAiCompatibleClientConfig,
): Promise<string> {
  installFetchStub();
  await chatCompletionOnce(config, {
    messages: [{ role: "user", content: "hi" }],
    timeoutMs: 1_000,
  });
  assert.equal(requestedUrls.length, 1);
  return requestedUrls[0]!;
}

describe("chat endpoint URL building", () => {
  it("appends /chat/completions by default", async () => {
    const url = await requestUrlWith({
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "k",
      model: "deepseek-chat",
    });
    assert.equal(url, "https://api.deepseek.com/v1/chat/completions");
  });

  it("strips trailing slash before appending", async () => {
    const url = await requestUrlWith({
      baseUrl: "https://api.deepseek.com/v1/",
      apiKey: "k",
      model: "deepseek-chat",
    });
    assert.equal(url, "https://api.deepseek.com/v1/chat/completions");
  });

  it("rawEndpoint uses baseUrl exactly as-is", async () => {
    const url = await requestUrlWith({
      baseUrl: "https://gw.example.com/api/chat/completions",
      apiKey: "k",
      model: "some-model",
      rawEndpoint: true,
    });
    assert.equal(url, "https://gw.example.com/api/chat/completions");
  });
});
