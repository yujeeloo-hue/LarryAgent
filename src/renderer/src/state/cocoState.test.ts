import assert from "node:assert/strict";
import test from "node:test";
import { CocoState } from "./cocoState.js";
import type { CocoSnapshot } from "../../../coco/types.js";

const snapshot = (state: CocoSnapshot["state"]) => ({ state } as CocoSnapshot);
test("shared refresh coalesces callers and never overwrites a newer command result", async () => {
  let resolve!: (snapshot: CocoSnapshot) => void;
  let reads = 0;
  const state = new CocoState(() => { reads++; return new Promise(done => { resolve = done; }); });
  const seen: string[] = [];
  const unsubscribe = state.subscribe(s => seen.push(s.state));
  const first = state.refresh();
  assert.equal(first, state.refresh());
  state.publish(snapshot("working"));
  resolve(snapshot("idle"));
  await first;
  assert.equal(reads, 1);
  assert.deepEqual(seen, ["working"]);
  unsubscribe();
  state.publish(snapshot("idle"));
  assert.deepEqual(seen, ["working"]);
});
test("change pushes refresh only while subscribed; unobserved session updates do not read", async () => {
  let reads = 0, push: (() => void) | undefined;
  const state = new CocoState(async () => { reads++; return snapshot("idle"); }, handler => { push = handler; return () => { push = undefined; }; });
  state.refreshIfObserved();
  assert.equal(reads, 0);
  const unsubscribe = state.subscribe(() => {});
  await Promise.resolve(); await Promise.resolve();
  assert.equal(reads, 1);
  push?.();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(reads, 2);
  unsubscribe();
  assert.equal(push, undefined);
});
test("request failure rejects and a later refresh recovers", async () => {
  let fail = true;
  const state = new CocoState(async () => { if (fail) throw new Error("disconnected"); return snapshot("idle"); });
  await assert.rejects(state.refresh(), /disconnected/);
  fail = false;
  await state.refresh();
});
