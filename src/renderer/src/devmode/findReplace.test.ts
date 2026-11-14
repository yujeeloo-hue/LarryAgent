/**
 * Find / replace — hotkeys, regex expansion, widget chrome.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  expandReplacePattern,
  findWidgetHotkey,
  positionAfterInsert,
} from "./findReplace.js";

function keys(
  partial: Partial<{
    key: string;
    code: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }>,
): {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
} {
  return {
    key: "f",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  };
}

describe("findWidgetHotkey", () => {
  it("maps Ctrl/Cmd+F to find", () => {
    assert.equal(findWidgetHotkey(keys({ key: "f", ctrlKey: true })), "find");
    assert.equal(findWidgetHotkey(keys({ key: "f", metaKey: true })), "find");
  });

  it("maps Ctrl+H to replace without stealing Cmd+H", () => {
    assert.equal(findWidgetHotkey(keys({ key: "h", ctrlKey: true })), "replace");
    assert.equal(findWidgetHotkey(keys({ key: "h", metaKey: true })), null);
  });

  it("maps Cmd+Alt+F and Ctrl+Alt+F to replace", () => {
    assert.equal(
      findWidgetHotkey(keys({ key: "f", metaKey: true, altKey: true })),
      "replace",
    );
    assert.equal(
      findWidgetHotkey(keys({ key: "f", ctrlKey: true, altKey: true })),
      "replace",
    );
  });

  it("ignores keys without a modifier", () => {
    assert.equal(findWidgetHotkey(keys({ key: "f" })), null);
    assert.equal(findWidgetHotkey(keys({ key: "h" })), null);
  });
});

describe("expandReplacePattern", () => {
  it("leaves the template alone in literal mode", () => {
    assert.equal(expandReplacePattern("$1 $&", "abc", ["abc", "a"], false), "$1 $&");
  });

  it("expands $& and capture groups", () => {
    assert.equal(
      expandReplacePattern("[$&]/$1", "ab", ["ab", "a"], true),
      "[ab]/a",
    );
  });

  it("treats $$ as a literal dollar", () => {
    assert.equal(expandReplacePattern("$$1", "x", ["x", "y"], true), "$1");
  });

  it("uses an empty string for a missing group", () => {
    assert.equal(expandReplacePattern("$2", "ab", ["ab", "a"], true), "");
  });
});

describe("positionAfterInsert", () => {
  it("advances the column on a single line", () => {
    assert.deepEqual(positionAfterInsert(3, 5, "hi"), {
      lineNumber: 3,
      column: 7,
    });
  });

  it("moves to the last inserted line for a multiline string", () => {
    assert.deepEqual(positionAfterInsert(3, 5, "a\nbc"), {
      lineNumber: 4,
      column: 3,
    });
  });
});
