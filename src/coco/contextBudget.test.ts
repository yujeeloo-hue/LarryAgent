import assert from "node:assert/strict";
import { test } from "node:test";
import type { CocoBackgroundTask, CocoWork } from "./types.js";
import { BACKGROUND_SUMMARY_CHARS, OVERVIEW_WORK_LIMIT, RECENT_BACKGROUND_FAILURE_MS, TIMELINE_TEXT_CHARS, WAKE_BACKGROUND_LIMIT, clipTimeline, overviewWorks, wakeBackgroundTasks } from "./contextBudget.js";

const task = (i: number, status: CocoBackgroundTask["status"] = "completed"): CocoBackgroundTask => ({
  id: `t${i}`, sessionId: `s${i}`, purpose: "inspect", title: `Task ${i}`, status,
  startedAt: i, updatedAt: i, progress: "", summary: "s".repeat(2000),
});

const work = (i: number): CocoWork => ({
  id: `w${i}`, goalId: `g${i}`, title: `Work ${i}`, objective: "o".repeat(2000), workspaceId: "ws", status: "executing",
  priority: 50, dependsOn: [], steps: Array.from({ length: 20 }, (_, n) => `step ${n} ${"x".repeat(300)}`),
  acceptance: [], deliverables: [], ruleIds: [], revision: 1, repairs: 0, fullPermissions: false, providerId: "p",
  createdAt: i, updatedAt: i, summary: "y".repeat(3000), timeline: Array.from({ length: 30 }, (_, n) => ({ at: n, text: "z".repeat(2000) })),
});

test("wake background drops completed and stale failures; keeps running and recent failures", () => {
  const now = 10 * RECENT_BACKGROUND_FAILURE_MS;
  const at = (t: CocoBackgroundTask, updatedAt: number) => ({ ...t, updatedAt });
  const tasks = [
    ...Array.from({ length: 200 }, (_, i) => at(task(i), now - i)),
    at(task(-1, "running"), 0),
    at(task(-2, "error"), now - 60_000),
    at(task(-3, "interrupted"), now - RECENT_BACKGROUND_FAILURE_MS - 1),
  ];
  const { tasks: kept, omitted } = wakeBackgroundTasks(tasks, now);
  assert.deepEqual(kept.map(t => t.id), ["t-1", "t-2"]);
  assert.equal(omitted, 0);
  assert.ok(kept.every(t => t.summary.length <= BACKGROUND_SUMMARY_CHARS + 1));
});

test("wake background still caps many running tasks", () => {
  const tasks = Array.from({ length: 30 }, (_, i) => task(i, "running"));
  const { tasks: kept, omitted } = wakeBackgroundTasks(tasks, 0);
  assert.equal(kept.length, WAKE_BACKGROUND_LIMIT);
  assert.equal(omitted, 30 - WAKE_BACKGROUND_LIMIT);
});

test("timeline clipping bounds both entry count and entry text", () => {
  const clipped = clipTimeline(work(1).timeline, 3);
  assert.equal(clipped.length, 3);
  assert.ok(clipped.every(e => e.text.length <= TIMELINE_TEXT_CHARS + 1));
});

test("coco_context overview work projection stays small regardless of work size", () => {
  const { works, omitted } = overviewWorks(Array.from({ length: 100 }, (_, i) => work(i)));
  assert.equal(works.length, OVERVIEW_WORK_LIMIT);
  assert.equal(omitted, 100 - OVERVIEW_WORK_LIMIT);
  assert.equal(works.at(-1)!.id, "w99");
  assert.ok(JSON.stringify(works[0]).length < 4_000);
  assert.equal(works[0]!.stepsOmitted, 8);
});
