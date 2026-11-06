import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeCadence,
  isValidCadence,
  nextRunAt,
  normalizeCadence,
  parseTimeOfDay,
  type Cadence,
} from "./schedule.js";

/** Local-timezone construction (month 1-based, for test readability). */
function at(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
  ms = 0,
): Date {
  return new Date(year, month - 1, day, hour, minute, second, ms);
}

function assertDate(actual: Date, expected: Date): void {
  assert.equal(
    actual.getTime(),
    expected.getTime(),
    `expected ${expected.toString()}, got ${actual.toString()}`,
  );
}

// 2026-01-01 is a Thursday: Jan 2026 → 4=Sun, 5=Mon, 7=Wed, 8=Thu, 9=Fri, 10=Sat, 11=Sun, 12=Mon.

describe("parseTimeOfDay", () => {
  it("parses strict HH:MM", () => {
    assert.deepEqual(parseTimeOfDay("00:00"), { hour: 0, minute: 0 });
    assert.deepEqual(parseTimeOfDay("09:30"), { hour: 9, minute: 30 });
    assert.deepEqual(parseTimeOfDay("23:59"), { hour: 23, minute: 59 });
  });

  it("rejects malformed time strings", () => {
    for (const bad of ["24:00", "9:30", "09:5", "09:60", "0900", "09:30:00", "", "aa:bb"]) {
      assert.equal(parseTimeOfDay(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe("isValidCadence accepts valid values", () => {
  it("accepts each kind", () => {
    const valid: unknown[] = [
      { kind: "minute", n: 1 },
      { kind: "minute", n: 15 },
      { kind: "hour", minute: 0 },
      { kind: "hour", minute: 59 },
      { kind: "day", time: "00:00" },
      { kind: "day", time: "23:59" },
      { kind: "week", weekdays: [0], time: "09:30" },
      { kind: "week", weekdays: [0, 1, 4, 6], time: "09:30" },
      { kind: "month", day: 1, time: "09:00" },
      { kind: "month", day: 31, time: "09:00" },
      { kind: "year", month: 1, day: 1, time: "09:00" },
      { kind: "year", month: 2, day: 29, time: "09:00" },
      { kind: "year", month: 12, day: 31, time: "23:59" },
    ];
    for (const cadence of valid) {
      assert.ok(isValidCadence(cadence), `expected valid: ${JSON.stringify(cadence)}`);
    }
  });
});

describe("isValidCadence rejects invalid values", () => {
  it("rejects non-object / unknown kind / missing fields", () => {
    for (const bad of [null, undefined, 42, "minute", [], { kind: "minute" }, { kind: "second", n: 1 }]) {
      assert.equal(isValidCadence(bad), false, `expected invalid: ${JSON.stringify(bad)}`);
    }
  });

  it("rejects minute with non-positive / non-integer n", () => {
    for (const n of [0, -1, 1.5, "5", null]) {
      assert.equal(isValidCadence({ kind: "minute", n }), false, `n=${JSON.stringify(n)}`);
    }
  });

  it("rejects hour with minute out of 0-59", () => {
    assert.equal(isValidCadence({ kind: "hour", minute: 60 }), false);
    assert.equal(isValidCadence({ kind: "hour", minute: -1 }), false);
    assert.equal(isValidCadence({ kind: "hour", minute: 30.5 }), false);
  });

  it("rejects malformed time strings", () => {
    for (const time of ["9:30", 930, "09:60", "09:30:00", null]) {
      assert.equal(isValidCadence({ kind: "day", time }), false, `time=${JSON.stringify(time)}`);
    }
  });

  it("rejects empty / duplicate / unsorted / out-of-range weekdays", () => {
    const badWeekdays: unknown[] = [[], [1, 1], [4, 1], [7], [-1], [1.5], ["1"], "1,4", 4];
    for (const weekdays of badWeekdays) {
      assert.equal(
        isValidCadence({ kind: "week", weekdays, time: "09:30" }),
        false,
        `weekdays=${JSON.stringify(weekdays)}`,
      );
    }
    assert.equal(isValidCadence({ kind: "week", weekdays: [1], time: "9:30" }), false);
  });

  it("rejects month day out of 1-31 and year month/day out of range", () => {
    assert.equal(isValidCadence({ kind: "month", day: 0, time: "09:00" }), false);
    assert.equal(isValidCadence({ kind: "month", day: 32, time: "09:00" }), false);
    assert.equal(isValidCadence({ kind: "year", month: 0, day: 1, time: "09:00" }), false);
    assert.equal(isValidCadence({ kind: "year", month: 13, day: 1, time: "09:00" }), false);
    assert.equal(isValidCadence({ kind: "year", month: 2, day: 32, time: "09:00" }), false);
  });
});

describe("normalizeCadence (model input)", () => {
  it("canonicalizes week weekdays: dedupes and sorts ascending", () => {
    assert.deepEqual(
      normalizeCadence({ kind: "week", weekdays: [5, 1, 5, 1], time: "16:00" }),
      { kind: "week", weekdays: [1, 5], time: "16:00" },
    );
    // The stored invariant stays satisfiable: normalized output passes the strict check.
    assert.ok(isValidCadence(normalizeCadence({ kind: "week", weekdays: [4, 0, 4], time: "09:30" })!));
  });

  it("returns canonical copies for every other valid kind and passes strict validation", () => {
    const cases: unknown[] = [
      { kind: "minute", n: 15 },
      { kind: "hour", minute: 30 },
      { kind: "day", time: "09:30" },
      { kind: "month", day: 31, time: "09:00" },
      { kind: "year", month: 2, day: 29, time: "09:00" },
    ];
    for (const cadence of cases) {
      const normalized = normalizeCadence(cadence);
      assert.deepEqual(normalized, cadence);
      assert.ok(isValidCadence(normalized));
    }
  });

  it("rejects missing/misnamed weekday fields (the dayOfWeek production failure)", () => {
    for (const bad of [
      { kind: "week", dayOfWeek: 5, time: "16:00" },
      { kind: "week", weekday: 5, time: "16:00" },
      { kind: "week", weekdays: [], time: "16:00" },
      { kind: "week", weekdays: ["Fri"], time: "16:00" },
      { kind: "week", weekdays: [7], time: "16:00" },
      { kind: "week", weekdays: [5], time: "9:00" },
      { kind: "weekly", weekdays: [5], time: "16:00" },
      null,
    ]) {
      assert.equal(normalizeCadence(bad), null, `expected null: ${JSON.stringify(bad)}`);
    }
  });
});

describe("nextRunAt minute", () => {
  const cadence: Cadence = { kind: "minute", n: 5 };

  it("returns strictly future point when from is exactly on the tick", () => {
    const from = at(2026, 1, 5, 9, 0, 0, 0);
    const next = nextRunAt(cadence, from);
    assertDate(next, at(2026, 1, 5, 9, 5, 0, 0));
    assert.ok(next.getTime() > from.getTime());
  });

  it("anchors at from truncated to seconds and zeroes milliseconds", () => {
    const next = nextRunAt(cadence, at(2026, 1, 5, 9, 2, 30, 500));
    assertDate(next, at(2026, 1, 5, 9, 7, 30, 0));
    assert.equal(next.getMilliseconds(), 0);
  });

  it("rolls over to the next day", () => {
    assertDate(nextRunAt({ kind: "minute", n: 1 }, at(2026, 1, 5, 23, 59, 30)), at(2026, 1, 6, 0, 0, 30));
  });
});

describe("nextRunAt hour", () => {
  const cadence: Cadence = { kind: "hour", minute: 30 };

  it("returns today when the minute is still ahead", () => {
    assertDate(nextRunAt(cadence, at(2026, 1, 5, 9, 0)), at(2026, 1, 5, 9, 30));
  });

  it("advances to next hour when from is exactly at the candidate", () => {
    assertDate(nextRunAt(cadence, at(2026, 1, 5, 9, 30, 0, 0)), at(2026, 1, 5, 10, 30));
    assertDate(nextRunAt(cadence, at(2026, 1, 5, 9, 30, 0, 500)), at(2026, 1, 5, 10, 30));
  });

  it("wraps to the next day", () => {
    assertDate(nextRunAt(cadence, at(2026, 1, 5, 23, 45)), at(2026, 1, 6, 0, 30));
  });
});

describe("nextRunAt day", () => {
  const cadence: Cadence = { kind: "day", time: "09:30" };

  it("returns today when the time is still ahead", () => {
    assertDate(nextRunAt(cadence, at(2026, 1, 5, 9, 29)), at(2026, 1, 5, 9, 30));
  });

  it("advances to tomorrow when from is exactly at or past the time", () => {
    assertDate(nextRunAt(cadence, at(2026, 1, 5, 9, 30, 0, 0)), at(2026, 1, 6, 9, 30));
    assertDate(nextRunAt(cadence, at(2026, 1, 5, 18, 0)), at(2026, 1, 6, 9, 30));
  });

  it("wraps across month boundary", () => {
    assertDate(nextRunAt(cadence, at(2026, 1, 31, 10, 0)), at(2026, 2, 1, 9, 30));
  });
});

describe("nextRunAt week", () => {
  const cadence: Cadence = { kind: "week", weekdays: [1, 4], time: "09:30" };

  it("returns today when a weekday's time is still ahead", () => {
    // 2026-01-05 is a Monday.
    assertDate(nextRunAt(cadence, at(2026, 1, 5, 8, 0)), at(2026, 1, 5, 9, 30));
  });

  it("picks the earliest upcoming weekday (sorted weekdays, Mon→Thu)", () => {
    assertDate(nextRunAt(cadence, at(2026, 1, 5, 10, 0)), at(2026, 1, 8, 9, 30));
  });

  it("crosses to next week when this week's slots are all past", () => {
    // 2026-01-08 Thu exactly 09:30 → the next available slot is next Monday.
    assertDate(nextRunAt(cadence, at(2026, 1, 8, 9, 30, 0, 0)), at(2026, 1, 12, 9, 30));
    // Friday → next Monday.
    assertDate(nextRunAt(cadence, at(2026, 1, 9, 10, 0)), at(2026, 1, 12, 9, 30));
  });

  it("handles Sunday (0) before Saturday (6) within the week", () => {
    const weekend: Cadence = { kind: "week", weekdays: [0, 6], time: "09:30" };
    // 2026-01-10 Sat 10:00 → Sun 2026-01-11 09:30.
    assertDate(nextRunAt(weekend, at(2026, 1, 10, 10, 0)), at(2026, 1, 11, 9, 30));
  });

  it("single weekday repeats next week", () => {
    const wednesday: Cadence = { kind: "week", weekdays: [3], time: "09:30" };
    // 2026-01-07 Wed exactly 09:30 → 2026-01-14 Wed.
    assertDate(nextRunAt(wednesday, at(2026, 1, 7, 9, 30, 0, 0)), at(2026, 1, 14, 9, 30));
  });
});

describe("nextRunAt month", () => {
  const day31: Cadence = { kind: "month", day: 31, time: "09:00" };

  it("clamps day 31 to Feb 28 in non-leap year (cron semantics)", () => {
    assertDate(nextRunAt(day31, at(2026, 1, 31, 9, 0, 0, 0)), at(2026, 2, 28, 9, 0));
  });

  it("clamps day 31 to Feb 29 in leap year", () => {
    assertDate(nextRunAt(day31, at(2028, 1, 31, 9, 0, 0, 0)), at(2028, 2, 29, 9, 0));
  });

  it("advances to next month when clamped day is exactly at from", () => {
    // 2026-02-28 exactly 09:00 (this month's clamped candidate) → Mar 31.
    assertDate(nextRunAt(day31, at(2026, 2, 28, 9, 0, 0, 0)), at(2026, 3, 31, 9, 0));
  });

  it("mid-month day rolls normally and wraps the year", () => {
    const day15: Cadence = { kind: "month", day: 15, time: "09:00" };
    assertDate(nextRunAt(day15, at(2026, 1, 20, 10, 0)), at(2026, 2, 15, 9, 0));
    assertDate(nextRunAt(day15, at(2026, 12, 20, 10, 0)), at(2027, 1, 15, 9, 0));
  });
});

describe("nextRunAt year", () => {
  const feb29: Cadence = { kind: "year", month: 2, day: 29, time: "09:00" };

  it("slides Feb 29 to Mar 1 in a non-leap year", () => {
    assertDate(nextRunAt(feb29, at(2026, 1, 15, 0, 0)), at(2026, 3, 1, 9, 0));
  });

  it("returns the slid Mar 1 when from is earlier the same day", () => {
    assertDate(nextRunAt(feb29, at(2026, 3, 1, 8, 0)), at(2026, 3, 1, 9, 0));
  });

  it("advances to next year's Mar 1 when from is exactly at the slid time", () => {
    assertDate(nextRunAt(feb29, at(2026, 3, 1, 9, 0, 0, 0)), at(2027, 3, 1, 9, 0));
  });

  it("keeps Feb 29 in a leap year and slides again after it", () => {
    const leapExact = nextRunAt(feb29, at(2028, 2, 29, 9, 0, 0, 0));
    assertDate(leapExact, at(2029, 3, 1, 9, 0));
    assertDate(nextRunAt(feb29, at(2028, 1, 15, 0, 0)), at(2028, 2, 29, 9, 0));
  });

  it("clamps day 31 in a 30-day month", () => {
    const cadence: Cadence = { kind: "year", month: 4, day: 31, time: "09:00" };
    assertDate(nextRunAt(cadence, at(2026, 1, 1, 0, 0)), at(2026, 4, 30, 9, 0));
  });

  it("crosses to next year when this year's date has passed", () => {
    const cadence: Cadence = { kind: "year", month: 2, day: 23, time: "09:00" };
    assertDate(nextRunAt(cadence, at(2026, 11, 1, 0, 0)), at(2027, 2, 23, 9, 0));
    const nye: Cadence = { kind: "year", month: 12, day: 31, time: "23:59" };
    assertDate(nextRunAt(nye, at(2026, 12, 31, 23, 59, 0, 0)), at(2027, 12, 31, 23, 59));
  });
});

describe("describeCadence", () => {
  it("renders English summaries for each kind", () => {
    assert.equal(describeCadence({ kind: "minute", n: 5 }), "Every 5 minutes");
    assert.equal(describeCadence({ kind: "minute", n: 1 }), "Every minute");
    assert.equal(describeCadence({ kind: "hour", minute: 30 }), "Hourly at :30");
    assert.equal(describeCadence({ kind: "hour", minute: 5 }), "Hourly at :05");
    assert.equal(describeCadence({ kind: "day", time: "09:30" }), "Daily at 09:30");
    assert.equal(
      describeCadence({ kind: "week", weekdays: [1, 4], time: "09:30" }),
      "Weekly on Mon, Thu at 09:30",
    );
    assert.equal(describeCadence({ kind: "week", weekdays: [0], time: "09:30" }), "Weekly on Sun at 09:30");
    assert.equal(describeCadence({ kind: "month", day: 1, time: "09:00" }), "Monthly on day 1 at 09:00");
    assert.equal(
      describeCadence({ kind: "year", month: 2, day: 23, time: "09:00" }),
      "Yearly on Feb 23 at 09:00",
    );
  });
});
