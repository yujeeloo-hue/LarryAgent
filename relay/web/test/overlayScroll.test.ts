import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";

const dom = parseHTML(
  '<!doctype html><html><body><div class="host"><div id="scroller"></div></div></body></html>',
);
Object.assign(globalThis, { document: dom.document, window: undefined });

const { computeThumbGeometry, initOverlayScrollbars, usesNativeScrollbar } = await import(
  "../src/overlayScroll.js"
);

function stubPointer(matches: boolean): void {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches }) } });
}

test("capsule length is proportional to the visible fraction", () => {
  const g = computeThumbGeometry(400, 4000, 0);
  assert.equal(g.length, 40);
  assert.equal(g.offset, 0);
});

test("offset tracks scroll position along the leftover travel", () => {
  const mid = computeThumbGeometry(400, 4000, 1800);
  assert.equal(mid.length, 40);
  assert.equal(mid.offset, 180);
  const bottom = computeThumbGeometry(400, 4000, 3600);
  assert.equal(bottom.offset, 360);
});

test("huge lists clamp the capsule to the minimum length", () => {
  const g = computeThumbGeometry(400, 6000, 3000);
  assert.equal(g.length, 28);
  assert.equal(g.offset, Math.round((3000 / 5600) * (400 - 28)));
});

test("barely-overflowing content keeps a long capsule", () => {
  const g = computeThumbGeometry(400, 440, 40);
  assert.equal(g.length, 364);
  assert.equal(g.offset, 36);
});

test("non-scrolling content yields a full-size zero-offset capsule", () => {
  const g = computeThumbGeometry(400, 300, 0);
  assert.equal(g.length, 400);
  assert.equal(g.offset, 0);
});

test("out-of-range scroll positions are clamped", () => {
  assert.equal(computeThumbGeometry(400, 4000, 99999).offset, 360);
  assert.equal(computeThumbGeometry(400, 4000, -50).offset, 0);
});

test("only a coarse pointer falls back to the platform scrollbar", () => {
  assert.equal(usesNativeScrollbar({ matches: true }), true);
  assert.equal(usesNativeScrollbar({ matches: false }), false);
  assert.equal(usesNativeScrollbar(null), false);
  assert.equal(usesNativeScrollbar(undefined), false);
});

test("touch devices keep the platform scrollbar and get no overlay bar", () => {
  stubPointer(true);
  assert.equal(initOverlayScrollbars(), false);
  assert.equal(document.querySelectorAll(".ob-thumb").length, 0);
  assert.equal(document.querySelectorAll(".ob-native-hidden").length, 0);
  assert.equal(document.querySelectorAll(".ob-host").length, 0);
});

test("mouse devices still get the overlay scrollbar", () => {
  stubPointer(false);
  Object.assign(globalThis, {
    HTMLElement: dom.HTMLElement,
    Element: dom.Element,
    HTMLTextAreaElement: dom.HTMLTextAreaElement,
    HTMLInputElement: dom.HTMLInputElement,
    NodeFilter: { SHOW_ELEMENT: 1 },
    getComputedStyle: (node: Element) => ({
      overflowY: node.id === "scroller" ? "auto" : "visible",
      overflowX: "visible",
      position: "static",
    }),
    MutationObserver: class {
      observe(): void {}
      disconnect(): void {}
    },
  });
  const scroller = document.getElementById("scroller")!;
  assert.equal(initOverlayScrollbars(), true);
  assert.ok(scroller.classList.contains("ob-native-hidden"), "native bar hidden on mouse input");
  assert.ok(scroller.parentElement!.classList.contains("ob-host"));
  assert.equal(scroller.parentElement!.querySelectorAll(".ob-thumb").length, 2);
});
