import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { installStandaloneZoomLock } from "../src/standaloneZoom.js";

function browser(t: TestContext, legacy = false, standalone = false) {
  const classes = new Set<string>();
  const root = { classList: {
    toggle(name: string, on: boolean) { if (on) classes.add(name); else classes.delete(name); },
  } };
  const doc = Object.assign(new EventTarget(), { documentElement: root });
  const added: Array<{ type: string; options: boolean | AddEventListenerOptions | undefined }> = [];
  const add = doc.addEventListener.bind(doc);
  doc.addEventListener = (type, listener, options) => {
    added.push({ type, options });
    add(type, listener, options);
  };
  const media = Object.assign(new EventTarget(), { matches: standalone });
  const win = Object.assign(new EventTarget(), { matchMedia: () => media });
  const nav = { standalone: legacy };
  const originals = ["document", "window", "navigator"].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries({ document: doc, window: win, navigator: nav })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const dispose = installStandaloneZoomLock();
  t.after(() => {
    dispose();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const emit = (type: string, touches = 0, cancelable = true) => {
    const event = new Event(type, { cancelable });
    if (type.startsWith("touch")) Object.defineProperty(event, "touches", { value: Array(touches).fill({}) });
    doc.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { emit, media, nav, win, dispose, added, locked: () => classes.has("standalone-zoom-locked") };
}

test("ordinary browser tabs have no active touch interception", (t) => {
  const b = browser(t);
  assert.equal(b.locked(), false);
  assert.equal(b.added.length, 0);
  assert.equal(b.emit("gesturestart"), false);
  assert.equal(b.emit("touchmove", 2), false);
});

test("iOS Home Screen mode blocks pinch events while preserving single-finger scrolling", (t) => {
  const b = browser(t, true);
  assert.equal(b.locked(), true);
  for (const type of ["gesturestart", "gesturechange"]) assert.equal(b.emit(type), true, type);
  for (const type of ["touchstart", "touchmove"]) {
    assert.equal(b.emit(type, 1), false, `${type}: single-finger scrolling stays native`);
    assert.equal(b.emit(type, 2), true, `${type}: two-finger gesture is cancelled`);
  }
  assert.ok(b.added.every(({ options }) => typeof options === "object" && options.capture && options.passive === false),
    "document touch handlers must be explicitly non-passive for cancellation to work");
  assert.equal(b.emit("gesturechange", 0, false), false);
});

test("standalone display mode locks zoom without the legacy iOS flag", (t) => {
  const b = browser(t, false, true);
  assert.equal(b.locked(), true);
  assert.equal(b.emit("touchmove", 2), true);
  b.media.matches = false;
  b.media.dispatchEvent(new Event("change"));
  assert.equal(b.locked(), false);
  assert.equal(b.emit("touchmove", 2), false);
  b.media.matches = true;
  b.media.dispatchEvent(new Event("change"));
  assert.equal(b.emit("gesturestart"), true);
});

test("pageshow refreshes the Home Screen mode after page restoration", (t) => {
  const b = browser(t);
  b.nav.standalone = true;
  b.win.dispatchEvent(new Event("pageshow"));
  assert.equal(b.emit("gesturechange"), true);
  b.nav.standalone = false;
  b.win.dispatchEvent(new Event("pageshow"));
  assert.equal(b.emit("touchmove", 2), false);
});

test("disposal removes the mode class and all gesture handlers", (t) => {
  const b = browser(t, true);
  b.dispose();
  assert.equal(b.locked(), false);
  assert.equal(b.emit("gesturestart"), false);
  assert.equal(b.emit("touchmove", 2), false);
  b.win.dispatchEvent(new Event("pageshow"));
  b.media.dispatchEvent(new Event("change"));
  assert.equal(b.locked(), false);
});
