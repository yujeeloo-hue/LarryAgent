import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatResetTime,
  formatResetTimeSmart,
  lenientNumber,
  parseIsoDate,
} from "./util.js";

/** Fixed clock — the same-day branch must never depend on the test runner's date. */
const NOW = new Date(2026, 10, 14, 9, 30);

describe("formatResetTimeSmart", () => {
  it("shows only the clock for a reset later today", () => {
    assert.equal(
      formatResetTimeSmart(new Date(2026, 10, 14, 21, 5), NOW),
      "21:05",
    );
  });

  it("shows only the date once the reset is on another day", () => {
    assert.equal(formatResetTimeSmart(new Date(2026, 10, 15, 0, 0), NOW), "Nov 15");
    assert.equal(formatResetTimeSmart(new Date(2026, 11, 1, 8, 30), NOW), "Dec 1");
    assert.equal(formatResetTimeSmart(new Date(2026, 10, 13, 23, 0), NOW), "Nov 13");
  });

  it("keeps the full stamp in the unscoped formatter", () => {
    assert.equal(formatResetTime(new Date(2026, 10, 15, 8, 30)), "Nov 15, 08:30");
  });
});

describe("lenientNumber / parseIsoDate", () => {
  it("accepts the string-or-number drift these APIs emit", () => {
    assert.equal(lenientNumber("100"), 100);
    assert.equal(lenientNumber(42.5), 42.5);
    assert.equal(lenientNumber(" 7 "), 7);
    assert.equal(lenientNumber("abc"), null);
    assert.equal(lenientNumber(null), null);
  });

  it("parses microsecond ISO stamps", () => {
    const parsed = parseIsoDate("2026-10-12T15:51:25.973986Z");
    assert.ok(parsed instanceof Date);
    assert.equal(parsed?.getTime(), Date.parse("2026-10-12T15:51:25.973Z"));
    assert.equal(parseIsoDate("not-a-date"), null);
  });
});
