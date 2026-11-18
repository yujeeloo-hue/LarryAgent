import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { StatusCarousel } from "./statusCarousel.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document: dom.document, window: dom.window });
let reduced = false;
Object.assign(dom.window, { matchMedia: () => ({ matches: reduced }) });

const prototype = dom.HTMLElement.prototype;
const previousAnimate = prototype.animate;
const previousRect = prototype.getBoundingClientRect;
const animations: Array<{ keyframes: unknown; options: unknown }> = [];
prototype.getBoundingClientRect = function () {
  const width = Array.from(this.textContent ?? "").length * 6;
  return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 16, width, height: 16, toJSON() {} };
};
prototype.animate = function (keyframes: unknown, options: unknown) {
  animations.push({ keyframes, options });
  return { finished: Promise.resolve(), cancel() {} } as unknown as Animation;
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const host = (): HTMLElement => {
  const element = document.createElement("span");
  document.body.append(element);
  return element;
};

test.after(() => {
  prototype.animate = previousAnimate;
  prototype.getBoundingClientRect = previousRect;
});

test("rotates through parts with the Thinking glyph roll and settles without leftover spans", async () => {
  const el = host();
  animations.length = 0;
  const carousel = new StatusCarousel(el, 40);
  try {
    carousel.setItems([{ key: "a", text: "alpha" }, { key: "b", text: "beta" }]);
    assert.equal(el.textContent, "alpha");
    await sleep(70);
    assert.equal(el.textContent, "beta");
    assert.equal(el.querySelectorAll(".status-carousel-glyph").length, 0);
    assert.equal(el.classList.contains("is-carousel-rolling"), false);
    assert.ok(
      animations.some(entry => JSON.stringify(entry.keyframes).includes("translateY(-13px)")),
      "outgoing glyphs move up like the Thinking title",
    );
    assert.ok(
      animations.some(entry => JSON.stringify(entry.keyframes).includes("translateY(13px)")),
      "incoming glyphs rise from below",
    );
  } finally {
    carousel.destroy();
    el.remove();
  }
});

test("hover pauses the rotation and leaving starts a fresh dwell", async () => {
  const el = host();
  const carousel = new StatusCarousel(el, 40);
  try {
    carousel.setItems([{ key: "a", text: "alpha" }, { key: "b", text: "beta" }]);
    carousel.setHovered(true);
    await sleep(100);
    assert.equal(el.textContent, "alpha", "hover freezes the current part");
    carousel.setHovered(false);
    await sleep(60);
    assert.equal(el.textContent, "beta");
  } finally {
    carousel.destroy();
    el.remove();
  }
});

test("a ticking clock updates the visible part without restarting the dwell timer", async () => {
  const el = host();
  animations.length = 0;
  const carousel = new StatusCarousel(el, 120);
  try {
    carousel.setItems([{ key: "a", text: "alpha 1s" }, { key: "b", text: "beta" }]);
    await sleep(40);
    carousel.setItems([{ key: "a", text: "alpha 2s" }, { key: "b", text: "beta" }]);
    assert.equal(el.textContent, "alpha 2s");
    assert.equal(animations.length, 0, "elapsed text changes silently");
    await sleep(100);
    assert.equal(el.textContent, "beta", "the timer still fires 120ms after the first render");
  } finally {
    carousel.destroy();
    el.remove();
  }
});

test("changing the part keys resets to the first item and reduced motion writes directly", async () => {
  const el = host();
  const carousel = new StatusCarousel(el, 40);
  try {
    carousel.setItems([{ key: "a", text: "alpha" }, { key: "b", text: "beta" }]);
    await sleep(70);
    assert.equal(el.textContent, "beta");
    carousel.setItems([{ key: "c", text: "gamma" }]);
    assert.equal(el.textContent, "gamma");
    await sleep(70);
    assert.equal(el.textContent, "gamma", "a single part never rotates");
    reduced = true;
    animations.length = 0;
    carousel.setItems([{ key: "c", text: "delta" }, { key: "d", text: "epsilon" }]);
    await sleep(70);
    assert.equal(el.textContent, "epsilon");
    assert.equal(animations.length, 0, "reduced motion skips all animations");
  } finally {
    carousel.destroy();
    el.remove();
    reduced = false;
  }
});
