import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  downloadResponseFile, RESPONSE_FILE_MAX_BYTES,
  RESPONSE_FILE_HEADERS_TIMEOUT_MS, RESPONSE_FILE_DOWNLOAD_TIMEOUT_MS,
} from "./files.js";
import type { OpenAiCompatibleClientConfig } from "../../types.js";

const originalFetch = globalThis.fetch;
const config: OpenAiCompatibleClientConfig = {
  baseUrl: "https://provider.test/v1/responses?api-version=2026-01", apiKey: "private-key", model: "m", apiProtocol: "responses",
};
afterEach(() => { globalThis.fetch = originalFetch; });

test("downloads provider file bytes with auth, preserves query and parses safe UTF-8 filename", async () => {
  let called = "";
  globalThis.fetch = async (url, init) => {
    called = String(url);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer private-key");
    assert.equal(init?.redirect, "error");
    return new Response(new Uint8Array([0, 1, 255]), { headers: {
      "content-type": "Image/PNG; charset=binary",
      "content-disposition": "attachment; filename=backup.png; filename*=UTF-8''%E6%8A%A5%E5%91%8A.png",
    } });
  };
  const result = await downloadResponseFile(config, { fileId: "file-123" });
  assert.equal(called, "https://provider.test/v1/files/file-123/content?api-version=2026-01");
  assert.deepEqual(result, { bytes: new Uint8Array([0, 1, 255]), mimeType: "image/png", filename: "报告.png" });
});

test("container downloads use container file content endpoint and sanitize filename paths", async () => {
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://provider.test/v1/containers/cntr_123/files/cfile_456/content?api-version=2026-01");
    return new Response("report", { headers: { "content-disposition": 'attachment; filename="../../report.csv"' } });
  };
  const result = await downloadResponseFile(config, { containerId: "cntr_123", fileId: "cfile_456" });
  assert.equal(result.filename, "report.csv");
  assert.equal(new TextDecoder().decode(result.bytes), "report");
});

test("rejects invalid IDs and non-HTTP provider URLs before sending credentials", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response(); };
  for (const fileId of ["", "..", "file/other", "file?override=1", "file#other", "x".repeat(257)]) {
    await assert.rejects(downloadResponseFile(config, { fileId }), /Invalid response file id/);
  }
  await assert.rejects(downloadResponseFile(config, { fileId: "file-1", containerId: "../other" }), /Invalid response container id/);
  for (const baseUrl of ["file:///tmp", "data:text/plain,", "https://name:secret@provider.test/v1"]) {
    await assert.rejects(downloadResponseFile({ ...config, baseUrl }, { fileId: "file-1" }), /HTTP or HTTPS|Invalid response file provider/);
  }
  assert.equal(calls, 0);
});

test("HTTP errors are bounded and redact credentials, without retrying", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({ error: { message: "Denied private-key" } }, { status: 403 }); };
  await assert.rejects(downloadResponseFile(config, { fileId: "file-1" }), (error: Error) => {
    assert.match(error.message, /HTTP 403.*Denied \[redacted\]/);
    assert.doesNotMatch(error.message, /private-key/);
    return true;
  });
  assert.equal(calls, 1);
  globalThis.fetch = async () => new Response("x".repeat(20_000), { status: 502 });
  await assert.rejects(downloadResponseFile(config, { fileId: "file-1" }), /HTTP 502/);
  globalThis.fetch = async () => Response.json({ error: { message: `${"x".repeat(298)}private-key` } }, { status: 403 });
  await assert.rejects(downloadResponseFile(config, { fileId: "file-1" }), (error: Error) => {
    assert.doesNotMatch(error.message, /private|key/);
    return true;
  });
});

test("network and broken body errors fail without exposing provider credentials", async () => {
  globalThis.fetch = async () => { throw new Error("transport private-key"); };
  await assert.rejects(downloadResponseFile(config, { fileId: "file-1" }), /^Error: Response file request failed$/);
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("body private-key")); } }));
  await assert.rejects(downloadResponseFile(config, { fileId: "file-1" }), /^Error: Response file content could not be read$/);
});

test("size cap rejects both declared and streamed oversized data and cancels readers", async () => {
  let cancelled = 0;
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel: () => { cancelled += 1; } }), {
    headers: { "content-length": String(RESPONSE_FILE_MAX_BYTES + 1) },
  });
  await assert.rejects(downloadResponseFile(config, { fileId: "file-1" }), /size limit/);
  assert.equal(cancelled, 1);
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(RESPONSE_FILE_MAX_BYTES)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled += 1; },
  }));
  await assert.rejects(downloadResponseFile(config, { fileId: "file-1" }), /size limit/);
  assert.equal(cancelled, 2);
});

test("pre-abort and abort while reading stop downloads without returning partial bytes", async () => {
  const pre = new AbortController(); pre.abort();
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response(); };
  await assert.rejects(downloadResponseFile(config, { fileId: "file-1" }, pre.signal), /cancelled/);
  assert.equal(calls, 0);
  const active = new AbortController();
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } }));
  const task = downloadResponseFile(config, { fileId: "file-1" }, active.signal);
  await Promise.resolve(); await Promise.resolve();
  active.abort();
  await assert.rejects(task, /cancelled/);
});

test("response header timeout stops even a transport that ignores AbortSignal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.fetch = () => new Promise<Response>(() => {});
  const task = downloadResponseFile(config, { fileId: "file-1" });
  const rejection = assert.rejects(task, /timed out waiting for response headers/);
  t.mock.timers.tick(RESPONSE_FILE_HEADERS_TIMEOUT_MS);
  await rejection;
});

test("overall timeout remains active while a response body stalls", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reading!: () => void;
  const readStarted = new Promise<void>((resolve) => { reading = resolve; });
  globalThis.fetch = async () => new Response(new ReadableStream({ pull() { reading(); } }));
  const task = downloadResponseFile(config, { fileId: "file-1" });
  const rejection = assert.rejects(task, /download timed out/);
  await readStarted;
  // A stream may pre-pull before fetch resolves; let the helper receive headers.
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(RESPONSE_FILE_DOWNLOAD_TIMEOUT_MS);
  await rejection;
});
