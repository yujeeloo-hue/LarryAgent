import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanCppUsageText } from "./usageSearch.js";

describe("scanCppUsageText", () => {
  it("matches complete identifiers with line and column", () => {
    const result = scanCppUsageText(
      "Demo.cpp",
      "Foo();\nFooBar();\n  Obj->Foo();\n",
      "Foo",
    );
    assert.deepEqual(
      result.matches.map(({ line, column, lineText }) => ({
        line,
        column,
        lineText,
      })),
      [
        { line: 1, column: 1, lineText: "Foo();" },
        { line: 3, column: 8, lineText: "Obj->Foo();" },
      ],
    );
    assert.equal(result.truncated, false);
  });

  it("caps results and reports truncation", () => {
    const result = scanCppUsageText("Demo.cpp", "Foo Foo Foo", "Foo", 2);
    assert.equal(result.matches.length, 2);
    assert.equal(result.truncated, true);
  });

  it("rejects non-identifiers", () => {
    assert.deepEqual(
      scanCppUsageText("Demo.cpp", "Foo()", "Foo<int>"),
      { matches: [], truncated: false },
    );
  });
});
