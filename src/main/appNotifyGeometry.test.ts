/**
 * Popup geometry (appNotifyGeometry) — corner math, stacking, platform side.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeNotifyRect,
  notifySideForPlatform,
  POPUP_GAP,
  POPUP_HEIGHT,
  POPUP_MARGIN,
  POPUP_WIDTH,
} from "./appNotifyGeometry.js";

const WORK_AREA = { x: 0, y: 38, width: 1512, height: 945 };
const POPUP = { width: POPUP_WIDTH, height: POPUP_HEIGHT };

describe("computeNotifyRect", () => {
  it("top-right hugs the workArea corner with the margin", () => {
    const r = computeNotifyRect(WORK_AREA, "top-right", POPUP, 0);
    assert.equal(r.x, WORK_AREA.x + WORK_AREA.width - POPUP.width - POPUP_MARGIN);
    assert.equal(r.y, WORK_AREA.y + POPUP_MARGIN);
    assert.equal(r.width, POPUP.width);
    assert.equal(r.height, POPUP.height);
  });

  it("stacks downward on top-right (index 0 newest, closest to the bar)", () => {
    const r0 = computeNotifyRect(WORK_AREA, "top-right", POPUP, 0);
    const r1 = computeNotifyRect(WORK_AREA, "top-right", POPUP, 1);
    const r2 = computeNotifyRect(WORK_AREA, "top-right", POPUP, 2);
    assert.equal(r1.y - r0.y, POPUP.height + POPUP_GAP);
    assert.equal(r2.y - r1.y, POPUP.height + POPUP_GAP);
    assert.equal(r0.x, r1.x);
    assert.equal(r1.x, r2.x);
  });

  it("bottom-right hugs the taskbar edge and stacks upward", () => {
    const r0 = computeNotifyRect(WORK_AREA, "bottom-right", POPUP, 0);
    const r1 = computeNotifyRect(WORK_AREA, "bottom-right", POPUP, 1);
    assert.equal(
      r0.y + POPUP.height + POPUP_MARGIN,
      WORK_AREA.y + WORK_AREA.height,
    );
    assert.equal(r0.y - r1.y, POPUP.height + POPUP_GAP);
  });

  it("honors custom margin/gap overrides", () => {
    const r = computeNotifyRect(WORK_AREA, "top-right", POPUP, 1, {
      margin: 20,
      gap: 4,
    });
    assert.equal(r.x, WORK_AREA.x + WORK_AREA.width - POPUP.width - 20);
    assert.equal(r.y, WORK_AREA.y + 20 + (POPUP.height + 4));
  });

  it("rounds fractional workArea coordinates to whole pixels", () => {
    const r = computeNotifyRect(
      { x: 0.4, y: 37.6, width: 1511.5, height: 944.7 },
      "top-right",
      POPUP,
      0,
    );
    assert.ok(Number.isInteger(r.x));
    assert.ok(Number.isInteger(r.y));
  });
});

describe("notifySideForPlatform", () => {
  it("darwin pops below the menu bar (top-right)", () => {
    assert.equal(notifySideForPlatform("darwin"), "top-right");
  });

  it("win32 and linux rise above the taskbar (bottom-right)", () => {
    assert.equal(notifySideForPlatform("win32"), "bottom-right");
    assert.equal(notifySideForPlatform("linux"), "bottom-right");
  });
});
