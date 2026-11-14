/**
 * Streaming fallback for gateways that reject non-streaming chat completions
 * (e.g. copilot.tencent.com → 400 {"code":11101,"msg":"Non-stream chat
 * request is currently not supported"}). `chatCompletionOnce` must retry once
 * with `stream: true` and aggregate the SSE text into the single-shot result.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { chatCompletionOnce } from "./openaiCompatibleClient.js";
import type { OpenAiCompatibleClientConfig } from "./types.js";

const originalFetch = globalThis.fetch;

function nonStreamRejectedResponse(): Response {
  return new Response(
    JSON.stringify({
      code: 11101,
      msg: "Non-stream chat request is currently not supported",
    }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}

function sseResponse(chunks: string[]): Response {
  const body = chunks
    .map(
      (text) =>
        `data: ${JSON.stringify({
          choices: [{ delta: { content: text } }],
        })}\n\n`,
    )
    .join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const BASE: OpenAiCompatibleClientConfig = {
  baseUrl: "https://copilot.tencent.com/v2",
  apiKey: "k",
  model: "m",
};

describe("chatCompletionOnce stream fallback", () => {
  it("falls back to streaming when non-stream is rejected", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (
      _input: unknown,
      init?: RequestInit,
    ): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.stream === false) {
        return nonStreamRejectedResponse();
      }
      return sseResponse(["Hello", ", ", "world!"]);
    }) as typeof fetch;

    const result = await chatCompletionOnce(BASE, {
      messages: [{ role: "user", content: "hi" }],
    });

    assert.deepEqual(result, { content: "Hello, world!" });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0]?.stream, false);
    assert.equal(bodies[1]?.stream, true);
  });

  it("propagates stream errors after fallback", async () => {
    globalThis.fetch = (async (
      _input: unknown,
      init?: RequestInit,
    ): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.stream === false) {
        return nonStreamRejectedResponse();
      }
      return new Response(
        `data: ${JSON.stringify({
          error: { message: "boom" },
        })}\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;

    await assert.rejects(
      chatCompletionOnce(BASE, {
        messages: [{ role: "user", content: "hi" }],
      }),
      /boom/,
    );
  });

  it("keeps reasoning text when content is empty", async () => {
    globalThis.fetch = (async (
      _input: unknown,
      init?: RequestInit,
    ): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.stream === false) {
        return nonStreamRejectedResponse();
      }
      return new Response(
        `data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: "chain of thought" } }],
        })}\n\n` +
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "" } }],
          })}\n\n` +
          "data: [DONE]\n\n",
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;

    const result = await chatCompletionOnce(BASE, {
      messages: [{ role: "user", content: "hi" }],
    });
    assert.deepEqual(result, { content: "chain of thought" });
  });

  it("does not fall back on unrelated 400 errors", async () => {
    let calls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "bad model" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await assert.rejects(
      chatCompletionOnce(BASE, {
        messages: [{ role: "user", content: "hi" }],
      }),
      /bad model/,
    );
    // 400 is not retryable — one non-streaming attempt, no stream fallback.
    assert.equal(calls, 1);
  });
});
