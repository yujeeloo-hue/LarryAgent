import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
});

const { cocoEntryState, deviceCocoReady } = await import("../src/render.js");

type Dev = Parameters<typeof cocoEntryState>[0][number];

function dev(id: string, opts: Partial<Dev> = {}): Dev {
  return {
    deviceId: id,
    name: id,
    platform: "darwin arm64",
    version: "1.6.2",
    online: true,
    firstSeen: 0,
    lastSeen: 0,
    blocked: false,
    caps: ["coco"],
    ...opts,
  } as Dev;
}

test("deviceCocoReady: online + coco cap, both required", () => {
  assert.equal(deviceCocoReady(dev("a")), true);
  assert.equal(deviceCocoReady(dev("a", { online: false })), false);
  assert.equal(deviceCocoReady(dev("a", { caps: ["maintenance"] })), false);
  assert.equal(deviceCocoReady(dev("a", { caps: undefined })), false);
});

test("no candidate → tile hidden (never a dead button)", () => {
  const state = cocoEntryState([dev("a", { caps: [] }), dev("b", { online: false })], "a");
  assert.deepEqual(state, { visible: false, direct: null, devices: [], busy: false, blocked: null });
  assert.equal(cocoEntryState([], null).visible, false);
});

test("selected device is a candidate → open it in one tap", () => {
  const state = cocoEntryState([dev("a"), dev("b")], "b");
  assert.equal(state.visible, true);
  assert.equal(state.direct, "b");
  assert.equal(state.blocked, null);
  assert.deepEqual(state.devices.map((d) => d.deviceId), ["a", "b"]);
});

test("selected device is NOT a candidate → never auto-open another device", () => {
  const single = cocoEntryState([dev("a", { caps: [] }), dev("b")], "a");
  assert.equal(single.visible, true);
  assert.equal(single.direct, null, "one candidate is not an excuse to skip the selection");
  assert.equal(single.blocked, "unsupported");
  assert.deepEqual(single.devices.map((d) => d.deviceId), ["b"], "the sheet offers it explicitly");

  const many = cocoEntryState([dev("a", { caps: [] }), dev("b"), dev("c")], "a");
  assert.equal(many.direct, null);
  assert.deepEqual(many.devices.map((d) => d.deviceId), ["b", "c"]);
});

test("blocked reason distinguishes offline / unsupported / no selection", () => {
  assert.equal(cocoEntryState([dev("a", { online: false }), dev("b")], "a").blocked, "offline");
  assert.equal(cocoEntryState([dev("a", { caps: ["maintenance"] }), dev("b")], "a").blocked, "unsupported");
  assert.equal(cocoEntryState([dev("a"), dev("b")], null).blocked, "none");
  const lonely = cocoEntryState([dev("a", { online: false, caps: ["coco"] })], "a");
  assert.equal(lonely.visible, false);
  assert.equal(lonely.blocked, null);
});

test("busy dot reflects any candidate with running sessions", () => {
  assert.equal(cocoEntryState([dev("a"), dev("b", { runningSessions: 0 })], "a").busy, false);
  assert.equal(cocoEntryState([dev("a", { runningSessions: 2 })], "a").busy, true);
  assert.equal(cocoEntryState([dev("a", { runningSessions: 2, online: false })], "a").busy, false);
});

test("the entry always names the device it opens (no anonymous jump)", () => {
  const ready = cocoEntryState([dev("a"), dev("b")], "a");
  assert.equal(ready.direct, "a");
  const offline = cocoEntryState([dev("a", { online: false }), dev("b")], "a");
  assert.equal(offline.direct, null);
  assert.equal(offline.blocked, "offline");
});
