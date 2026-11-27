import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cursorWindowOrigin, stepCursor } from "./cursorMotion.js";
import { parseTipsPageMessage } from "./overlayTypes.js";
import { spotFrame, tipClamp, tipCorner, tipOrigin } from "./tipLayout.js";

const visible = { x: 0, y: 25, width: 1440, height: 850 };
const card = { width: 340, height: 180 };

function close(actual: { x: number; y: number }, expected: { x: number; y: number }): void {
  assert.ok(Math.abs(actual.x - expected.x) < 0.01 && Math.abs(actual.y - expected.y) < 0.01, `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}

describe("tip layout", () => {
  it("matches the macOS helper placements", () => {
    close(tipOrigin(card, { x: 200, y: 300, width: 300, height: 60 }, visible), { x: 518, y: 261.6 });
    close(tipOrigin(card, { x: 1100, y: 300, width: 300, height: 60 }, visible), { x: 742, y: 261.6 });
    close(tipOrigin(card, { x: 100, y: 100, width: 1240, height: 60 }, visible), { x: 550, y: 178 });
    close(tipOrigin(card, { x: 10, y: 0, width: 1420, height: 840 }, visible), { x: 1086, y: 35 });
    close(tipOrigin(card, null, visible), { x: 1086, y: 35 });
    close(tipOrigin(card, { x: 1300, y: 760, width: 120, height: 40 }, visible), { x: 942, y: 683 });
  });

  it("keeps the card inside the work area", () => {
    close(tipClamp({ x: -500, y: 9_999 }, card, visible), { x: 12, y: 683 });
    close(tipCorner(card, visible), { x: 1086, y: 35 });
  });

  it("pads the spotlight around the anchor", () => {
    assert.deepEqual(spotFrame({ x: 100, y: 200, width: 50, height: 20 }), { x: 68, y: 168, width: 114, height: 84 });
  });
});

describe("cursor motion", () => {
  it("eases toward the target and snaps when close", () => {
    const step = stepCursor({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.016);
    assert.ok(step.x > 20 && step.x < 30);
    assert.deepEqual(stepCursor({ x: 99.9, y: 5 }, { x: 100, y: 5 }, 0.016), { x: 100, y: 5 });
    assert.deepEqual(stepCursor({ x: 0, y: 0 }, { x: 10, y: 10 }, 5), stepCursor({ x: 0, y: 0 }, { x: 10, y: 10 }, 0.1));
  });

  it("places the window so the hotspot lands on the point", () => {
    assert.deepEqual(cursorWindowOrigin({ x: 500, y: 300 }), { x: 460, y: 266 });
  });
});

describe("tips page messages", () => {
  it("accepts the page protocol and rejects junk", () => {
    assert.deepEqual(parseTipsPageMessage({ type: "size", w: 352, h: 160, pad: 26, mode: "card", id: "t1" }), {
      type: "size",
      w: 352,
      h: 160,
      pad: 26,
      mode: "card",
      id: "t1",
    });
    assert.deepEqual(parseTipsPageMessage({ type: "answer", id: "t1", action: "secondary", choice: null }), {
      type: "answer",
      id: "t1",
      action: "secondary",
      choice: null,
    });
    assert.deepEqual(parseTipsPageMessage({ type: "hidden", id: null }), { type: "hidden", id: null });
    assert.equal(parseTipsPageMessage({ type: "size", w: "1" }), null);
    assert.equal(parseTipsPageMessage("size"), null);
    assert.equal(parseTipsPageMessage({ type: "eval" }), null);
  });
});
