import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  chatCompletionOnce,
  streamChatCompletion,
} from "./openaiCompatibleClient.js";
import type { StreamEvent } from "./streamEvents.js";

const originalFetch = globalThis.fetch;
const BASE = { baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m" };
const MESSAGES = [{ role: "user" as const, content: "hi" }];

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function data(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return data({ choices: [{ delta, finish_reason: finishReason }] });
}

function installStream(body: string): void {
  globalThis.fetch = (async () => new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  })) as typeof fetch;
}

async function collect(signal?: AbortSignal): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of streamChatCompletion(BASE, {
    messages: MESSAGES,
    ...(signal ? { signal } : {}),
  })) events.push(event);
  return events;
}

const tool = {
  tool_calls: [{ index: 0, id: "call_1", function: { name: "write_file", arguments: '{"path":"x"}' } }],
};

describe("chat completion stream integrity", () => {
  it("rejects EOF without a completion marker and never executes pending tools", async () => {
    installStream(chunk(tool));
    const events = await collect();
    assert.equal(events.some((event) => event.type === "tool_call"), false);
    assert.ok(events.some((event) => event.type === "error" && /incomplete|ended|truncat/i.test(event.message)));
    assert.deepEqual(events.at(-1), { type: "done", reason: "error" });
  });

  it("does not execute pending tools after a provider error", async () => {
    installStream(chunk(tool) + data({ error: { message: "quota exceeded" } }) + "data: [DONE]\n\n");
    const events = await collect();
    assert.equal(events.some((event) => event.type === "tool_call"), false);
    assert.ok(events.some((event) => event.type === "error" && event.message === "quota exceeded"));
    assert.deepEqual(events.at(-1), { type: "done", reason: "error" });
  });

  for (const [label, error, message] of [
    ["code-only", { code: "server_error" }, "Model stream reported an error"],
    ["string", "upstream failure", "upstream failure"],
    ["empty object", {}, "Model stream reported an error"],
    ["false", false, "Model stream reported an error"],
    ["zero", 0, "Model stream reported an error"],
    ["empty string", "", "Model stream reported an error"],
    ["array", [], "Model stream reported an error"],
  ] as const) {
    it(`blocks pending tools after a ${label} error payload`, async () => {
      installStream(chunk(tool) + data({ error }) + "data: [DONE]\n\n");
      const events = await collect();
      assert.equal(events.some((event) => event.type === "tool_call"), false);
      assert.ok(events.some((event) => event.type === "error" && event.message === message));
      assert.deepEqual(events.at(-1), { type: "done", reason: "error" });
    });
  }

  it("accepts a null error field on a successful usage frame", async () => {
    installStream(chunk(tool, "tool_calls") + data({
      error: null, choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }) + "data: [DONE]\n\n");
    const events = await collect();
    assert.equal(events.some((event) => event.type === "error"), false);
    assert.equal(events.filter((event) => event.type === "tool_call").length, 1);
    assert.ok(events.some((event) => event.type === "usage" && event.totalTokens === 3));
    assert.deepEqual(events.at(-1), { type: "done", reason: "completed" });
  });

  it("keeps the last SSE frame when the body ends without a newline", async () => {
    installStream(chunk({ content: "hello" }) + `data: ${JSON.stringify({ choices: [{ delta: { content: " world" }, finish_reason: "stop" }] })}`);
    const events = await collect();
    assert.deepEqual(events.at(-1), { type: "done", reason: "completed" });
    assert.equal(events.filter((event) => event.type === "text_delta").map((event) => event.text).join(""), "hello world");
  });

  it("accepts a finish_reason followed by usage and EOF", async () => {
    installStream(chunk({ content: "hello" }, "stop") + data({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }));
    const events = await collect();
    assert.deepEqual(events.at(-1), { type: "done", reason: "completed" });
    assert.ok(events.some((event) => event.type === "usage" && event.totalTokens === 3));
  });

  for (const finishReason of ["length", "content_filter"]) {
    it(`does not execute tool calls cut short by ${finishReason}`, async () => {
      installStream(chunk(tool, finishReason) + "data: [DONE]\n\n");
      const events = await collect();
      assert.equal(events.some((event) => event.type === "tool_call"), false);
      assert.deepEqual(events.at(-1), { type: "done", reason: "error" });
    });
  }

  it("rejects malformed data without executing pending tools", async () => {
    installStream(chunk(tool) + 'data: {"choices":\n\n' + "data: [DONE]\n\n");
    const events = await collect();
    assert.equal(events.some((event) => event.type === "tool_call"), false);
    assert.deepEqual(events.at(-1), { type: "done", reason: "error" });
  });

  it("aggregates interleaved tool argument deltas independently", async () => {
    installStream(chunk({ tool_calls: [
      { index: 0, id: "call_1", function: { name: "first", arguments: '{"x":' } },
      { index: 1, id: "call_2", function: { name: "second", arguments: '{"y":' } },
    ] }) + chunk({ tool_calls: [
      { index: 1, function: { arguments: "2}" } },
      { index: 0, function: { arguments: "1}" } },
    ] }, "tool_calls") + "data: [DONE]\n\n");
    const events = await collect();
    assert.deepEqual(events.filter((event) => event.type === "tool_call").map((event) => ({ id: event.id, name: event.name, arguments: event.arguments })), [
      { id: "call_1", name: "first", arguments: { x: 1 } },
      { id: "call_2", name: "second", arguments: { y: 2 } },
    ]);
  });

  it("cancels a pending body read and never executes its pending tool", { timeout: 2_000 }, async () => {
    const controller = new AbortController();
    let cancelled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode(chunk(tool))); },
      cancel() { cancelled = true; },
    }), { headers: { "Content-Type": "text/event-stream" } })) as typeof fetch;
    const events: StreamEvent[] = [];
    for await (const event of streamChatCompletion(BASE, { messages: MESSAGES, signal: controller.signal })) {
      events.push(event);
      if (event.type === "tool_call_delta") controller.abort();
    }
    assert.equal(cancelled, true);
    assert.equal(events.some((event) => event.type === "tool_call"), false);
    assert.deepEqual(events.at(-1), { type: "done", reason: "cancelled" });
  });
});

describe("single completion streaming fallback format", () => {
  for (const finishReason of ["length", "content_filter"]) {
    it(`rejects a non-streaming ${finishReason} result even when its JSON is valid`, async () => {
      globalThis.fetch = (async () => new Response(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: finishReason }],
      }))) as typeof fetch;
      await assert.rejects(chatCompletionOnce(BASE, {
        messages: MESSAGES,
        responseFormat: { type: "json_object" },
      }), /length|content_filter/);
    });
  }

  it("rejects a streaming fallback that ends before completion", async () => {
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { stream: boolean };
      return body.stream
        ? new Response(chunk({ content: '{"ok":true}' }))
        : new Response(JSON.stringify({ error: { message: "Non-stream chat request is currently not supported" } }), { status: 400 });
    }) as typeof fetch;
    await assert.rejects(chatCompletionOnce(BASE, { messages: MESSAGES }), /ended before completion/);
  });

  it("negotiates JSON mode when the streaming-only gateway rejects json_schema", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const format = body.response_format as { type: string } | undefined;
      if (body.stream !== true) return new Response(JSON.stringify({ error: { message: "Non-stream chat request is currently not supported" } }), { status: 400 });
      if (format?.type === "json_schema") return new Response(JSON.stringify({ error: { message: "response_format json_schema is not supported" } }), { status: 400 });
      return new Response(chunk({ content: '{"ok":true}' }) + "data: [DONE]\n\n");
    }) as typeof fetch;
    const format = { type: "json_schema" as const, json_schema: { name: "test", strict: false, schema: { type: "object" } } };
    const result = await chatCompletionOnce(BASE, { messages: MESSAGES, responseFormat: format });
    assert.equal(result.content, '{"ok":true}');
    assert.deepEqual(bodies.map((body) => body.response_format), [format, format, { type: "json_object" }]);
  });

  it("preserves the negotiated JSON format when falling back to streaming", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.stream === true) return new Response(chunk({ content: '{"ok":true}' }) + "data: [DONE]\n\n");
      const format = body.response_format as { type: string } | undefined;
      return new Response(JSON.stringify({ error: { message: format?.type === "json_schema"
        ? "response_format json_schema is not supported"
        : "Non-stream chat request is currently not supported" } }), { status: 400 });
    }) as typeof fetch;
    const result = await chatCompletionOnce(BASE, {
      messages: MESSAGES,
      responseFormat: { type: "json_schema", json_schema: { name: "test", strict: false, schema: { type: "object" } } },
    });
    assert.equal(result.content, '{"ok":true}');
    assert.deepEqual(bodies.map((body) => body.response_format), [
      { type: "json_schema", json_schema: { name: "test", strict: false, schema: { type: "object" } } },
      { type: "json_object" },
      { type: "json_object" },
    ]);
  });
});
