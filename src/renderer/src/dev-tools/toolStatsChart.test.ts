import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildChartModel,
  buildDaySeries,
  chartTotals,
  dayKey,
  dayLabel,
  parseDay,
  revisionLabel,
} from "./toolStatsChart.js";

test("every recorded day appears, silent days in between included as gaps", () => {
  const series = buildDaySeries([
    { day: "2026-05-20", calls: 4, success: 3, failure: 1 },
    { day: "2026-05-23", calls: 2, success: 2, failure: 0 },
  ]);
  assert.deepEqual(
    series.map((point) => [point.day, point.label, point.calls, point.rate]),
    [
      ["2026-05-20", "05-20", 4, 0.75],
      ["2026-05-21", "05-21", 0, null],
      ["2026-05-22", "05-22", 0, null],
      ["2026-05-23", "05-23", 2, 1],
    ],
    "the range is contiguous from the oldest to the newest recorded day",
  );
});

test("a single day still produces one column instead of an empty axis", () => {
  const series = buildDaySeries([
    { day: "2026-03-01", calls: 5, success: 5, failure: 0 },
  ]);
  assert.equal(series.length, 1);
  assert.equal(series[0]!.rate, 1);
  assert.equal(series[0]!.label, "03-01");
});

test("duplicate days are summed and malformed or call-less rows dropped", () => {
  const series = buildDaySeries([
    { day: "2026-05-20", calls: 2, success: 2, failure: 0 },
    { day: "2026-05-20 ", calls: 3, success: 1, failure: 2 },
    { day: "not-a-day", calls: 9, success: 9, failure: 0 },
    { day: "2026-05-21", calls: 0, success: 0, failure: 0 },
  ]);
  assert.deepEqual(
    series.map((point) => [point.day, point.calls, point.success, point.failure]),
    [["2026-05-20", 5, 3, 2]],
    "column-less days never enter the range",
  );
  assert.equal(buildDaySeries([]).length, 0);
});

test("years and month boundaries roll over correctly", () => {
  const series = buildDaySeries([
    { day: "2025-12-31", calls: 1, success: 0, failure: 1 },
    { day: "2026-01-01", calls: 3, success: 3, failure: 0 },
  ]);
  assert.deepEqual(series.map((point) => point.day), ["2025-12-31", "2026-01-01"]);
  assert.deepEqual(series.map((point) => point.rate), [0, 1]);
});

test("day keys stay in local time (no UTC drift around midnight)", () => {
  const local = new Date(2026, 4, 20, 0, 5, 0);
  assert.equal(dayKey(local), "2026-05-20");
  assert.equal(dayLabel("2026-05-20"), "05-20");
  assert.equal(parseDay("2026-05-20")?.getDate(), 20);
  assert.equal(parseDay("2026-13-01"), null);
  assert.equal(parseDay("20-05-2026"), null);
});

test("totals drive the header meta line", () => {
  const series = buildDaySeries([
    { day: "2026-05-20", calls: 4, success: 3, failure: 1 },
    { day: "2026-05-21", calls: 6, success: 6, failure: 0 },
  ]);
  const totals = chartTotals(series);
  assert.equal(totals.calls, 10);
  assert.equal(totals.success, 9);
  assert.equal(totals.failure, 1);
  assert.equal(totals.rate, 0.9);
  assert.equal(chartTotals([]).rate, null);
});

test("each tool doc revision becomes its own curve over the shared day axis", () => {
  const model = buildChartModel([
    { day: "2026-05-20", revision: 0, calls: 4, success: 2, failure: 2 },
    { day: "2026-05-21", revision: 1, calls: 5, success: 5, failure: 0 },
    { day: "2026-05-21", revision: 0, calls: 2, success: 2, failure: 0 },
    { day: "2026-05-22", revision: 1, calls: 4, success: 1, failure: 3 },
  ]);
  assert.deepEqual(model.days, ["2026-05-20", "2026-05-21", "2026-05-22"]);
  assert.deepEqual(model.labels, ["05-20", "05-21", "05-22"]);
  assert.deepEqual(model.series.map((s) => s.label), ["r0", "r1"], "oldest revision first");
  const [r0, r1] = model.series;
  assert.deepEqual(
    r0!.points.map((p) => [p.day, p.calls, p.rate]),
    [["2026-05-20", 4, 0.5], ["2026-05-21", 2, 1], ["2026-05-22", 0, null]],
    "a revision that did not run keeps a gap, never a 0% point",
  );
  assert.deepEqual(
    r1!.points.map((p) => [p.day, p.calls, p.rate]),
    [["2026-05-20", 0, null], ["2026-05-21", 5, 1], ["2026-05-22", 4, 0.25]],
  );
  assert.equal(r0!.totals.calls, 6);
  assert.equal(r1!.totals.calls, 9);
  assert.equal(model.totals.calls, 15, "header totals sum every revision");
  assert.equal(model.totals.rate, 10 / 15);
});

test("revision labels and missing revisions collapse onto the r0 baseline", () => {
  assert.equal(revisionLabel(0), "r0");
  assert.equal(revisionLabel(3), "r3");
  assert.equal(revisionLabel(-2), "r0");
  assert.equal(revisionLabel(Number.NaN), "r0");
  const model = buildChartModel([
    { day: "2026-05-20", calls: 1, success: 1, failure: 0 },
    { day: "2026-05-20", revision: 0, calls: 1, success: 0, failure: 1 },
  ]);
  assert.deepEqual(model.series.map((s) => s.label), ["r0"]);
  assert.equal(model.series[0]!.points[0]!.calls, 2);
  assert.equal(model.series[0]!.points[0]!.rate, 0.5);
  assert.equal(
    buildDaySeries([{ day: "2026-05-20", revision: 0, calls: 2, success: 2, failure: 0 }]).length,
    1,
    "the single-curve helper still sums revisions",
  );
});

test("an empty range yields no curves at all", () => {
  const model = buildChartModel([]);
  assert.deepEqual(model.series, []);
  assert.deepEqual(model.days, []);
  assert.equal(model.totals.rate, null);
});
