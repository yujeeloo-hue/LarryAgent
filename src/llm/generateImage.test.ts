import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  generateImage,
  imageExtensionForMime,
  saveGeneratedImage,
  sniffImageMime,
} from "./generateImage.js";
import type { OpenAiCompatibleClientConfig } from "./types.js";

/** 1x1 transparent PNG. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52,
]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString("base64");

const CLIENT: OpenAiCompatibleClientConfig = {
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "test-key",
  model: "cogview-4-250304",
};

const realFetch = globalThis.fetch;
const tmpDirs: string[] = [];

after(() => {
  globalThis.fetch = realFetch;
  for (const dir of tmpDirs) void rm(dir, { recursive: true, force: true });
});

function stubFetch(
  handler: (input: string | URL, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = ((input: string | URL, init?: RequestInit) =>
    handler(input, init)) as typeof fetch;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("generateImage", () => {
  it("decodes data[].b64_json and sends only whitelisted body fields", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    let capturedUrl = "";
    stubFetch(async (input, init) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ created: 1, data: [{ b64_json: PNG_B64 }] });
    });

    const result = await generateImage({
      client: CLIENT,
      prompt: "a tiny cat",
      size: "1024x1024",
    });

    assert.equal(capturedUrl, `${CLIENT.baseUrl}/images/generations`);
    assert.deepEqual(capturedBody, {
      model: CLIENT.model,
      prompt: "a tiny cat",
      size: "1024x1024",
    });
    assert.ok(!capturedBody || !("response_format" in capturedBody));
    assert.deepEqual(Array.from(result.bytes), Array.from(PNG_BYTES));
    assert.equal(result.mimeType, "image/png");
  });

  it("downloads data[].url when b64_json is absent", async () => {
    const calls: string[] = [];
    stubFetch(async (input) => {
      calls.push(String(input));
      if (String(input).endsWith("/images/generations")) {
        return jsonResponse({ data: [{ url: "https://oss.example.com/x.png" }] });
      }
      return new Response(PNG_BYTES.slice(), {
        headers: { "Content-Type": "application/png" },
      });
    });

    const result = await generateImage({ client: CLIENT, prompt: "p" });
    assert.equal(calls.length, 2);
    assert.deepEqual(Array.from(result.bytes), Array.from(PNG_BYTES));
    assert.equal(result.mimeType, "image/png");
  });

  it("prefers b64_json over url when both exist", async () => {
    stubFetch(async (input) => {
      if (String(input).endsWith("/images/generations")) {
        return jsonResponse({
          data: [{ url: "https://oss.example.com/never.png", b64_json: PNG_B64 }],
        });
      }
      throw new Error("download must not happen");
    });

    const result = await generateImage({ client: CLIENT, prompt: "p" });
    assert.deepEqual(Array.from(result.bytes), Array.from(PNG_BYTES));
  });

  it("surfaces provider error detail on non-2xx", async () => {
    stubFetch(async () =>
      jsonResponse(
        { error: { code: "1211", message: "模型不存在" } },
        400,
      ),
    );
    await assert.rejects(
      generateImage({ client: CLIENT, prompt: "p" }),
      /HTTP 400: 模型不存在 \(1211\)/,
    );
  });

  it("throws when the response has no image data", async () => {
    stubFetch(async () => jsonResponse({ created: 1, data: [] }));
    await assert.rejects(
      generateImage({ client: CLIENT, prompt: "p" }),
      /no image data/,
    );
  });

  it("honors rawEndpoint by using baseUrl as-is", async () => {
    let capturedUrl = "";
    stubFetch(async (input) => {
      capturedUrl = String(input);
      return jsonResponse({ data: [{ b64_json: PNG_B64 }] });
    });
    await generateImage({
      client: { ...CLIENT, rawEndpoint: true, baseUrl: "https://gw.example.com/v1/images/generations" },
      prompt: "p",
    });
    assert.equal(capturedUrl, "https://gw.example.com/v1/images/generations");
  });

  it("sends watermark only when explicitly true/false", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    stubFetch(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ data: [{ b64_json: PNG_B64 }] });
    });

    await generateImage({ client: CLIENT, prompt: "p" });
    await generateImage({ client: CLIENT, prompt: "p", watermark: true });
    await generateImage({ client: CLIENT, prompt: "p", watermark: false });

    assert.ok(!("watermark" in bodies[0]!), "omitted → field not sent");
    assert.equal(bodies[1]!.watermark, true);
    assert.equal(bodies[2]!.watermark, false);
  });

  it("sends input images as the image body field when provided", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    stubFetch(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ data: [{ b64_json: PNG_B64 }] });
    });

    await generateImage({ client: CLIENT, prompt: "p" });
    await generateImage({
      client: CLIENT,
      prompt: "p",
      images: [
        Buffer.from(PNG_BYTES).toString("base64"),
        "https://cos.example.com/ref-1.png",
      ],
    });

    assert.ok(!("image" in bodies[0]!), "no images → field not sent");
    assert.deepEqual(bodies[1]!.image, [
      Buffer.from(PNG_BYTES).toString("base64"),
      "https://cos.example.com/ref-1.png",
    ]);
  });
});

describe("sniffImageMime", () => {
  it("detects png / jpeg / webp / gif magic bytes", () => {
    assert.equal(sniffImageMime(PNG_BYTES), "image/png");
    assert.equal(
      sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])),
      "image/jpeg",
    );
    assert.equal(
      sniffImageMime(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      ),
      "image/webp",
    );
    assert.equal(
      sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38])),
      "image/gif",
    );
    assert.equal(sniffImageMime(new Uint8Array([0, 1, 2, 3])), null);
  });

  it("maps mime types to extensions", () => {
    assert.equal(imageExtensionForMime("image/png"), "png");
    assert.equal(imageExtensionForMime("image/jpeg"), "jpg");
    assert.equal(imageExtensionForMime("image/webp"), "webp");
    assert.equal(imageExtensionForMime("image/gif"), "gif");
    assert.equal(imageExtensionForMime("unknown"), "png");
  });
});

describe("saveGeneratedImage", () => {
  it("writes a timestamped file with the mime-derived extension", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jellybot-imagegen-"));
    tmpDirs.push(dir);
    const saved = await saveGeneratedImage(PNG_BYTES, "image/png", dir);
    assert.match(saved.filePath, /img-\d{8}-\d{6}-[0-9a-f]{4}\.png$/);
    assert.equal(saved.sizeBytes, PNG_BYTES.length);
    const onDisk = new Uint8Array(await readFile(saved.filePath));
    assert.deepEqual(Array.from(onDisk), Array.from(PNG_BYTES));
  });
});
