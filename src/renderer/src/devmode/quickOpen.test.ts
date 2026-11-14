/**
 * Quick Open — fuzzy matcher re-export.
 * Symbol scanning lives in documentSymbols.test.ts (`scanQuickOpenSymbols`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fuzzyMatch } from "./QuickOpenController.js";

describe("fuzzyMatch", () => {
  it("empty query matches everything", () => {
    assert.equal(fuzzyMatch("", "anything.ts"), true);
  });

  it("exact substring matches", () => {
    assert.equal(fuzzyMatch("editor", "EditorAreaController.ts"), true);
  });

  it("case-insensitive subsequence across the target", () => {
    // e-a-c subsequence of EditorAreaController
    assert.equal(fuzzyMatch("eac", "EditorAreaController.ts"), true);
  });

  it("out-of-order characters do not match", () => {
    assert.equal(fuzzyMatch("cae", "EditorAreaController.ts"), false);
  });

  it("missing character does not match", () => {
    assert.equal(fuzzyMatch("zzz", "EditorAreaController.ts"), false);
  });

  it("query longer than target never matches", () => {
    assert.equal(fuzzyMatch("EditorAreaController.ts.bak", "EditorAreaController.ts"), false);
  });
});
