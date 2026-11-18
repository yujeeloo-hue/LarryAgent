import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyF12Shortcut } from "./f12Shortcut.js";

function f12(partial: {
  type?: string;
  key?: string;
  shift?: boolean;
  control?: boolean;
  alt?: boolean;
  meta?: boolean;
} = {}) {
  return {
    type: "keyDown",
    key: "F12",
    shift: false,
    control: false,
    alt: false,
    meta: false,
    ...partial,
  };
}

describe("classifyF12Shortcut", () => {
  it("maps plain F12 to go-to-definition", () => {
    assert.equal(classifyF12Shortcut(f12()), "goto-definition");
  });

  it("maps Shift+F12 to Find Usages", () => {
    assert.equal(classifyF12Shortcut(f12({ shift: true })), "find-usages");
  });

  it("ignores F12 chords that are not the parked shortcut", () => {
    assert.equal(classifyF12Shortcut(f12({ control: true })), null);
    assert.equal(classifyF12Shortcut(f12({ alt: true })), null);
    assert.equal(classifyF12Shortcut(f12({ meta: true })), null);
    assert.equal(classifyF12Shortcut(f12({ type: "keyUp" })), null);
    assert.equal(classifyF12Shortcut(f12({ key: "F11" })), null);
  });
});
