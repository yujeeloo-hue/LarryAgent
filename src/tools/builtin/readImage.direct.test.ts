import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readImageHandler } from "./readImage.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolExecuteContext } from "../types.js";

// 1x1 transparent PNG.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

describe("read_image direct (tool-role images)", () => {
  let dir = "";
  let imagePath = "";

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "read-image-direct-"));
    imagePath = join(dir, "shot.png");
    writeFileSync(imagePath, PNG_1X1);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeContext(
    overrides: Partial<ToolExecuteContext> = {},
  ): ToolExecuteContext {
    return {
      workspacePath: dir,
      fullPermissionsEnabled: true,
      ...overrides,
    } as ToolExecuteContext;
  }

  it("uploadReadImage success returns [text hint, attachment with s3] and needs no vision client", async () => {
    const result = await readImageHandler(
      { path: imagePath, question: "count the red pixels" },
      makeContext({
        uploadReadImage: async () => ({
          url: "https://bucket.example/j/shot.png",
          key: "j/shot.png",
        }),
        // No getVisionClient on purpose: direct mode must not need Vision.
      }),
    );
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0]!.type, "text");
    assert.match(
      (result.content[0] as { text: string }).text,
      /attached in this tool result/,
    );
    assert.match(
      (result.content[0] as { text: string }).text,
      /focus: count the red pixels/,
    );
    const attachment = result.content[1]!;
    assert.equal(attachment.type, "attachment");
    if (attachment.type !== "attachment") return;
    assert.equal(attachment.kind, "image");
    assert.equal(attachment.uri, imagePath);
    assert.equal(attachment.s3?.url, "https://bucket.example/j/shot.png");
    assert.equal(attachment.s3?.key, "j/shot.png");
  });

  it("upload failure (null) degrades to the relay path", async () => {
    const result = await readImageHandler(
      { path: imagePath },
      makeContext({
        uploadReadImage: async () => null,
        getVisionClient: async () => null,
      }),
    );
    // Relay path reached the vision gate and reported the configuration gap
    // (no HTTP vision call happened) — proving the direct branch let go.
    assert.equal(result.returnCode, ToolReturnCode.GenericFailure);
    assert.match(
      (result.content[0] as { text: string }).text,
      /No vision-capable model available/,
    );
  });

  it("upload throw degrades to the relay path too", async () => {
    const result = await readImageHandler(
      { path: imagePath },
      makeContext({
        uploadReadImage: async () => {
          throw new Error("S3 unavailable");
        },
        getVisionClient: async () => null,
      }),
    );
    assert.equal(result.returnCode, ToolReturnCode.GenericFailure);
  });

  it("missing file skips direct and reports NotFound via the relay path", async () => {
    const result = await readImageHandler(
      { path: join(dir, "nope.png") },
      makeContext({
        uploadReadImage: async () => ({
          url: "https://bucket.example/x.png",
          key: "x.png",
        }),
        getVisionClient: async () => null,
      }),
    );
    assert.equal(result.returnCode, ToolReturnCode.GenericFailure);
    assert.match(
      (result.content[0] as { text: string }).text,
      /No vision-capable model available/,
    );
  });
});
