/**
 * Chat request timeout resolution: options.timeoutMs → config.requestTimeoutMs
 * → DEFAULT_LLM_REQUEST_TIMEOUT_MS. Uses a fetch stub that hangs until the
 * client's abort signal fires, mirroring real transport behavior.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  chatCompletionOnce,
  streamChatCompletion,
} from "./openaiCompatibleClient.js";
import type { OpenAiCompatibleClientConfig } from "./types.js";

const originalFetch = globalThis.fetch;

function installHangingFetch(): void {
  globalThis.fetch = (async (
    _input: unknown,
    init?: RequestInit,
  ): Promise<Response> => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("This operation was aborted", "AbortError")),
        { once: true },
      );
    });
  }) as typeof fetch;
}

function installInstantFetch(): void {
  globalThis.fetch = (async (): Promise<Response> => {
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

const BASE: OpenAiCompatibleClientConfig = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "k",
  model: "m",
};

describe("chat request timeout resolution", () => {
  it("applies config.requestTimeoutMs in chatCompletionOnce", async () => {
    installHangingFetch();
    await assert.rejects(
      chatCompletionOnce({ ...BASE, requestTimeoutMs: 20 }, {
        messages: [{ role: "user", content: "hi" }],
      }),
      /Request timed out after 20ms/,
    );
  });

  it("options.timeoutMs wins over config.requestTimeoutMs", async () => {
    installHangingFetch();
    await assert.rejects(
      chatCompletionOnce({ ...BASE, requestTimeoutMs: 60_000 }, {
        messages: [{ role: "user", content: "hi" }],
        timeoutMs: 20,
      }),
      /Request timed out after 20ms/,
    );
  });

  it("applies config.requestTimeoutMs in streamChatCompletion", async () => {
    installHangingFetch();
    const events: string[] = [];
    for await (const event of streamChatCompletion(
      { ...BASE, requestTimeoutMs: 20 },
      { messages: [{ role: "user", content: "hi" }] },
    )) {
      if (event.type === "error") events.push(event.message);
    }
    assert.ok(
      events.some((m) => /Request timed out after 20ms/.test(m)),
      `expected a timeout error event, got: ${JSON.stringify(events)}`,
    );
  });

  it("does not break requests that finish under the limit", async () => {
    installInstantFetch();
    const result = await chatCompletionOnce(
      { ...BASE, requestTimeoutMs: 30_000 },
      { messages: [{ role: "user", content: "hi" }] },
    );
    assert.deepEqual(result, { content: "ok" });
  });
});
