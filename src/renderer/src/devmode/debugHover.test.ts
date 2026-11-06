import assert from "node:assert/strict";
import test from "node:test";
import { debugExpressionAt } from "./DebugHoverView.js";

test("extracts identifiers and C++ member expressions for debug hover", () => {
  assert.deepEqual(debugExpressionAt("int total = count;", 14), {
    expression: "count",
    startColumn: 13,
    endColumn: 18,
  });
  assert.deepEqual(debugExpressionAt("this -> player . Health", 19), {
    expression: "this->player.Health",
    startColumn: 1,
    endColumn: 24,
  });
});

test("ignores punctuation and numeric literals", () => {
  assert.equal(debugExpressionAt("value + 42", 7), null);
  assert.equal(debugExpressionAt("42", 1), null);
});
