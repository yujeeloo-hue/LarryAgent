import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import test from "node:test";
import { installPageFocusGuard } from "./pageFocusGuard.js";

const dom = parseHTML(
  `<!doctype html><html><body>
    <div id="pane">
      <textarea id="composer"></textarea>
      <button id="toggle" type="button">toggle</button>
      <input id="disabled" disabled />
      <div id="editable" contenteditable="true"></div>
    </div>
  </body></html>`,
);

let pageHasFocus = false;
const focused: string[] = [];
const reassertCalls: number[] = [];
let frames: Array<() => void> = [];

Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Element: dom.Element,
  Event: dom.window.Event,
  requestAnimationFrame: (callback: () => void) => {
    frames.push(callback);
    return frames.length;
  },
});

Object.defineProperty(dom.document, "hasFocus", {
  configurable: true,
  value: () => pageHasFocus,
});
Object.defineProperty(dom.document, "activeElement", {
  configurable: true,
  get: () => activeElement,
});

let activeElement: unknown = dom.document.body;
Object.defineProperty(dom.HTMLElement.prototype, "isConnected", {
  configurable: true,
  get(this: { parentNode?: unknown }) {
    return this.parentNode !== null && this.parentNode !== undefined;
  },
});
(dom.HTMLElement.prototype as unknown as {
  focus: (options?: { preventScroll?: boolean }) => void;
}).focus = function patchedFocus(this: { id?: string }) {
  focused.push(this.id ?? "");
  activeElement = this;
};
Object.defineProperty(dom.window, "jellybot", {
  configurable: true,
  value: {
    reassertWindowFocus: () => {
      reassertCalls.push(reassertCalls.length + 1);
      pageHasFocus = true;
      return Promise.resolve({ ok: true, refocused: true });
    },
  },
});

installPageFocusGuard();

function press(id: string, options: { preventDefault?: boolean } = {}) {
  const target = dom.document.getElementById(id);
  assert.ok(target, `missing #${id}`);
  if (options.preventDefault) {
    target.addEventListener("pointerdown", (event) => event.preventDefault(), {
      once: true,
    });
  }
  target.dispatchEvent(
    new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }),
  );
}

function flushFrame(): void {
  const pending = frames;
  frames = [];
  for (const callback of pending) callback();
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("When the page reports unfocused, clicking an input asks the main process to restore page focus and focus that input", async () => {
  pageHasFocus = false;
  activeElement = dom.document.body;
  focused.length = 0;
  reassertCalls.length = 0;

  press("composer");
  await settle();

  assert.equal(reassertCalls.length, 1, "Should request one window focus fix");
  assert.deepEqual(focused, ["composer"], "Focus should land on the just-clicked input");
});

test("When the page reports unfocused, clicking a non-input control fixes only window focus, not input focus", async () => {
  pageHasFocus = false;
  activeElement = dom.document.body;
  focused.length = 0;
  reassertCalls.length = 0;

  press("toggle");
  await settle();

  assert.equal(reassertCalls.length, 1);
  assert.deepEqual(focused, []);
});

test("Clicking an input while the page is focused requests no extra fix", async () => {
  pageHasFocus = true;
  activeElement = dom.document.body;
  focused.length = 0;
  reassertCalls.length = 0;

  press("composer");
  activeElement = dom.document.getElementById("composer"); // Simulate the default mousedown focus behavior
  flushFrame();
  await settle();

  assert.equal(reassertCalls.length, 0);
  assert.deepEqual(focused, [], "Should not focus again");
});

test("When the page is focused but the input did not receive focus, reassert it on the next frame", async () => {
  pageHasFocus = true;
  activeElement = dom.document.body;
  focused.length = 0;

  press("editable");
  flushFrame();
  await settle();

  assert.deepEqual(focused, ["editable"]);
});

test("A press with explicit preventDefault is not intercepted", async () => {
  pageHasFocus = true;
  activeElement = dom.document.body;
  focused.length = 0;

  press("composer", { preventDefault: true });
  flushFrame();
  await settle();

  assert.deepEqual(focused, [], "Should not interfere when a component deliberately prevents focus");
});

test("Disabled inputs are skipped by the focus fix", async () => {
  pageHasFocus = false;
  activeElement = dom.document.body;
  focused.length = 0;
  reassertCalls.length = 0;

  press("disabled");
  await settle();

  assert.equal(reassertCalls.length, 1, "Window focus still needs fixing");
  assert.deepEqual(focused, []);
});
