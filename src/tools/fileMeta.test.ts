import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isDisplayImagePath,
  isSvgMimeType,
  isSvgPath,
  isVisionImagePath,
  isVisionImageRef,
} from "./fileMeta.js";

describe("isSvgPath / isSvgMimeType", () => {
  it("detects .svg paths and svg MIME types", () => {
    assert.equal(isSvgPath("/tmp/icon.svg"), true);
    assert.equal(isSvgPath("/tmp/icon.SVG"), true);
    assert.equal(isSvgPath("/tmp/icon.png"), false);
    assert.equal(isSvgMimeType("image/svg+xml"), true);
    assert.equal(isSvgMimeType("image/png"), false);
    assert.equal(isSvgMimeType(undefined), false);
  });
});

describe("isVisionImagePath / isVisionImageRef", () => {
  it("allows rasters and rejects SVG even when kinded as an image", () => {
    assert.equal(isVisionImagePath("/tmp/a.png"), true);
    assert.equal(isVisionImagePath("/tmp/a.svg"), false);
    assert.equal(isDisplayImagePath("/tmp/a.svg"), true);
    assert.equal(isVisionImageRef("/tmp/a.png", "image/png"), true);
    assert.equal(isVisionImageRef("/tmp/icon.svg", "image/svg+xml"), false);
    assert.equal(isVisionImageRef("/tmp/icon.png", "image/svg+xml"), false);
  });
});
