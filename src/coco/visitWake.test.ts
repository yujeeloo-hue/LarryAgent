import assert from "node:assert/strict";
import { test } from "node:test";
import type { CocoSnapshot, CocoWork } from "./types.js";
import { SMALL_TALK_INTERVAL, visitWake } from "./visitWake.js";

const now = Date.UTC(2026, 9, 28, 12);
const snapshot = (work: CocoWork[] = []): CocoSnapshot => ({ work, workspaces: [{ id: "project", name: "Project" }], pendingPlans: [], state: "idle", backgroundTasks: [], budget: { hourly: 0, daily: 0, estimated: false } } as unknown as CocoSnapshot);
const task = (): CocoWork => ({ id: "report", workspaceId: "project", status: "executing", revision: 1, summary: "Writing the report", updatedAt: now } as CocoWork);

test("idle small talk waits an hour after the last exchange, including ordinary chat", () => {
  const state = snapshot();
  const first = visitWake(state, undefined, 0, now); assert.equal(first.mode, "smalltalk");
  const previous = { fingerprint: first.fingerprint, spokenAt: now };
  assert.equal(visitWake(state, previous, now, now + 120000).mode, undefined);
  assert.equal(visitWake(state, previous, now, now + SMALL_TALK_INTERVAL - 1).mode, undefined);
  assert.equal(visitWake(state, previous, now, now + SMALL_TALK_INTERVAL).mode, "smalltalk");
  assert.equal(visitWake(state, previous, now + 3000000, now + SMALL_TALK_INTERVAL).mode, undefined);
});

test("unchanged running work stays quiet even after hours; actual progress speaks immediately", () => {
  const work = task(), state = snapshot([work]);
  const first = visitWake(state, undefined, now - 1000, now); assert.equal(first.mode, "progress");
  const previous = { fingerprint: first.fingerprint, spokenAt: now };
  state.work[0] = { ...work, updatedAt: now + 10000 };
  assert.equal(visitWake(state, previous, now, now + 2 * SMALL_TALK_INTERVAL).mode, undefined, "a timestamp is not new content");
  state.work[0] = { ...work, status: "verifying", summary: "Build passed; checking the result", updatedAt: now + 10000 };
  assert.equal(visitWake(state, previous, now, now + 10000).mode, "progress", "real changes do not wait for the small-talk cooldown");
});

test("polling, usage totals and background check lifecycles do not trigger greetings", () => {
  const state = snapshot([task()]);
  const previous = { fingerprint: visitWake(state, undefined, 0, now).fingerprint, spokenAt: now };
  state.state = "working"; state.budget.hourly += 10000;
  state.backgroundTasks = [{ id: "inspection", status: "running", progress: "Inspecting" } as any];
  assert.equal(visitWake(state, previous, now, now + 120000).mode, undefined);
  state.backgroundTasks = [];
  assert.equal(visitWake(state, previous, now, now + 240000).mode, undefined);
});

test("new planning states and user decisions count as progress, but existing ones do not repeat", () => {
  const state = snapshot();
  let previous = { fingerprint: visitWake(state, undefined, now, now).fingerprint, spokenAt: now };
  state.pendingPlans = [{ requestId: "plan", title: "Plan the report", status: "running" }];
  const update = visitWake(state, previous, now, now + 10000); assert.equal(update.mode, "progress");
  previous = { fingerprint: update.fingerprint, spokenAt: now + 10000 };
  assert.equal(visitWake(state, previous, now, now + 120000).mode, undefined);
  state.pendingPlans = []; state.chat = { sessionId: "chat", status: "idle", question: { requestId: "question" } as any };
  assert.equal(visitWake(state, previous, now, now + 130000).mode, "progress");
});

test("an initial visit does not repeat a state already covered by recent conversation", () => {
  const state = snapshot([task()]);
  assert.equal(visitWake(state, undefined, now + 1000, now + 120000).mode, undefined);
});
