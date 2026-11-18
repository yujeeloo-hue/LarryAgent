import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aspectRatioFromArgs, displayWidthFromArgs } from "./DisplayImageCardView.js";

describe("aspectRatioFromArgs", () => {
  it("parses pixel sizes (x and × separators)", () => {
    assert.equal(aspectRatioFromArgs({ size: "1024x1024" }), 1);
    assert.equal(aspectRatioFromArgs({ size: "1440x720" }), 2);
    assert.equal(aspectRatioFromArgs({ size: "1024×720" }), 1024 / 720);
    assert.equal(aspectRatioFromArgs({ size: " 1920 x 1080 " }), 1920 / 1080);
  });

  it("parses ratio strings", () => {
    assert.ok(
      Math.abs(aspectRatioFromArgs({ size: "16:9" })! - 16 / 9) < 1e-9,
    );
    assert.ok(
      Math.abs(aspectRatioFromArgs({ size: "9:16" })! - 9 / 16) < 1e-9,
    );
    assert.ok(Math.abs(aspectRatioFromArgs({ size: "1:1" })! - 1) < 1e-9);
  });

  it("returns null for unknown / unparseable sizes", () => {
    assert.equal(aspectRatioFromArgs({ size: "2K" }), null);
    assert.equal(aspectRatioFromArgs({ size: "4K" }), null);
    assert.equal(aspectRatioFromArgs({ size: "" }), null);
    assert.equal(aspectRatioFromArgs({ size: "banana" }), null);
    assert.equal(aspectRatioFromArgs({}), null);
    assert.equal(aspectRatioFromArgs(undefined), null);
    assert.equal(aspectRatioFromArgs({ size: 1024 }), null);
  });
});
