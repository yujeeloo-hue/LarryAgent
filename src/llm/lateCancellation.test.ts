import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { chatCompletionOnce, streamChatCompletion } from "./openaiCompatibleClient.js";
import type { StreamEvent } from "./streamEvents.js";

const originalFetch = globalThis.fetch;
const CONFIG = { baseUrl: "https://late-response.invalid/v1", apiKey: "mock", model: "mock" };
const messages = [{ role: "user" as const, content: "hi" }];
const result = { choices: [{ message: { content: "too late" }, finish_reason: "stop" }] };
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => { globalThis.fetch = originalFetch; });

function withJsonReader(response: Response, read: () => Promise<unknown>): Response {
  Object.defineProperty(response, "json", { value: read });
  return response;
}

function lateResponse(onCancel: () => void): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({ choices: [{ delta: {
          tool_calls: [{ index: 0, id: "late-call", function: { name: "write_file", arguments: '{}' } }],
        }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      ));
    },
    cancel() { onCancel(); },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

async function collect(options: { signal?: AbortSignal; timeoutMs?: number }): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of streamChatCompletion(CONFIG, { messages, ...options })) events.push(event);
  return events;
}

describe("late completion cancellation", () => {
  it("discards and closes streaming headers that arrive after the attempt timed out", async () => {
    let calls = 0;
    let cancelledBodies = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      await pause(20); // Deliberately emulate a transport that ignores AbortSignal.
      return lateResponse(() => { cancelledBodies += 1; });
    }) as typeof fetch;
    const events = await collect({ timeoutMs: 5 });
    assert.equal(calls, 3);
    assert.equal(cancelledBodies, 3);
    assert.equal(events.some((event) => event.type === "tool_call" || event.type === "tool_call_delta"), false);
    assert.ok(events.some((event) => event.type === "error" && /timed out/.test(event.message)));
    assert.deepEqual(events.at(-1), { type: "done", reason: "error" });
  });

  it("discards streaming headers arriving after caller cancellation without retrying", async () => {
    const controller = new AbortController();
    let calls = 0;
    let cancelledBodies = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      controller.abort();
      return lateResponse(() => { cancelledBodies += 1; });
    }) as typeof fetch;
    const events = await collect({ signal: controller.signal });
    assert.equal(calls, 1);
    assert.equal(cancelledBodies, 1);
    assert.equal(events.some((event) => event.type === "tool_call"), false);
    assert.deepEqual(events.at(-1), { type: "done", reason: "cancelled" });
  });

  it("discards and closes non-streaming headers arriving after caller cancellation", async () => {
    const controller = new AbortController();
    let calls = 0;
    let jsonReads = 0;
    let cancelledBodies = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      controller.abort();
      const response = lateResponse(() => { cancelledBodies += 1; });
      return withJsonReader(response, async () => { jsonReads += 1; return result; });
    }) as typeof fetch;
    await assert.rejects(chatCompletionOnce(CONFIG, { messages, signal: controller.signal }), /Request cancelled/);
    assert.equal(calls, 1);
    assert.equal(jsonReads, 0);
    assert.equal(cancelledBodies, 1);
  });

  it("discards non-streaming headers that arrive after the attempt timed out", async () => {
    let calls = 0;
    let jsonReads = 0;
    let cancelledBodies = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      await pause(20);
      const response = lateResponse(() => { cancelledBodies += 1; });
      return withJsonReader(response, async () => { jsonReads += 1; return result; });
    }) as typeof fetch;
    await assert.rejects(chatCompletionOnce(CONFIG, { messages, timeoutMs: 5 }), /timed out/);
    assert.equal(calls, 3);
    assert.equal(jsonReads, 0);
    assert.equal(cancelledBodies, 3);
  });

  it("rejects a JSON result delivered after caller cancellation without retrying", async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      const response = new Response("{}");
      return withJsonReader(response, async () => { controller.abort(); return result; });
    }) as typeof fetch;
    await assert.rejects(chatCompletionOnce(CONFIG, { messages, signal: controller.signal }), /Request cancelled/);
    assert.equal(calls, 1);
  });

  it("rejects a JSON result delivered after its attempt timed out", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      const response = new Response("{}");
      return withJsonReader(response, async () => { await pause(20); return result; });
    }) as typeof fetch;
    await assert.rejects(chatCompletionOnce(CONFIG, { messages, timeoutMs: 5 }), /timed out/);
    assert.equal(calls, 3);
  });

  it("lets caller cancellation win when a timed-out attempt resolves late", async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      await pause(20);
      controller.abort();
      const response = new Response("{}");
      return withJsonReader(response, async () => result);
    }) as typeof fetch;
    await assert.rejects(chatCompletionOnce(CONFIG, { messages, signal: controller.signal, timeoutMs: 5 }), /Request cancelled/);
    assert.equal(calls, 1);
  });
});
