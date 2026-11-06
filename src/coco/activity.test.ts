import assert from "node:assert/strict";
import test from "node:test";
import { cocoActivity } from "./activity.js";
import type { CocoJob } from "./types.js";

const job = (kind: CocoJob["kind"]): CocoJob => ({ id: kind, kind, status: "running", at: 0, priority: 0 });
const base = { state: "idle" as const, work: [] };
test("idle, queued, cooldown and stopped work do not animate", () => {
  for (const state of ["idle", "cooldown", "paused", "blocked", "stopping"] as const) {
    assert.deepEqual(cocoActivity({ ...base, state }), { running: false, workRunning: false, chatRunning: false });
  }
  assert.equal(cocoActivity({ ...base, activeJob: { ...job("execute"), status: "queued" } }).running, false);
  assert.equal(cocoActivity({ ...base, state: "stopping", activeJob: job("execute") }).running, false);
  assert.equal(cocoActivity({ ...base, state: "cooldown", work: [{ status: "verifying" }] as Parameters<typeof cocoActivity>[0]["work"] }).running, false);
});
test("chat alone and work alone trigger their own icons and the navigation icon", () => {
  assert.deepEqual(cocoActivity({ ...base, chatJob: job("chat"), chat: { sessionId: "chat", status: "running" } }), { running: true, workRunning: false, chatRunning: true });
  assert.deepEqual(cocoActivity({ ...base, state: "working", executionJob: job("execute") }), { running: true, workRunning: true, chatRunning: false });
  assert.equal(cocoActivity({ ...base, state: "working", activeJob: job("inspect") }).workRunning, true);
});
test("waiting for user input stops chat animation while parallel work continues", () => {
  const chat = { sessionId: "chat", status: "running", question: { requestId: "question" } as NonNullable<Parameters<typeof cocoActivity>[0]["chat"]>["question"] };
  assert.deepEqual(cocoActivity({ ...base, chatJob: job("chat"), chat }), { running: false, workRunning: false, chatRunning: false });
  assert.deepEqual(cocoActivity({ ...base, state: "working", executionJob: job("execute"), chatJob: job("chat"), chat }), { running: true, workRunning: true, chatRunning: false });
  assert.equal(cocoActivity({ ...base, chatJob: job("chat"), chat: { sessionId: "chat", status: "error" } }).chatRunning, false);
  assert.equal(cocoActivity({ ...base, chatJob: job("chat"), chat: { sessionId: "chat", status: "completed" } }).chatRunning, false);
});
