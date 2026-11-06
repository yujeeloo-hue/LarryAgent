import assert from "node:assert/strict";
import { test } from "node:test";
import { abnormalInterruption, pausedForBudget, stoppedByUser } from "./status.js";

test("pausedForBudget is only coco_budget", () => {
  assert.equal(pausedForBudget(undefined), false);
  assert.equal(pausedForBudget({ state: "running" }), false);
  assert.equal(pausedForBudget({ state: "user_paused" }), false);
  assert.equal(pausedForBudget({ state: "user_stopped" }), false);
  assert.equal(pausedForBudget({ state: "coco_budget" }), true);
  assert.equal(pausedForBudget({ state: "completed", requestedStop: "coco_budget" }), true);
  assert.equal(pausedForBudget({ state: "running", requestedStop: "user_paused" }), false);
});

test("abnormalInterruption is a journal fact and ignores a still-active turn", () => {
  assert.equal(abnormalInterruption(undefined), false);
  assert.equal(abnormalInterruption({ state: "interrupted" }), true);
  assert.equal(abnormalInterruption({ state: "failed" }), true);
  assert.equal(abnormalInterruption({ state: "shutdown" }), true);
  assert.equal(abnormalInterruption({ state: "coco_stopped" }), true);
  assert.equal(abnormalInterruption({ state: "running" }), true);
  assert.equal(abnormalInterruption({ state: "running" }, true), false);
  assert.equal(abnormalInterruption({ state: "completed" }), false);
  assert.equal(abnormalInterruption({ state: "user_stopped" }), false);
  assert.equal(abnormalInterruption({ state: "coco_budget" }), false);
});

test("stoppedByUser stays distinct from budget soft-pause", () => {
  assert.equal(stoppedByUser({ state: "user_paused" }), true);
  assert.equal(stoppedByUser({ state: "user_stopped" }), true);
  assert.equal(stoppedByUser({ state: "running", requestedStop: "user_paused" }), true);
  assert.equal(stoppedByUser({ state: "coco_budget" }), false);
  assert.equal(stoppedByUser({ state: "completed", requestedStop: "coco_budget" }), false);
  assert.equal(stoppedByUser({ state: "coco_stopped" }), false);
});
