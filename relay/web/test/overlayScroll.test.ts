/**
 * Unit tests for the overlay-scrollbar thumb geometry (pure maths, no DOM).
 * Ported from the JNote web solution this module derives from.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { computeThumbGeometry } = await import("../src/overlayScroll.js");

test("capsule length is proportional to the visible fraction", () => {
  // 400 of 4000 → 10% → 40px capsule.
  const g = computeThumbGeometry(400, 4000, 0);
  assert.equal(g.length, 40);
  assert.equal(g.offset, 0);
});

test("offset tracks scroll position along the leftover travel", () => {
  // maxScroll 3600, track travel 400-40=360 → mid scroll ≈ 180.
  const mid = computeThumbGeometry(400, 4000, 1800);
  assert.equal(mid.length, 40);
  assert.equal(mid.offset, 180);
  const bottom = computeThumbGeometry(400, 4000, 3600);
  assert.equal(bottom.offset, 360);
});

test("huge lists clamp the capsule to the minimum length", () => {
  // 400 of 6000 → raw 26.67 → clamped to 28.
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
