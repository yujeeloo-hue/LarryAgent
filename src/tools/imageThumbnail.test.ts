/**
 * imageThumbnail — inline preview generation for image tool results
 * (thumbnailBase64 / thumbnailMimeType on the attachment part).
 * The nativeImage decoder is injected through the test seam; a null decoder
 * mirrors plain-Node runs (tests, Loops daemon) where rasters degrade to
 * "no thumbnail". The agentd ffmpeg CLI fallback is exercised through the
 * exec seam — the test runner is not headless, so without the seam the CLI
 * path stays off and plain-Node cases keep their null expectation.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  THUMBNAIL_MAX_BASE64_CHARS,
  imageThumbnailFromBytes,
  imageThumbnailFromFile,
  setCliExecForTests,
  setNativeImageDecoderForTests,
} from "./imageThumbnail.js";

type DecodeScript = {
  width: number;
  height: number;
  empty?: boolean;
  /** Buffers returned by toPNG / toJPEG in order of the encoding ladder. */
  png?: Buffer[];
  jpeg?: Buffer[];
  /** resize() calls seen (for scale assertions). */
  resized: Array<{ width: number; height: number }>;
};

function fakeDecoder(script: DecodeScript): { createFromBuffer(buffer: Buffer): unknown } {
  const image = {
    isEmpty: () => script.empty === true,
    getSize: () => ({ width: script.width, height: script.height }),
    resize(options: { width: number; height: number }) {
      script.resized.push({ width: options.width, height: options.height });
      return image;
    },
    toPNG: () => script.png?.shift() ?? Buffer.alloc(0),
    toJPEG: (_quality: number) => script.jpeg?.shift() ?? Buffer.alloc(0),
  };
  return { createFromBuffer: () => image };
}

const fixtures = `${tmpdir()}/imageThumbnail.test`;
after(async () => {
  setNativeImageDecoderForTests(undefined);
  setCliExecForTests(undefined);
  await rm(fixtures, { recursive: true, force: true });
});

describe("imageThumbnailFromBytes", () => {
  it("embeds SVG sources verbatim without a decoder", async () => {
    setNativeImageDecoderForTests(null);
    const svg = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    const thumb = await imageThumbnailFromBytes(svg, "image/svg+xml");
    assert.ok(thumb);
    assert.equal(thumb.mimeType, "image/svg+xml");
    assert.equal(thumb.base64, svg.toString("base64"));
  });

  it("returns null when no decoder is available (plain Node / daemon)", async () => {
    setNativeImageDecoderForTests(null);
    assert.equal(
      await imageThumbnailFromBytes(Buffer.from([1, 2, 3]), "image/png"),
      null,
    );
  });

  it("downscales by longest edge and re-encodes JPEG sources", async () => {
    const jpeg = Buffer.alloc(4_000); // small enough for the budget
    const script: DecodeScript = {
      width: 2560,
      height: 1440,
      jpeg: [jpeg],
      resized: [],
    };
    setNativeImageDecoderForTests(fakeDecoder(script) as never);
    const thumb = await imageThumbnailFromBytes(jpeg, "image/jpeg");
    assert.ok(thumb);
    assert.equal(thumb.mimeType, "image/jpeg");
    assert.equal(thumb.base64, jpeg.toString("base64"));
    assert.deepEqual(script.resized, [{ width: 1280, height: 720 }]);
  });

  it("keeps PNG when the PNG encoding fits the budget", async () => {
    const png = Buffer.alloc(8_000);
    const script: DecodeScript = {
      width: 900,
      height: 600,
      png: [png],
      jpeg: [Buffer.alloc(5_000)],
      resized: [],
    };
    setNativeImageDecoderForTests(fakeDecoder(script) as never);
    const thumb = await imageThumbnailFromBytes(png, "image/png");
    assert.ok(thumb);
    assert.equal(thumb.mimeType, "image/png");
    assert.deepEqual(script.resized, []); // within bounds — no resize
    assert.equal(script.jpeg?.length, 1, "JPEG ladder untouched");
  });

  it("falls back to JPEG when PNG busts the budget", async () => {
    const oversizedPng = Buffer.alloc(THUMBNAIL_MAX_BASE64_CHARS); // > budget as base64
    const jpeg = Buffer.alloc(6_000);
    const script: DecodeScript = {
      width: 1280,
      height: 800,
      png: [oversizedPng],
      jpeg: [jpeg],
      resized: [],
    };
    setNativeImageDecoderForTests(fakeDecoder(script) as never);
    const thumb = await imageThumbnailFromBytes(oversizedPng, "image/png");
    assert.ok(thumb);
    assert.equal(thumb.mimeType, "image/jpeg");
    assert.equal(thumb.base64, jpeg.toString("base64"));
  });

  it("gives up when every encoding busts the budget", async () => {
    const script: DecodeScript = {
      width: 640,
      height: 480,
      jpeg: [
        Buffer.alloc(THUMBNAIL_MAX_BASE64_CHARS),
        Buffer.alloc(THUMBNAIL_MAX_BASE64_CHARS),
      ],
      resized: [],
    };
    setNativeImageDecoderForTests(fakeDecoder(script) as never);
    assert.equal(
      await imageThumbnailFromBytes(Buffer.alloc(10), "image/jpeg"),
      null,
    );
  });

  it("returns null for undecodable rasters (isEmpty)", async () => {
    const script: DecodeScript = {
      width: 0,
      height: 0,
      empty: true,
      jpeg: [],
      resized: [],
    };
    setNativeImageDecoderForTests(fakeDecoder(script) as never);
    assert.equal(
      await imageThumbnailFromBytes(Buffer.alloc(10), "image/webp"),
      null,
    );
  });

  it("returns null for oversize or empty sources", async () => {
    setNativeImageDecoderForTests(fakeDecoder({
      width: 10,
      height: 10,
      jpeg: [],
      resized: [],
    }) as never);
    assert.equal(
      await imageThumbnailFromBytes(Buffer.alloc(0), "image/png"),
      null,
    );
    assert.equal(
      await imageThumbnailFromBytes(Buffer.alloc(33 * 1024 * 1024), "image/png"),
      null,
    );
  });
});

// ── agentd ffmpeg CLI fallback (setCliExecForTests seam) ─────────
type CliExecCall = { bin: string; args: string[]; inputLength: number };

/**
 * Fake ffmpeg executable: answers the `-version` probe, then hands out the
 * scripted encode outputs in pass order (null = pass failed).
 */
function fakeCliExec(opts: {
  probeOk?: boolean;
  encodeOutputs?: Array<Buffer | null>;
}): {
  exec: (
    bin: string,
    args: string[],
    input: Buffer,
    timeoutMs: number,
    maxBuffer: number,
  ) => Promise<Buffer | null>;
  calls: CliExecCall[];
} {
  const calls: CliExecCall[] = [];
  const outputs = [...(opts.encodeOutputs ?? [])];
  return {
    calls,
    exec: async (bin, args, input) => {
      calls.push({ bin, args, inputLength: input.length });
      if (args.includes("-version")) {
        return opts.probeOk === false
          ? null
          : Buffer.from("ffmpeg version 5.1.9-fake");
      }
      return outputs.shift() ?? null;
    },
  };
}

describe("cli fallback (agentd ffmpeg)", () => {
  it("re-encodes rasters through ffmpeg when nativeImage is absent", async () => {
    setNativeImageDecoderForTests(null);
    const jpeg = Buffer.alloc(4_000);
    const { exec, calls } = fakeCliExec({ encodeOutputs: [jpeg] });
    setCliExecForTests(exec);

    const thumb = await imageThumbnailFromBytes(Buffer.alloc(100), "image/jpeg");
    assert.ok(thumb);
    assert.equal(thumb.mimeType, "image/jpeg");
    assert.equal(thumb.base64, jpeg.toString("base64"));

    const probes = calls.filter((c) => c.args.includes("-version"));
    assert.equal(probes.length, 1, "one -version probe");
    const encode = calls.find((c) => !c.args.includes("-version"));
    assert.ok(encode, "one encode pass");
    assert.equal(encode.inputLength, 100, "source bytes ride stdin");
    const argv = encode.args.join(" ");
    assert.match(argv, /-i pipe:0/);
    assert.match(argv, /-frames:v 1/);
    assert.match(argv, /scale=w='min\(iw,1280\)':h=-2/);
    assert.match(argv, /-vcodec mjpeg -q:v 4/);
    assert.equal(encode.args[encode.args.length - 1], "pipe:1");
  });

  it("keeps PNG first for png sources, falling back to JPEG on budget bust", async () => {
    setNativeImageDecoderForTests(null);
    const oversizedPng = Buffer.alloc(THUMBNAIL_MAX_BASE64_CHARS); // > budget as base64
    const jpeg = Buffer.alloc(6_000);
    const { exec, calls } = fakeCliExec({ encodeOutputs: [oversizedPng, jpeg] });
    setCliExecForTests(exec);

    const thumb = await imageThumbnailFromBytes(Buffer.alloc(10), "image/png");
    assert.ok(thumb);
    assert.equal(thumb.mimeType, "image/jpeg");
    assert.equal(thumb.base64, jpeg.toString("base64"));
    const encodes = calls.filter((c) => !c.args.includes("-version"));
    assert.equal(encodes.length, 2);
    assert.match(encodes[0]!.args.join(" "), /-vcodec png/);
    assert.match(encodes[1]!.args.join(" "), /-vcodec mjpeg -q:v 4/);
  });

  it("gives up when every CLI pass busts the budget", async () => {
    setNativeImageDecoderForTests(null);
    const big = Buffer.alloc(THUMBNAIL_MAX_BASE64_CHARS);
    const { exec, calls } = fakeCliExec({ encodeOutputs: [big, big, big] });
    setCliExecForTests(exec);

    assert.equal(await imageThumbnailFromBytes(Buffer.alloc(10), "image/png"), null);
    // png source: png + jpeg q4 + jpeg q8 — three passes, all over budget.
    assert.equal(calls.filter((c) => !c.args.includes("-version")).length, 3);
  });

  it("returns null without encoding when no ffmpeg binary probes", async () => {
    setNativeImageDecoderForTests(null);
    const { exec, calls } = fakeCliExec({ probeOk: false });
    setCliExecForTests(exec);

    assert.equal(await imageThumbnailFromBytes(Buffer.alloc(10), "image/png"), null);
    // Every candidate probed, zero encode attempts.
    assert.ok(calls.length >= 1);
    assert.ok(calls.every((c) => c.args.includes("-version")));
  });

  it("caches the probe result across thumbnails", async () => {
    setNativeImageDecoderForTests(null);
    const jpeg = Buffer.alloc(3_000);
    const { exec, calls } = fakeCliExec({ encodeOutputs: [jpeg, jpeg] });
    setCliExecForTests(exec);

    await imageThumbnailFromBytes(Buffer.alloc(10), "image/jpeg");
    await imageThumbnailFromBytes(Buffer.alloc(10), "image/jpeg");
    assert.equal(
      calls.filter((c) => c.args.includes("-version")).length,
      1,
      "probe runs once per process",
    );
  });

  it("stays off when the seam is explicitly disabled", async () => {
    setNativeImageDecoderForTests(null);
    const { exec, calls } = fakeCliExec({ encodeOutputs: [Buffer.alloc(10)] });
    setCliExecForTests(exec);
    setCliExecForTests(null);
    assert.equal(await imageThumbnailFromBytes(Buffer.alloc(10), "image/png"), null);
    assert.equal(calls.length, 0);
  });
});

describe("imageThumbnailFromFile", () => {
  it("reads, embeds and never throws (missing file → null)", async () => {
    setNativeImageDecoderForTests(null);
    await mkdir(fixtures, { recursive: true });
    const dir = await mkdtemp(join(fixtures, "case-"));
    const svgPath = join(dir, "diagram.svg");
    await writeFile(svgPath, "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect/></svg>");
    const thumb = await imageThumbnailFromFile(svgPath, "image/svg+xml", 60);
    assert.ok(thumb);
    assert.equal(thumb.mimeType, "image/svg+xml");

    assert.equal(
      await imageThumbnailFromFile(join(dir, "missing.png"), "image/png"),
      null,
    );
    // Oversize declared size skips the read entirely.
    assert.equal(
      await imageThumbnailFromFile(svgPath, "image/png", 33 * 1024 * 1024),
      null,
    );
  });
});
