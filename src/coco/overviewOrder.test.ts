import test from "node:test";
import assert from "node:assert/strict";
import { OVERVIEW_ORDER, NEW_REPORT_MS, isNewReport } from "./overviewOrder.js";

test("overview cards keep a fixed order: decisions first, recent runs last", () => {
  assert.equal(OVERVIEW_ORDER[0], "decide");
  assert.equal(OVERVIEW_ORDER.at(-1), "runs");
  assert.ok(OVERVIEW_ORDER.indexOf("flow") < OVERVIEW_ORDER.indexOf("runs"));
});

test("a report is new until seen and for at most one day", () => {
  const now = 10 * NEW_REPORT_MS;
  assert.equal(isNewReport(now - 1000, 0, now), true);
  assert.equal(isNewReport(now - 1000, now - 1000, now), false);
  assert.equal(isNewReport(now - NEW_REPORT_MS, 0, now), false);
});
