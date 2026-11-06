/**
 * display_image handler — attachment part wiring for the inline preview
 * fields (thumbnailBase64 / thumbnailMimeType) consumed by the web console.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolExecuteContext } from "../types.js";
import { setCliExecForTests, setNativeImageDecoderForTests } from "../imageThumbnail.js";
import { displayImageHandler } from "./displayImage.js";

function makeContext(workspacePath: string): ToolExecuteContext {
  return {
    workspacePath,
    fullPermissionsEnabled: true,
  };
}

const fixtures = `${tmpdir()}/displayImage.test`;
after(async () => {
  setNativeImageDecoderForTests(undefined);
  setCliExecForTests(undefined);
  await rm(fixtures, { recursive: true, force: true });
});

describe("display_image thumbnail wiring", () => {
  it("embeds the inline preview for SVG (no raster decoder needed)", async () => {
    setNativeImageDecoderForTests(null);
    await mkdir(fixtures, { recursive: true });
    const dir = await mkdtemp(join(fixtures, "case-"));
    const svgPath = join(dir, "chart.svg");
    const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"4\" height=\"4\"/></svg>";
    await writeFile(svgPath, svg);

    const result = await displayImageHandler({ path: svgPath }, makeContext(dir));
    assert.equal(result.returnCode, ToolReturnCode.Success);
    const attachment = result.content.find((part) => part.type === "attachment") as
      | { thumbnailBase64?: string; thumbnailMimeType?: string }
      | undefined;
    assert.ok(attachment);
    assert.equal(attachment.thumbnailMimeType, "image/svg+xml");
    assert.equal(attachment.thumbnailBase64, Buffer.from(svg).toString("base64"));
  });

  it("omits preview fields for rasters when no decoder exists (plain Node)", async () => {
    setNativeImageDecoderForTests(null);
    await mkdir(fixtures, { recursive: true });
    const dir = await mkdtemp(join(fixtures, "case-"));
    const pngPath = join(dir, "shot.png");
    await writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const result = await displayImageHandler({ path: pngPath }, makeContext(dir));
    assert.equal(result.returnCode, ToolReturnCode.Success);
    const attachment = result.content.find((part) => part.type === "attachment") as
      | { thumbnailBase64?: string; thumbnailMimeType?: string }
      | undefined;
    assert.ok(attachment);
    assert.equal(attachment.thumbnailBase64, undefined);
    assert.equal(attachment.thumbnailMimeType, undefined);
  });

  it("embeds the ffmpeg CLI preview for rasters on the headless agentd", async () => {
    setNativeImageDecoderForTests(null);
    const pngOut = Buffer.alloc(2_000);
    const jpeg = Buffer.alloc(3_000);
    setCliExecForTests(async (_bin, args) => {
      if (args.includes("-version")) return Buffer.from("ffmpeg version 5.1.9-fake");
      // png source: the PNG pass fits the budget, so the ladder stops there.
      return args.includes("mjpeg") ? jpeg : pngOut;
    });
    await mkdir(fixtures, { recursive: true });
    const dir = await mkdtemp(join(fixtures, "case-"));
    const pngPath = join(dir, "shot.png");
    await writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const result = await displayImageHandler({ path: pngPath }, makeContext(dir));
    assert.equal(result.returnCode, ToolReturnCode.Success);
    const attachment = result.content.find((part) => part.type === "attachment") as
      | { thumbnailBase64?: string; thumbnailMimeType?: string }
      | undefined;
    assert.ok(attachment);
    assert.equal(attachment.thumbnailMimeType, "image/png");
    assert.equal(attachment.thumbnailBase64, pngOut.toString("base64"));
  });
});
