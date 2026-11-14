import { nextRunAt } from "../loops/schedule.js";
import type { CocoRule } from "./types.js";

/** Look-ahead window for the Overview "Up next" list. */
export const UPCOMING_WINDOW_MS = 12 * 60 * 60 * 1000;

/** One enabled rule's runs within the look-ahead window. */
export type CocoScheduledRun = { ruleId: string; name: string; mode: CocoRule["mode"]; cadence: CocoRule["cadence"]; at: number; due: boolean; runsInWindow: number };

const MAX_RUNS_PER_WINDOW = 1440;

/** Enabled, confirmed rules whose next run falls within the next 12 hours (or is overdue), soonest first. */
export function upcomingScheduledRuns(rules: readonly CocoRule[], now: number): CocoScheduledRun[] {
  const end = now + UPCOMING_WINDOW_MS;
  const runs: CocoScheduledRun[] = [];
  for (const rule of rules) {
    if (!rule.enabled || !rule.confirmed || rule.draftOnly || !rule.nextRunAt || rule.nextRunAt >= end) continue;
    const due = rule.nextRunAt <= now;
    let cursor = due ? now : rule.nextRunAt, runsInWindow = 1;
    while (runsInWindow < MAX_RUNS_PER_WINDOW) {
      const next = nextRunAt(rule.cadence, new Date(cursor)).getTime();
      if (!(next > cursor) || next >= end) break;
      cursor = next; runsInWindow++;
    }
    runs.push({ ruleId: rule.id, name: rule.name, mode: rule.mode, cadence: rule.cadence, at: rule.nextRunAt, due, runsInWindow });
  }
  return runs.sort((a, b) => a.at - b.at);
}
