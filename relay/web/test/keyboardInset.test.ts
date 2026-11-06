import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { installKeyboardInset } from "../src/keyboardInset.js";

/** Deterministic frame/timer ordering; these are viewport simulations, not
 * an emulation of iPhone Safari's native keyboard or automatic scrolling. */
function browser(t: TestContext, alreadyFocused = false) {
  let now = 0;
  let nextId = 0;
  let frames = 0;
  const pending = new Map<number, { time: number; callback: () => void }>();
  const later = (callback: () => void, delay: number) => {
    const id = ++nextId;
    pending.set(id, { time: now + delay, callback });
    return id;
  };
  const tick = (duration: number) => {
    const end = now + duration;
    for (;;) {
      const due = [...pending].filter(([, job]) => job.time <= end)
        .sort((a, b) => a[1].time - b[1].time || a[0] - b[0])[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].time;
      due[1].callback();
    }
    now = end;
  };
  const properties = new Map<string, string>();
  const root = {
    clientHeight: 844,
    clientWidth: 390,
    scrollTop: 0,
    scrollLeft: 0,
    style: {
      setProperty: (key: string, value: string) => properties.set(key, value),
      removeProperty: (key: string) => properties.delete(key),
    },
  };
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  const media = Object.assign(new EventTarget(), { matches: true });
  type Focus = { tagName: string; type: string; disabled: boolean; readOnly: boolean; isContentEditable: boolean };
  const doc = Object.assign(new EventTarget(), {
    documentElement: root,
    activeElement: null as Focus | null,
  });
  if (alreadyFocused) {
    viewport.height = 500;
    doc.activeElement = { tagName: "TEXTAREA", type: "text", disabled: false, readOnly: false, isContentEditable: false };
  }
  const win = Object.assign(new EventTarget(), {
    visualViewport: viewport,
    innerHeight: 844,
    innerWidth: 390,
    scrollX: 0,
    scrollY: 0,
    scrollTo: () => {
      win.scrollX = win.scrollY = root.scrollTop = root.scrollLeft = 0;
      viewport.offsetTop = 0;
    },
    matchMedia: () => media,
    requestAnimationFrame: (callback: () => void) => later(() => { frames++; callback(); }, 16),
    cancelAnimationFrame: (id: number) => pending.delete(id),
    setTimeout: later,
    clearTimeout: (id: number) => pending.delete(id),
  });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window: win, document: doc });
  const dispose = installKeyboardInset();
  t.after(() => {
    dispose();
    Object.assign(globalThis, previous);
  });
  return {
    root, viewport, media, doc, win, tick, dispose,
    inset: () => properties.get("--kb-inset") ?? "",
    pending: () => pending.size,
    frames: () => frames,
    focus(tagName = "TEXTAREA", type = "text") {
      doc.activeElement = { tagName, type, disabled: false, readOnly: false, isContentEditable: false };
      doc.dispatchEvent(new Event("focusin"));
    },
    blur() {
      doc.activeElement = null;
      doc.dispatchEvent(new Event("focusout"));
    },
  };
}

test("mobile pane consumes keyboard overlap at its bottom, without a second layout animation", () => {
  const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
  const rule = css.match(/\.main\s*\{[^}]*bottom:\s*var\(--kb-inset,\s*0px\);[^}]*\}/)?.[0];
  assert.ok(rule, "bottom-anchored composer must move with the pane's bottom edge");
  assert.doesNotMatch(rule, /top:\s*var\(--kb-inset|transition:\s*(top|bottom)/);
});

test("Safari offsetTop arrives after keyboard resize; CSS layout height wins over early innerHeight", (t) => {
  const b = browser(t);
  b.focus();
  b.tick(16);
  assert.equal(b.inset(), "");
  b.viewport.height = 500;
  b.win.innerHeight = 500;
  b.viewport.dispatchEvent(new Event("resize"));
  b.tick(16);
  assert.equal(b.inset(), "344px");
  b.viewport.offsetTop = 85;
  b.viewport.dispatchEvent(new Event("scroll"));
  b.tick(16);
  assert.equal(b.inset(), "259px");
});

test("focus settle samples catch late keyboard geometry and auto-pan without another viewport event", (t) => {
  const b = browser(t);
  b.focus();
  b.tick(16);
  b.viewport.height = 500;
  b.tick(80);
  assert.equal(b.inset(), "344px");
  b.tick(220);
  b.viewport.offsetTop = 70;
  b.tick(100);
  assert.equal(b.inset(), "274px");
  b.tick(1000);
  assert.equal(b.pending(), 0, "settle sampling stops instead of polling forever");
  assert.equal(b.frames(), 5);
});

test("switching focused fields with an already-open keyboard preserves the unobstructed baseline", (t) => {
  const b = browser(t);
  b.focus();
  b.viewport.height = 500;
  b.viewport.offsetTop = 60;
  b.tick(16);
  assert.equal(b.inset(), "284px");
  b.blur();
  b.tick(16);
  assert.equal(b.inset(), "284px", "transient blur cannot drop the composer under the open keyboard");
  // Refocus before Safari has closed (or resized) the existing keyboard.
  b.focus("INPUT");
  b.tick(16);
  assert.equal(b.inset(), "284px");
  b.blur();
  b.focus();
  b.tick(16);
  assert.equal(b.inset(), "284px");
});

test("installing on an already-focused Safari restore handles an already-short viewport", (t) => {
  const b = browser(t, true);
  assert.equal(b.inset(), "344px");
  b.viewport.offsetTop = 100;
  b.win.dispatchEvent(new Event("pageshow"));
  b.tick(16);
  assert.equal(b.inset(), "244px");
  b.viewport.height = 844;
  b.viewport.offsetTop = 0;
  b.viewport.dispatchEvent(new Event("resize"));
  b.tick(16);
  assert.equal(b.inset(), "");
});

test("closing with focus retained, reopening, and returning from the background refresh the inset", (t) => {
  const b = browser(t);
  b.focus();
  b.viewport.height = 500;
  b.tick(16);
  assert.equal(b.inset(), "344px");
  b.viewport.height = 844;
  b.viewport.dispatchEvent(new Event("resize"));
  b.tick(16);
  assert.equal(b.inset(), "");
  b.viewport.height = 500;
  b.viewport.dispatchEvent(new Event("resize"));
  b.tick(16);
  assert.equal(b.inset(), "344px");
  b.viewport.offsetTop = 90;
  b.win.dispatchEvent(new Event("pageshow"));
  b.tick(16);
  assert.equal(b.inset(), "254px");
  b.viewport.offsetTop = 50;
  b.doc.dispatchEvent(new Event("visibilitychange"));
  b.tick(16);
  assert.equal(b.inset(), "294px");
});

test("Android layout resizing does not get a second keyboard offset, including out-of-order events", (t) => {
  const b = browser(t);
  b.focus();
  b.viewport.height = 500;
  b.viewport.dispatchEvent(new Event("resize"));
  b.tick(16);
  assert.equal(b.inset(), "344px");
  b.root.clientHeight = 500;
  b.win.innerHeight = 500;
  b.win.dispatchEvent(new Event("resize"));
  b.tick(16);
  assert.equal(b.inset(), "");
  b.viewport.dispatchEvent(new Event("scroll"));
  b.tick(1000);
  assert.equal(b.inset(), "");
});

test("blur and browser chrome cannot leave a permanent keyboard inset", (t) => {
  const b = browser(t);
  b.viewport.height = 760;
  b.viewport.dispatchEvent(new Event("resize"));
  b.tick(16);
  assert.equal(b.inset(), "");
  b.focus();
  b.tick(16);
  assert.equal(b.inset(), "", "toolbar-only loss is not a keyboard");
  b.viewport.height = 500;
  b.viewport.dispatchEvent(new Event("resize"));
  b.tick(16);
  assert.equal(b.inset(), "344px");
  b.blur();
  b.viewport.dispatchEvent(new Event("resize"));
  b.tick(16);
  assert.equal(b.inset(), "344px", "blur arrives before the keyboard closing animation");
  b.viewport.height = 780;
  b.viewport.dispatchEvent(new Event("resize"));
  b.tick(1000);
  assert.equal(b.inset(), "", "late closing events cannot restore the inset after blur");
});

test("rotation, pinch zoom and leaving the mobile layout clear stale values", (t) => {
  const b = browser(t);
  b.focus();
  b.viewport.height = 500;
  b.tick(16);
  b.root.clientWidth = 740;
  b.root.clientHeight = 390;
  b.viewport.height = 230;
  b.viewport.offsetTop = 10;
  b.win.dispatchEvent(new Event("orientationchange"));
  b.tick(16);
  assert.equal(b.inset(), "150px");
  b.viewport.height = 390;
  b.viewport.offsetTop = 0;
  b.viewport.dispatchEvent(new Event("resize"));
  b.tick(16);
  assert.equal(b.inset(), "");
  b.viewport.height = 230;
  b.viewport.dispatchEvent(new Event("resize"));
  b.tick(16);
  assert.equal(b.inset(), "160px");
  b.viewport.scale = 1.2;
  b.viewport.dispatchEvent(new Event("resize"));
  b.tick(16);
  assert.equal(b.inset(), "");
  b.viewport.scale = 1;
  b.viewport.dispatchEvent(new Event("resize"));
  b.tick(16);
  assert.equal(b.inset(), "160px");
  b.media.matches = false;
  b.media.dispatchEvent(new Event("change"));
  b.tick(1000);
  assert.equal(b.inset(), "");
});

test("non-editable focus and disposal cannot publish or resurrect an inset", (t) => {
  const b = browser(t);
  b.focus("INPUT", "checkbox");
  b.viewport.height = 500;
  b.tick(16);
  assert.equal(b.inset(), "");
  b.focus();
  b.tick(16);
  assert.equal(b.inset(), "344px");
  b.dispose();
  assert.equal(b.pending(), 0);
  assert.equal(b.inset(), "");
  b.viewport.dispatchEvent(new Event("resize"));
  b.doc.dispatchEvent(new Event("focusin"));
  b.tick(1000);
  assert.equal(b.inset(), "");
  assert.equal(b.pending(), 0);
});

test("landscape desktop breakpoint → portrait recovers document origin after late Safari scroll", (t) => {
  const b = browser(t);
  b.media.matches = false;
  b.root.clientWidth = 844;
  b.root.clientHeight = b.viewport.height = 390;
  b.win.dispatchEvent(new Event("orientationchange"));
  b.tick(16);
  b.media.matches = true;
  b.root.clientWidth = 390;
  b.root.clientHeight = b.viewport.height = 844;
  b.win.scrollY = b.root.scrollTop = 160;
  b.viewport.offsetTop = 24;
  b.win.dispatchEvent(new Event("orientationchange"));
  b.tick(16);
  assert.equal(b.win.scrollY, 0);
  assert.equal(b.root.scrollTop, 0);
  assert.equal(b.viewport.offsetTop, 0);
  assert.equal(b.inset(), "");
  // Safari can apply an old pan after the first post-rotation frame.
  b.win.scrollY = 90;
  b.tick(200);
  assert.equal(b.win.scrollY, 0);
  b.tick(1000);
  assert.equal(b.pending(), 0);
});

test("viewport recovery preserves keyboard auto-pan and pinch zoom, then recovers after close", (t) => {
  const b = browser(t);
  b.focus();
  b.viewport.height = 500;
  b.viewport.offsetTop = 70;
  b.win.scrollY = 90;
  b.tick(16);
  assert.equal(b.win.scrollY, 90);
  assert.equal(b.viewport.offsetTop, 70);
  assert.equal(b.inset(), "274px");
  b.viewport.height = 844;
  b.viewport.scale = 1.2;
  b.viewport.dispatchEvent(new Event("resize"));
  b.tick(16);
  assert.equal(b.win.scrollY, 90);
  b.viewport.scale = 1;
  b.blur();
  b.tick(16);
  assert.equal(b.win.scrollY, 0);
  assert.equal(b.viewport.offsetTop, 0);
  assert.equal(b.inset(), "");
});

test("wide landscape also clears stale document scroll, without an editable focus", (t) => {
  const b = browser(t);
  b.media.matches = false;
  b.root.clientWidth = 844;
  b.root.clientHeight = b.viewport.height = 390;
  b.win.scrollX = b.root.scrollLeft = 30;
  b.win.scrollY = 80;
  b.win.dispatchEvent(new Event("scroll"));
  b.tick(16);
  assert.equal(b.win.scrollX, 0);
  assert.equal(b.win.scrollY, 0);
  assert.equal(b.root.scrollLeft, 0);
  b.focus();
  b.root.clientWidth = 390;
  b.root.clientHeight = 844;
  b.media.matches = true;
  b.viewport.height = 500;
  b.win.dispatchEvent(new Event("orientationchange"));
  b.tick(16);
  assert.equal(b.inset(), "344px", "keyboard baseline must rebase across the desktop breakpoint");
});
