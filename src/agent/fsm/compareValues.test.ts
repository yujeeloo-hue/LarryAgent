import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareTyped, parseFiniteNumber } from "./compareValues.js";

describe("compareValues", () => {
  it("int comparisons (numeric strings coerce)", () => {
    const rows: Array<[unknown, string, unknown, boolean]> = [
      [3, "==", 3, true],
      [3, "==", "3", true],
      [3, "!=", 4, true],
      [3, "!=", "3", false],
      [3, ">", 2, true],
      [3, ">", 3, false],
      [3, "<", 4, true],
      [3, "<=", 3, true],
      [3, "<=", 2, false],
      [3, ">=", 3, true],
      [3, ">=", 4, false],
      [-1, "<", 0, true],
    ];
    for (const [actual, op, expected, want] of rows) {
      const out = compareTyped("int", op, actual, expected);
      assert.deepEqual(
        out,
        { ok: true, met: want },
        `int ${JSON.stringify(actual)} ${op} ${JSON.stringify(expected)}`,
      );
    }
  });

  it("float comparisons with numeric-string coercion", () => {
    assert.deepEqual(compareTyped("float", ">=", "2.5", "2.50"), {
      ok: true,
      met: true,
    });
    assert.deepEqual(compareTyped("float", "<", 1, "0.5"), {
      ok: true,
      met: false,
    });
    assert.deepEqual(compareTyped("float", "==", 0.1, 0.1), {
      ok: true,
      met: true,
    });
  });

  it("int rejects non-integer values on both sides", () => {
    assert.equal(compareTyped("int", ">", 1.5, 1).ok, false);
    assert.equal(compareTyped("int", "==", "5.5", 5).ok, false);
    assert.equal(compareTyped("int", ">", 1, 1.5).ok, false);
    assert.equal(compareTyped("int", ">", 1, "6.25").ok, false);
  });

  it("string comparisons are lexicographic", () => {
    assert.deepEqual(compareTyped("string", "==", "done", "done"), {
      ok: true,
      met: true,
    });
    assert.deepEqual(compareTyped("string", "!=", "done", "fail"), {
      ok: true,
      met: true,
    });
    assert.deepEqual(compareTyped("string", "!=", "done", "done"), {
      ok: true,
      met: false,
    });
    assert.deepEqual(compareTyped("string", "<", "apple", "banana"), {
      ok: true,
      met: true,
    });
    assert.deepEqual(compareTyped("string", "<=", "b", "b"), {
      ok: true,
      met: true,
    });
    assert.deepEqual(compareTyped("string", ">", "b", "a"), {
      ok: true,
      met: true,
    });
    assert.deepEqual(compareTyped("string", ">=", "a", "b"), {
      ok: true,
      met: false,
    });
  });

  it("string type does not cross-coerce numbers", () => {
    const out = compareTyped("string", "==", 3, "3");
    assert.equal(out.ok, false);
  });

  it("malformed input lands on the named error path", () => {
    // missing actual
    assert.equal(compareTyped("int", ">", undefined, 1).ok, false);
    assert.equal(compareTyped("int", ">", null, 1).ok, false);
    // non-numeric actual
    assert.equal(compareTyped("float", ">", "abc", 1).ok, false);
    assert.equal(compareTyped("float", ">", { a: 1 }, 1).ok, false);
    // non-finite actual
    assert.equal(compareTyped("float", ">", Number.NaN, 1).ok, false);
    assert.equal(
      compareTyped("float", ">", Number.POSITIVE_INFINITY, 1).ok,
      false,
    );
    // bad expected
    assert.equal(compareTyped("int", ">", 1, "xyz").ok, false);
    assert.equal(compareTyped("float", ">", 1, null).ok, false);
    assert.equal(compareTyped("string", "==", "a", 3).ok, false);
    // bad operator
    assert.equal(compareTyped("int", "~", 1, 1).ok, false);
  });

  it("parseFiniteNumber", () => {
    assert.equal(parseFiniteNumber(3), 3);
    assert.equal(parseFiniteNumber(-0.25), -0.25);
    assert.equal(parseFiniteNumber(" 4.5 "), 4.5);
    assert.equal(parseFiniteNumber("x"), undefined);
    assert.equal(parseFiniteNumber(""), undefined);
    assert.equal(parseFiniteNumber("   "), undefined);
    assert.equal(parseFiniteNumber(null), undefined);
    assert.equal(parseFiniteNumber(undefined), undefined);
    assert.equal(parseFiniteNumber({ a: 1 }), undefined);
    assert.equal(parseFiniteNumber(Number.POSITIVE_INFINITY), undefined);
    assert.equal(parseFiniteNumber(Number.NaN), undefined);
  });
});
