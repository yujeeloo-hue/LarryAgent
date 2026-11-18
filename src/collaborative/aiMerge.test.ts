import assert from "node:assert/strict";
import test from "node:test";
import { requestSemanticMerge } from "./aiMerge.js";

const client = { baseUrl: "https://tokenlink.example.test/v1", apiKey: "test", model: "hy4-flash" };
const input = { path: "Character.cpp", instructions: "Bring in the source change and preserve target behavior." };

function reply(...chunks: string[]): Response {
  const body = chunks.map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join("");
  return new Response(body + 'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n', {
    headers: { "content-type": "text/event-stream" },
  });
}

test("large SVN files send changed context and apply only the returned edits to the target", async t => {
  const shared = Array.from({ length: 1_000 }, (_, i) => `void Shared${i}() {}`).join("\r\n");
  const target = `${shared}\r\nint Rate = 10;\r\nint TargetOnly = 1;\r\n`;
  const base = `${shared}\r\nint Rate = 10;\r\n`;
  const source = `${shared}\r\nint Rate = 12;\r\n`;
  const fetch = t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const payload = JSON.parse(body.messages[1].content);
    assert.equal(body.stream, true);
    assert.equal(body.reasoning_effort, "no_think");
    assert.match(payload.targetToSourceDiff, /-int TargetOnly = 1;/);
    assert.match(payload.baseToSourceDiff, /\+int Rate = 12;/);
    assert(!body.messages[1].content.includes("void Shared100()"));
    return reply('{"edits":[{"oldText":"int Rate = 10;\\n",', '"newText":"int Rate = 12;\\n"}]}');
  });
  assert.equal(await requestSemanticMerge(client, { ...input, source, target, base }), target.replace("Rate = 10", "Rate = 12"));
  assert.equal(fetch.mock.callCount(), 1);
});

test("unchanged Git source skips the model and preserves independent target edits", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => reply('{"edits":[]}'));
  assert.equal(await requestSemanticMerge(client, { ...input, base: "base", source: "base", target: "target", commonBase: true }), "target");
  assert.equal(fetch.mock.callCount(), 0);
});

test("timeout after headers cancels the body and does not retry", async t => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 60_000);
    return deadline.signal;
  });
  let reading = false, cancelled = false;
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({
    pull() { reading = true; },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream" } }));
  const merge = requestSemanticMerge(client, { ...input, source: "new", target: "old" });
  const rejected = assert.rejects(merge, /model timed out during AI Merge/);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert(reading);
  deadline.abort();
  await rejected;
  assert(cancelled);
  assert.equal(fetch.mock.callCount(), 1);
});

test("a transient model error issues a single request", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("Unavailable", { status: 503 }));
  await assert.rejects(requestSemanticMerge(client, { ...input, source: "new", target: "old" }), /Unavailable/);
  assert.equal(fetch.mock.callCount(), 1);
});

test("ambiguous or overlapping edits fail without an applicable merge result", async t => {
  const invalid = [
    [{ oldText: "return 0;", newText: "return 1;" }],
    [{ oldText: "void first()", newText: "int first()" }, { oldText: "first() {", newText: "first(bool enabled) {" }],
  ];
  t.mock.method(globalThis, "fetch", async () => reply(JSON.stringify({ edits: invalid.shift() })));
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(requestSemanticMerge(client, {
      ...input, source: "new", target: "void first() { return 0; }\nvoid second() { return 0; }",
    }), /invalid or ambiguous edits/);
  }
});
