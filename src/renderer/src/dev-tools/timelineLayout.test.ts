import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assignLanes,
  chooseRulerStep,
  computeTimeSpan,
  firstTickAtOrAfter,
  formatClock,
  formatDuration,
  formatRulerLabel,
  isTimelineRecordError,
  TIMELINE_TRACKS,
  trackOf,
} from "./timelineLayout.js";

const T0 = 1_700_000_000_000;

function rec(
  id: string,
  startedAt: number,
  endedAt: number | null,
): { id: string; startedAt: number; endedAt: number | null } {
  return { id, startedAt, endedAt };
}

describe("timeline layout", () => {
  it("assigns records to fixed tracks by kind and purpose", () => {
    assert.equal(TIMELINE_TRACKS.map((t) => t.id).join(","), "user,llm,tools,aux");
    assert.equal(
      trackOf({ id: "u", kind: "user", startedAt: 0, endedAt: 0 }),
      "user",
    );
    assert.equal(
      trackOf({ id: "t", kind: "tool", startedAt: 0, endedAt: 0 }),
      "tools",
    );
    assert.equal(
      trackOf({ id: "c", kind: "llm", purpose: "chat", startedAt: 0, endedAt: 0 }),
      "llm",
    );
    assert.equal(
      trackOf({ id: "n", kind: "llm", startedAt: 0, endedAt: 0 }),
      "llm",
    );
    for (const purpose of ["session_title", "compact-iteration-protect", "user_memory_extract"]) {
      assert.equal(
        trackOf({ id: "a", kind: "llm", purpose, startedAt: 0, endedAt: 0 }),
        "aux",
        `purpose ${purpose} should map to aux`,
      );
    }
  });

  it("flags tool failures for error bar styling", () => {
    assert.equal(
      isTimelineRecordError({
        id: "t",
        kind: "tool",
        startedAt: 0,
        endedAt: 1,
        returnCode: 1,
        status: "error",
      }),
      true,
    );
    assert.equal(
      isTimelineRecordError({
        id: "t",
        kind: "tool",
        startedAt: 0,
        endedAt: 1,
        returnCode: 0,
        status: "success",
      }),
      false,
    );
    assert.equal(
      isTimelineRecordError({
        id: "t",
        kind: "tool",
        startedAt: 0,
        endedAt: 1,
        returnCode: 6,
        status: "cancelled",
      }),
      false,
    );
  });

  it("assigns sequential records to one lane", () => {
    const { bars, laneCount } = assignLanes(
      [rec("a", T0, T0 + 100), rec("b", T0 + 200, T0 + 300)],
      T0 + 1_000,
    );
    assert.equal(laneCount, 1);
    assert.equal(bars.length, 2);
    assert.deepEqual(
      bars.map((bar) => bar.lane),
      [0, 0],
    );
  });

  it("stacks overlapping records onto separate lanes", () => {
    const { bars, laneCount } = assignLanes(
      [
        rec("a", T0, T0 + 500),
        rec("b", T0 + 100, T0 + 400),
        rec("c", T0 + 200, T0 + 900),
        rec("d", T0 + 600, T0 + 700),
      ],
      T0 + 1_000,
    );
    // a: lane0; b overlaps a → lane1; c overlaps both → lane2; d starts after
    // lane0 ends (500 ≤ 600) → back to lane0.
    assert.equal(laneCount, 3);
    assert.deepEqual(
      bars.map((bar) => [bar.record.id, bar.lane]),
      [
        ["a", 0],
        ["b", 1],
        ["c", 2],
        ["d", 0],
      ],
    );
  });

  it("lets touching intervals share a lane and extends in-flight to now", () => {
    const now = T0 + 2_000;
    const { bars, laneCount } = assignLanes(
      [rec("a", T0, T0 + 100), rec("b", T0 + 100, null)],
      now,
    );
    assert.equal(laneCount, 1);
    const inflight = bars.find((bar) => bar.record.id === "b");
    assert.ok(inflight);
    assert.equal(inflight.end, now);
  });

  it("keeps a positive-width span for zero-duration records", () => {
    const now = T0 + 3_000;
    const { bars } = assignLanes([rec("a", now, null)], now);
    const bar = bars[0];
    assert.ok(bar);
    assert.ok(bar.end >= bar.start);
  });

  it("chooses ruler steps by tick pixel distance", () => {
    assert.equal(chooseRulerStep(10_000, 1_000), 1_000);
    assert.equal(chooseRulerStep(60_000, 1_000), 5_000);
    assert.equal(chooseRulerStep(600_000, 1_000), 60_000);
    // Degenerate inputs fall back to the largest step.
    assert.equal(chooseRulerStep(0, 1_000), 86_400_000);
    assert.ok(chooseRulerStep(60_000, 10) >= 60_000);
  });

  it("snaps the first tick to the step grid", () => {
    assert.equal(firstTickAtOrAfter(T0 - 40, 100), T0);
    assert.equal(firstTickAtOrAfter(T0, 100), T0);
    assert.equal(firstTickAtOrAfter(T0 + 1, 100), T0 + 100);
  });

  it("computes the record span with in-flight now and a minimum span", () => {
    assert.equal(computeTimeSpan([], T0), null);
    const span = computeTimeSpan(
      [rec("a", T0, T0 + 100), rec("b", T0 + 200, null)],
      T0 + 5_000,
    );
    assert.ok(span);
    assert.equal(span.start, T0);
    assert.equal(span.end, T0 + 5_000);
    const tiny = computeTimeSpan([rec("a", T0, T0 + 10)], T0 + 20);
    assert.ok(tiny);
    assert.equal(tiny.end - tiny.start, 1_000);
  });

  it("formats durations and clocks compactly", () => {
    assert.equal(formatDuration(830), "830ms");
    assert.equal(formatDuration(12_400), "12.4s");
    assert.equal(formatDuration(125_000), "2m05s");
    assert.equal(formatDuration(3_780_000), "1h03m");
    const d = new Date(T0);
    assert.equal(
      formatClock(T0),
      [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map((n) => String(n).padStart(2, "0"))
        .join(":"),
    );
  });

  it("formats ruler labels relative to zero", () => {
    const zero = new Date(2_024, 0, 1, 3, 7, 5).getTime();
    assert.equal(formatRulerLabel(zero + 7_000, 1_000, zero), "0:07");
    assert.equal(formatRulerLabel(zero + 187_000, 60_000, zero), "3:07");
    assert.equal(formatRulerLabel(zero + 62 * 60_000, 3_600_000, zero), "62:00");
    assert.equal(formatRulerLabel(zero + 400, 500, zero), "0.4s");
    assert.equal(formatRulerLabel(zero - 400, 500, zero), "-0.4s");
  });

  it("caps in-flight span extension at maxInFlightMs", () => {
    const start = T0;
    const now = T0 + 3_600_000; // an hour later
    // Default 10-min cap: a stuck in-flight record must not stretch the axis to now.
    const capped = computeTimeSpan([rec("a", start, null)], now);
    assert.ok(capped);
    assert.equal(capped.end, start + 600_000);
    // Young in-flight still extends to now.
    const young = computeTimeSpan([rec("b", now - 1_000, null)], now);
    assert.ok(young);
    assert.equal(young.end, now);
    // assignLanes applies the same cap to the bar end.
    const { bars } = assignLanes([rec("c", start, null)], now);
    const bar = bars[0];
    assert.ok(bar);
    assert.equal(bar.end, start + 600_000);
    // Sealed records are never capped.
    const sealed = computeTimeSpan([rec("d", start, start + 3_600_000)], now);
    assert.ok(sealed);
    assert.equal(sealed.end, start + 3_600_000);
  });
});
