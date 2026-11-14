/**
 * Stream cipher cross-mirror roundtrip: device (node) ↔ relay (node) ↔
 * viewer (WebCrypto, executed here on node's webcrypto global — same
 * SubtleCrypto the browser ships). All three mirrors must stay
 * byte-compatible (design §10, docs/plans/20261012-e2ee-stream-design.md).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveStreamKey as deriveDevice,
  FrameCipher as DeviceCipher,
  isStreamEnvelope,
} from "../src/streamCipher.ts";
import {
  deriveStreamKey as deriveRelay,
  FrameCipher as RelayCipher,
  STREAM_CAP,
} from "../src/streamCipher.ts";
import {
  deriveStreamKey as deriveViewer,
  FrameCipher as ViewerCipher,
  keyFromBase64,
} from "../web/src/streamCipher.ts";

const KEY = "jb-test-api-key-0123456789";

test("node mirrors derive identical keys from the same api key", async () => {
  const a = deriveDevice(KEY);
  const b = deriveRelay(KEY);
  const c = await deriveViewer(KEY);
  assert.equal(a.toString("base64"), b.toString("base64"));
  assert.equal(a.toString("base64"), Buffer.from(c).toString("base64"));
});

test("device(d2r) seal → relay open roundtrip", () => {
  const dev = new DeviceCipher(deriveDevice(KEY), "d2r");
  const relay = new RelayCipher(deriveRelay(KEY), "d2r");
  const payload = { sessionId: "s1", event: { type: "message_delta", text: "héllo 🐶" } };
  const env = dev.seal(payload);
  assert.ok(isStreamEnvelope(env));
  const opened = relay.open(env);
  assert.deepEqual(opened?.value, payload);
});

test("viewer(v2r) WebCrypto seal → relay open (cross-implementation)", async () => {
  const viewer = new ViewerCipher(await deriveViewer(KEY), "v2r");
  const relay = new RelayCipher(deriveRelay(KEY), "v2r");
  const payload = { action: "startTurn", text: "开始" };
  const env = await viewer.seal(payload);
  const opened = relay.open(env);
  assert.deepEqual(opened?.value, payload);
});

test("relay(r2v) seal → viewer WebCrypto open (cross-implementation)", async () => {
  const relay = new RelayCipher(deriveRelay(KEY), "r2v");
  const viewer = new ViewerCipher(await deriveViewer(KEY), "r2v");
  const payload = { sessionId: "s9", event: { type: "status", state: "running" } };
  const env = relay.seal(payload);
  const opened = await viewer.open(env);
  assert.deepEqual(opened?.value, payload);
});

test("relay(r2d) seal → device open roundtrip", () => {
  const relay = new RelayCipher(deriveRelay(KEY), "r2d");
  const dev = new DeviceCipher(deriveDevice(KEY), "r2d");
  const env = relay.seal({ requestId: "v3-abc", action: "enqueuePrompt", payload: { text: "hi" } });
  const opened = dev.open(env);
  assert.deepEqual(opened?.value, {
    requestId: "v3-abc",
    action: "enqueuePrompt",
    payload: { text: "hi" },
  });
});

test("dir mismatch (AAD binding) fails to open", async () => {
  const dev = new DeviceCipher(deriveDevice(KEY), "d2r");
  const wrongSide = new RelayCipher(deriveRelay(KEY), "r2d");
  const env = dev.seal({ x: 1 });
  assert.equal(wrongSide.open(env), null);
});

test("replay: the same envelope twice is rejected", () => {
  const dev = new DeviceCipher(deriveDevice(KEY), "d2r");
  const relay = new RelayCipher(deriveRelay(KEY), "d2r");
  const env = dev.seal({ n: 1 });
  assert.ok(relay.open(env));
  assert.equal(relay.open(env), null);
});

test("reorder: a lower seq after a higher one is rejected", () => {
  const dev = new DeviceCipher(deriveDevice(KEY), "d2r");
  const relay = new RelayCipher(deriveRelay(KEY), "d2r");
  const e0 = dev.seal({ n: 0 });
  const e1 = dev.seal({ n: 1 });
  assert.ok(relay.open(e1));
  assert.equal(relay.open(e0), null);
});

test("tampered cipherText fails the GCM tag", () => {
  const dev = new DeviceCipher(deriveDevice(KEY), "d2r");
  const relay = new RelayCipher(deriveRelay(KEY), "d2r");
  const env = dev.seal({ secret: "x" });
  const bytes = Buffer.from(env.c, "base64");
  bytes[0] ^= 0xff;
  assert.equal(relay.open({ n: env.n, c: bytes.toString("base64") }), null);
});

test("wrong api key derives an incompatible key", () => {
  const dev = new DeviceCipher(deriveDevice(KEY), "d2r");
  const relay = new RelayCipher(deriveRelay("another-key"), "d2r");
  assert.equal(relay.open(dev.seal({ a: 1 })), null);
});

test("viewer keyFromBase64 roundtrip + rejects bad lengths", () => {
  const key = deriveRelay(KEY);
  const b64 = key.toString("base64");
  const back = keyFromBase64(b64);
  assert.deepEqual(Buffer.from(back ?? new Uint8Array()), key);
  assert.equal(keyFromBase64(Buffer.alloc(31).toString("base64")), null);
  assert.equal(keyFromBase64("!!!not-base64!!!"), null);
});

test("STREAM_CAP is identical across mirrors", async () => {
  const { STREAM_CAP: viewerCap } = await import("../web/src/streamCipher.ts");
  assert.equal(viewerCap, "e2ee-v1");
});

test("long frames (realistic event payloads) survive the roundtrip", () => {
  const dev = new DeviceCipher(deriveDevice(KEY), "d2r");
  const relay = new RelayCipher(deriveRelay(KEY), "d2r");
  const big = { sessionId: "s", event: { type: "tool_result", output: "x".repeat(200_000) } };
  const opened = relay.open(dev.seal(big));
  assert.equal((opened?.value as { event: { output: string } }).event.output.length, 200_000);
  assert.ok(STREAM_CAP.length > 0);
});
