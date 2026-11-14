import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mergeOverlayScrollbarFeature,
  shouldForceOverlayScrollbars,
} from "./scrollbarPresentation.js";
import { IS_WINDOWS } from "../platformCaps.js";

describe("overlay scrollbar feature merge", () => {
  it("appends the feature when nothing is set", () => {
    assert.equal(mergeOverlayScrollbarFeature(""), "OverlayScrollbar");
  });

  it("keeps existing features and appends", () => {
    assert.equal(
      mergeOverlayScrollbarFeature("WebGPU,SomeFlag"),
      "WebGPU,SomeFlag,OverlayScrollbar",
    );
  });

  it("does not duplicate an existing entry", () => {
    assert.equal(
      mergeOverlayScrollbarFeature("OverlayScrollbar,WebGPU"),
      "WebGPU,OverlayScrollbar",
    );
  });

  it("drops stray whitespace and empty segments", () => {
    assert.equal(
      mergeOverlayScrollbarFeature(" , WebGPU , ,OverlayScrollbar, "),
      "WebGPU,OverlayScrollbar",
    );
  });

  it("gates on the platform: forced exactly on Windows, never on macOS", () => {
    // The invariant that keeps macOS presentation untouched: the switch is
    // only ever appended when platformCaps says so.
    assert.equal(shouldForceOverlayScrollbars(), IS_WINDOWS);
  });
});
