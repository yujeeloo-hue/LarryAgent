import assert from "node:assert/strict";
import test from "node:test";
import { demoCardStateFor, restoreDemoDecision, submitDemoDecision, type DemoCardState, type DemoSubmitReceipt } from "./demoCardState.js";

function deferred() {
  let resolve!: (receipt: DemoSubmitReceipt) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<DemoSubmitReceipt>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("pending confirms reject duplicates across card rebuilds, then show a queue receipt", async () => {
  const states = new Map<string, DemoCardState>();
  const state = demoCardStateFor(states, "demo", null);
  state.values = { count: 7 };
  state.note = "keep this";
  const reply = deferred();
  let calls = 0;
  const send = () => { calls += 1; return reply.promise; };
  const pending = submitDemoDecision(state, { ...state.values }, state.note, send);
  assert.equal(state.status, "submitting");
  const rebuilt = demoCardStateFor(states, "demo", null);
  assert.equal(rebuilt, state);
  assert.equal(submitDemoDecision(rebuilt, { count: 1 }, undefined, send), pending);
  assert.equal(calls, 1);
  reply.resolve({ enqueued: true });
  await pending;
  assert.equal(state.status, "queued");
  assert.equal(state.submittedJson, '{"count":7}');
});

test("rejection unlocks the same draft for retry and never claims submission", async () => {
  const state: DemoCardState = { values: { count: 7 }, note: "preserve" };
  await submitDemoDecision(state, { ...state.values }, state.note, async () => { throw new Error("offline"); });
  assert.equal(state.status, undefined);
  assert.equal(state.error, "offline");
  assert.equal(state.submittedJson, undefined);
  assert.deepEqual(state.values, { count: 7 });
  assert.equal(state.note, "preserve");
  await submitDemoDecision(state, { ...state.values }, state.note, async () => ({ enqueued: false }));
  assert.equal(state.status, "submitted");
  assert.equal(state.error, undefined);
});

test("a stale snapshot after acknowledgement cannot reopen Confirm", async () => {
  const states = new Map<string, DemoCardState>();
  const state = demoCardStateFor(states, "demo", null);
  await submitDemoDecision(state, { count: 7 }, undefined, async () => ({ enqueued: false }));
  assert.equal(demoCardStateFor(states, "demo", null).status, "submitted");
  assert.equal(demoCardStateFor(states, "demo", { paramsJson: '{"count":7}' }).status, "submitted");
});

test("restoring a decision populates all parameter types and the optional note", () => {
  const state: DemoCardState = { values: { n: 1 }, note: "old" };
  restoreDemoDecision(state, { paramsJson: '{"n":7,"title":"Saved","enabled":false,"empty":null}', note: "chosen", enqueued: true });
  assert.deepEqual(state.values, { n: 7, title: "Saved", enabled: false, empty: null });
  assert.equal(state.note, "chosen");
  assert.equal(state.status, "queued");
});

test("removing a queued decision unlocks the preserved values on the next snapshot", () => {
  const states = new Map<string, DemoCardState>();
  const first = demoCardStateFor(states, "demo", { paramsJson: '{"count":7}', note: "keep", enqueued: true });
  const next = demoCardStateFor(states, "demo", null);
  assert.equal(next, first);
  assert.equal(next.status, undefined);
  assert.deepEqual(next.values, { count: 7 });
  assert.equal(next.note, "keep");
});

test("state is isolated per demo and callback throws remain retriable", () => {
  const states = new Map<string, DemoCardState>();
  const first = demoCardStateFor(states, "first", null);
  const second = demoCardStateFor(states, "second", null);
  submitDemoDecision(first, {}, undefined, () => { throw new Error("closed"); });
  assert.equal(first.error, "closed");
  assert.equal(first.status, undefined);
  assert.equal(second.error, undefined);
});
