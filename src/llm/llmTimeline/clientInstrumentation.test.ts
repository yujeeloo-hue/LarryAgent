/**
 * End-to-end instrumentation check: the public streamChatCompletion /
 * chatCompletionOnce wrappers feed the in-memory LLM timeline recorder
 * (Dev Panel → Timeline) when meta.sessionId is present.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  chatCompletionOnce,
  streamChatCompletion,
} from "../openaiCompatibleClient.js";
import type { OpenAiCompatibleClientConfig } from "../types.js";
import { clearLlmTimeline, listLlmTimeline } from "./recorder.js";

const originalFetch = globalThis.fetch;
const SESSION = "session-client-timeline";

const BASE: OpenAiCompatibleClientConfig = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "k",
  model: "deepseek-v4-pro",
};

function sseFetch(lines: string[]): void {
  globalThis.fetch = (async (): Promise<Response> => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${line}\n`));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearLlmTimeline();
});

describe("llm timeline client instrumentation", () => {
  it("records a streaming chat round-trip with stats", async () => {
    sseFetch([
      `data: ${JSON.stringify({
        choices: [{ delta: { reasoning_content: "think" } }],
      })}`,
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "hello world" } }],
      })}`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  function: { name: "read_file", arguments: "{}" },
                },
              ],
            },
          },
        ],
      })}`,
      `data: ${JSON.stringify({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 40,
          total_tokens: 140,
          prompt_tokens_details: { cached_tokens: 60 },
        },
      })}`,
      "data: [DONE]",
    ]);

    const seen: string[] = [];
    for await (const event of streamChatCompletion(BASE, {
      messages: [{ role: "user", content: "hi" }],
      meta: { sessionId: SESSION, purpose: "chat", iteration: 3 },
    })) {
      seen.push(event.type);
    }

    assert.ok(seen.includes("done"), `expected a done event: ${seen}`);
    const snapshot = listLlmTimeline(SESSION);
    assert.equal(snapshot.records.length, 1);
    const record = snapshot.records[0];
    assert.ok(record);
    if (record.kind !== "llm") throw new Error("expected an llm record");
    assert.equal(record.stream, true);
    assert.equal(record.purpose, "chat");
    assert.equal(record.iteration, 3);
    assert.equal(record.model, "deepseek-v4-pro");
    assert.equal(record.attempts, 1);
    assert.equal(record.httpStatus, 200);
    assert.equal(record.textChars, 11);
    assert.equal(record.reasoningChars, 5);
    assert.equal(record.toolCallCount, 1);
    assert.deepEqual(record.toolNames, ["read_file"]);
    assert.equal(record.promptTokens, 100);
    assert.equal(record.completionTokens, 40);
    assert.equal(record.totalTokens, 140);
    assert.equal(record.cachedTokens, 60);
    assert.equal(record.doneReason, "completed");
    assert.equal(record.error, undefined);
    assert.notEqual(record.endedAt, null);
    assert.ok((record.durationMs ?? 0) >= 0);
  });

  it("records a non-streaming round-trip from the response JSON", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "summary text" } }],
          usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await chatCompletionOnce(BASE, {
      messages: [{ role: "user", content: "summarize" }],
      meta: { sessionId: SESSION, purpose: "compact" },
    });
    assert.equal(result.content, "summary text");

    const snapshot = listLlmTimeline(SESSION);
    assert.equal(snapshot.records.length, 1);
    const record = snapshot.records[0];
    assert.ok(record);
    if (record.kind !== "llm") throw new Error("expected an llm record");
    assert.equal(record.stream, false);
    assert.equal(record.purpose, "compact");
    assert.equal(record.doneReason, "completed");
    assert.equal(record.textChars, "summary text".length);
    assert.equal(record.httpStatus, 200);
    assert.equal(record.promptTokens, 9);
    assert.equal(record.totalTokens, 11);
    assert.notEqual(record.endedAt, null);
  });

  it("records an errored round-trip with the error message", async () => {
    sseFetch([
      `data: ${JSON.stringify({ error: { message: "boom" } })}`,
      "data: [DONE]",
    ]);

    const seen: string[] = [];
    for await (const event of streamChatCompletion(BASE, {
      messages: [{ role: "user", content: "hi" }],
      meta: { sessionId: SESSION },
    })) {
      seen.push(event.type);
    }
    assert.ok(seen.includes("error"));

    const snapshot = listLlmTimeline(SESSION);
    const record = snapshot.records[0];
    assert.ok(record);
    if (record.kind !== "llm") throw new Error("expected an llm record");
    assert.equal(record.doneReason, "error");
    assert.equal(record.error, "boom");
    assert.notEqual(record.endedAt, null);
  });

  it("skips recording when meta.sessionId is absent", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await chatCompletionOnce(BASE, {
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(listLlmTimeline(SESSION).records.length, 0);
  });
});
