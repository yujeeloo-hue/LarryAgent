import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { upcomingScheduledRuns } from "./upcomingSchedule.js";
import type { CocoRule } from "./types.js";

const at = (h: number, m = 0, day = 29): number => new Date(2026, 9, day, h, m).getTime();
const rule = (patch: Partial<CocoRule>): CocoRule => ({ id: "r", name: "Rule", objective: "", mode: "fixed", scope: { all: true, workspaceIds: [], excludedWorkspaceIds: [] }, enabled: true, confirmed: true, fullPermissions: true, providerId: "", cadence: { kind: "day", time: "18:00" }, events: [], acceptance: [], nextRunAt: at(18), createdAt: 0, ...patch });

describe("upcomingScheduledRuns", () => {
  it("lists only enabled, confirmed rules due within the next 12 hours, soonest first", () => {
    const runs = upcomingScheduledRuns([
      rule({ id: "evening" }),
      rule({ id: "noon", cadence: { kind: "day", time: "12:00" }, nextRunAt: at(12) }),
      rule({ id: "late", cadence: { kind: "day", time: "22:00" }, nextRunAt: at(22) }),
      rule({ id: "tomorrow", nextRunAt: at(18) + 86_400_000 }),
      rule({ id: "paused", enabled: false }),
      rule({ id: "draft", confirmed: false }),
      rule({ id: "unscheduled", nextRunAt: 0 }),
    ], at(9));
    assert.deepEqual(runs.map(r => [r.ruleId, r.runsInWindow]), [["noon", 1], ["evening", 1]]);
  });

  it("looks past midnight", () => {
    const runs = upcomingScheduledRuns([
      rule({ id: "morning", cadence: { kind: "day", time: "06:00" }, nextRunAt: at(6, 0, 30) }),
      rule({ id: "noon", cadence: { kind: "day", time: "12:00" }, nextRunAt: at(12, 0, 30) }),
    ], at(21));
    assert.deepEqual(runs.map(r => r.ruleId), ["morning"]);
  });

  it("counts repeated runs in the window and marks overdue rules as due now", () => {
    const [hourly] = upcomingScheduledRuns([rule({ cadence: { kind: "hour", minute: 0 }, nextRunAt: at(22) })], at(21, 30));
    assert.equal(hourly!.runsInWindow, 12);
    const [overdue] = upcomingScheduledRuns([rule({ cadence: { kind: "minute", n: 30 }, nextRunAt: at(23) })], at(23, 10));
    assert.equal(overdue!.due, true);
    assert.equal(overdue!.at, at(23));
    assert.equal(overdue!.runsInWindow, 24);
  });
});
