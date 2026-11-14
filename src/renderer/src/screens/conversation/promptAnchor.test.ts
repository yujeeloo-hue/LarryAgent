/**
 * Context-pill scroll anchor — pure geometry over user-row rects.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { computePromptAnchor } from "./promptAnchor.js";

/** Viewport [0, 600] unless stated. */
const vp = { top: 0, bottom: 600 };
const row = (top: number, height = 40) => ({
  top,
  bottom: top + height,
  height,
});

test("prompt on screen → visible (fold), anchor = that row", () => {
  const older = row(-800);
  const above = row(-200);
  const inView = row(50);
  assert.deepEqual(computePromptAnchor([older, above, inView], vp), {
    visible: true,
    anchorIndex: 2,
  });
});

test("several prompts on screen → anchor = bottom-most visible", () => {
  const a = row(0);
  const b = row(100);
  const c = row(3000);
  assert.deepEqual(computePromptAnchor([a, b, c], vp), {
    visible: true,
    anchorIndex: 1,
  });
});

test("scrolled into an older turn → expand with THAT prompt, not the latest", () => {
  const oldPrompt = row(-100); // prompt of the turn being read
  const latest = row(2000); // conversation's newest prompt, far below
  const anchor = computePromptAnchor([oldPrompt, latest], vp);
  assert.deepEqual(anchor, { visible: false, anchorIndex: 0 });
});

test("above the first prompt entirely → anchor = first row", () => {
  // First row clipped to 10/40px at the viewport bottom edge (under the
  // half threshold), nothing above it.
  const first = row(590);
  const second = row(1500);
  assert.deepEqual(computePromptAnchor([first, second], vp), {
    visible: false,
    anchorIndex: 0,
  });
});

test("half of the smaller side on screen counts as visible", () => {
  // 20px row, 10px overlap = exactly half → visible.
  assert.equal(
    computePromptAnchor([row(290, 20)], vp)?.visible,
    true,
  );
  // 40px row clipped to 5px at the edge → not visible.
  assert.equal(computePromptAnchor([row(595)], vp)?.visible, false);
});

test("no rows → null", () => {
  assert.equal(computePromptAnchor([], vp), null);
});
