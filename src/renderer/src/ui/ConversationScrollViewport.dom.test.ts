import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { ConversationScrollViewport } from "./ConversationScrollViewport.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const observers: Array<{ callback: () => void; targets: Element[]; disconnected: boolean }> = [];
Object.assign(globalThis, {
  document: dom.document,
  ResizeObserver: class {
    state: typeof observers[number];
    constructor(callback: () => void) {
      this.state = { callback, targets: [], disconnected: false };
      observers.push(this.state);
    }
    observe(target: Element) { this.state.targets.push(target); }
    disconnect() { this.state.disconnected = true; }
  },
});

function mount() {
  const scroller = document.createElement("div");
  const content = document.createElement("div");
  const status = document.createElement("div");
  const overlay = document.createElement("div");
  scroller.append(content, status);
  document.body.append(scroller, overlay);
  let viewportHeight = 600;
  let overlayHeight = 150;
  let tail = 450;
  let statusTail = 0;
  let resizeCount = 0;
  const rect = (top: number, height: number) => ({ top, bottom: top + height, height }) as DOMRect;
  Object.defineProperties(scroller, {
    clientTop: { value: 0 },
    clientHeight: { get: () => viewportHeight },
    // Deliberately includes spare padding that must not count as unseen text.
    scrollHeight: { value: 1600 },
  });
  scroller.getBoundingClientRect = () => rect(100, viewportHeight);
  overlay.getBoundingClientRect = () => rect(100 + viewportHeight - overlayHeight, overlayHeight);
  content.getBoundingClientRect = () => rect(0, tail);
  status.getBoundingClientRect = () => rect(tail, statusTail > tail ? statusTail - tail : 0);
  const viewport = new ConversationScrollViewport(scroller, [content, status], overlay, () => resizeCount++);
  return {
    scroller, overlay, viewport,
    rect,
    tail: (bottom: number) => { tail = bottom; },
    statusTail: (bottom: number) => { statusTail = bottom; },
    resize: (footer: number, height = 600) => { overlayHeight = footer; viewportHeight = height; observers[0]!.callback(); },
    resizeCount: () => resizeCount,
  };
}

test.afterEach(() => {
  observers.length = 0;
  document.body.replaceChildren();
});

test("spare padding and paused follow do not show a button when the actual tail is visible", () => {
  const v = mount();
  v.tail(530); // visible viewport ends at 550, regardless of scrollHeight.
  assert.equal(v.viewport.shouldShowButton(false), false);
  v.viewport.destroy();
});

test("a 64px / 32px buffer prevents flicker without changing follow intent", () => {
  const v = mount();
  for (const [distance, shown] of [[64, false], [65, true], [50, true], [33, true], [32, false], [50, false]]) {
    v.tail(550 + Number(distance));
    assert.equal(v.viewport.shouldShowButton(false), shown, `distance ${distance}`);
  }
  v.viewport.destroy();
});

test("streaming follow hides the button even while its eased scroll is catching up", () => {
  const v = mount();
  v.tail(1500);
  assert.equal(v.viewport.shouldShowButton(false), true);
  assert.equal(v.viewport.shouldShowButton(true), false);
  v.viewport.destroy();
});

test("composer and queue growth update clearance and detect newly obscured content", () => {
  const v = mount();
  v.tail(520);
  v.resize(150);
  assert.equal(v.scroller.style.getPropertyValue("--conversation-composer-clearance"), "174px");
  assert.equal(v.viewport.shouldShowButton(false), false);
  v.resize(320);
  assert.equal(v.scroller.style.getPropertyValue("--conversation-composer-clearance"), "344px");
  assert.equal(v.viewport.shouldShowButton(false), true);
  v.resize(120);
  assert.equal(v.viewport.shouldShowButton(false), false);
  assert.equal(v.resizeCount(), 3);
  v.viewport.destroy();
});

test("keyboard / viewport resizing recomputes the visible bottom at the actual shell offset", () => {
  const v = mount();
  v.tail(520);
  assert.equal(v.viewport.shouldShowButton(false), false);
  v.resize(150, 350); // new visible bottom: 100 + 350 - 150 = 300.
  assert.equal(v.viewport.shouldShowButton(false), true);
  v.viewport.destroy();
});

test("a live status card after the transcript participates in the tail measurement", () => {
  const v = mount();
  v.tail(520);
  assert.equal(v.viewport.shouldShowButton(false), false);
  v.statusTail(700);
  assert.equal(v.viewport.shouldShowButton(false), true);
  v.viewport.destroy();
});

test("a row counts as visible only when the readable band fully holds it", () => {
  const v = mount(); // readable band: 100 … 550 (composer covers 550+).
  const row = document.createElement("div");
  document.body.append(row);
  const place = (top: number, height: number) => {
    row.getBoundingClientRect = () => v.rect(top, height);
  };

  place(400, 100); // 400 … 500
  assert.equal(v.viewport.isFullyVisible(row), true, "fully on screen");

  place(448, 100); // 448 … 548 — ends inside the 2px slack
  assert.equal(v.viewport.isFullyVisible(row), true, "rounding slack");

  place(500, 100); // 500 … 600 — bottom hides behind the composer
  assert.equal(v.viewport.isFullyVisible(row), false, "clipped by the composer");

  place(40, 120); // 40 … 160 — scrolled past its top
  assert.equal(v.viewport.isFullyVisible(row), false, "clipped above the fold");

  place(1500, 100); // below the viewport entirely
  assert.equal(v.viewport.isFullyVisible(row), false, "off screen below");

  place(300, 0); // unmeasurable / collapsed
  assert.equal(v.viewport.isFullyVisible(row), false, "zero-height row");

  place(400, 100);
  v.viewport.destroy();
  assert.equal(v.viewport.isFullyVisible(row), false, "disposed pane never reports visible");
  v.viewport.destroy();
});

test("hidden panes do not show a button and destroyed panes release both observations", () => {
  const v = mount();
  assert.deepEqual(observers[0]!.targets, [v.overlay, v.scroller]);
  v.tail(1500);
  v.resize(150, 0);
  assert.equal(v.viewport.shouldShowButton(false), false);
  v.viewport.destroy();
  assert.equal(observers[0]!.disconnected, true);
  const count = v.resizeCount();
  observers[0]!.callback();
  assert.equal(v.resizeCount(), count, "a queued resize cannot update a disposed conversation");
  assert.equal(v.viewport.shouldShowButton(false), false);
});
