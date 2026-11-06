import assert from "node:assert/strict";
import { test } from "node:test";

import { formatCppSymbolIndexProgress } from "./cppSymbolProgress.js";

test("formatCppSymbolIndexProgress uses English grouping", () => {
  assert.equal(formatCppSymbolIndexProgress(0, 0), "Indexing C++ symbols…");
  assert.equal(
    formatCppSymbolIndexProgress(1240, 8010),
    "Indexing C++ symbols… 1,240 / 8,010",
  );
});
