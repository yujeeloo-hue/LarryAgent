import test from "node:test";
import assert from "node:assert/strict";
import {
  HOVER_ANCHOR_MARGIN_PX,
  HOVER_PANEL_MARGIN_PX,
  isInsideInflated,
  nextHoverLeaveState,
} from "./usagePopupHover.js";

/** Panel: 320×175 anchored ~8px above the taskbar. */
const PANEL = { x: 2188, y: 1220, width: 320, height: 175 };
/** Tray icon: taskbar row, a taskbar-height below the panel bottom. */
const ICON = { x: 2320, y: 1412, width: 24, height: 24 };
const NEAR = [
  { bounds: PANEL, margin: HOVER_PANEL_MARGIN_PX },
  { bounds: ICON, margin: HOVER_ANCHOR_MARGIN_PX },
];

test("isInsideInflated covers the rect plus margin on all sides", () => {
  assert.equal(isInsideInflated({ x: 2188, y: 1220 }, PANEL, HOVER_PANEL_MARGIN_PX), true);
  assert.equal(
    isInsideInflated({ x: 2188 - HOVER_PANEL_MARGIN_PX, y: 1220 }, PANEL, HOVER_PANEL_MARGIN_PX),
    true,
  );
  assert.equal(
    isInsideInflated(
      { x: 2188 - HOVER_PANEL_MARGIN_PX - 1, y: 1220 },
      PANEL,
      HOVER_PANEL_MARGIN_PX,
    ),
    false,
  );
  assert.equal(
    isInsideInflated(
      { x: 2188 + 320 + HOVER_PANEL_MARGIN_PX, y: 1220 + 175 },
      PANEL,
      HOVER_PANEL_MARGIN_PX,
    ),
    true,
  );
});

test("cursor parked on the tray icon counts as near (the held-click case)", () => {
  // Icon center: ~37px below the panel bottom edge — beyond any sane
  // panel-only margin, yet well within the anchor rect.
  const s = nextHoverLeaveState({
    cursor: { x: ICON.x + 12, y: ICON.y + 12 },
    near: NEAR,
    dwellMs: 1200,
    outsideSince: 1000,
    now: 999999,
  });
  assert.deepEqual(s, { outsideSince: null, dismiss: false });
});

test("cursor inside the panel resets the outside timer", () => {
  const s = nextHoverLeaveState({
    cursor: { x: 2300, y: 1300 },
    near: NEAR,
    dwellMs: 1200,
    outsideSince: 1000,
    now: 5000,
  });
  assert.deepEqual(s, { outsideSince: null, dismiss: false });
});

test("first outside tick arms, sustained absence dismisses", () => {
  const FAR = { x: 514, y: 992 };
  const armed = nextHoverLeaveState({
    cursor: FAR,
    near: NEAR,
    dwellMs: 1200,
    outsideSince: null,
    now: 1000,
  });
  assert.deepEqual(armed, { outsideSince: 1000, dismiss: false });

  const stillShort = nextHoverLeaveState({
    cursor: FAR,
    near: NEAR,
    dwellMs: 1200,
    outsideSince: 1000,
    now: 1000 + 999,
  });
  assert.deepEqual(stillShort, { outsideSince: 1000, dismiss: false });

  const done = nextHoverLeaveState({
    cursor: FAR,
    near: NEAR,
    dwellMs: 1200,
    outsideSince: 1000,
    now: 1000 + 1200,
  });
  assert.deepEqual(done, { outsideSince: 1000, dismiss: true });
});

test("moving along the taskbar away from the icon dismisses after the dwell", () => {
  // Same taskbar row (y of the icon) but 300px to the left — near neither
  // the icon nor the panel.
  const away = { x: ICON.x - 300, y: ICON.y + 12 };
  const armed = nextHoverLeaveState({
    cursor: away,
    near: NEAR,
    dwellMs: 1200,
    outsideSince: null,
    now: 1000,
  });
  assert.equal(armed.dismiss, false);
  const done = nextHoverLeaveState({
    cursor: away,
    near: NEAR,
    dwellMs: 1200,
    outsideSince: armed.outsideSince,
    now: 1000 + 1200,
  });
  assert.equal(done.dismiss, true);
});

test("re-entering the near-set mid-dwell restarts the dwell", () => {
  const FAR = { x: 514, y: 992 };
  const half = nextHoverLeaveState({
    cursor: FAR,
    near: NEAR,
    dwellMs: 1200,
    outsideSince: null,
    now: 1000,
  });
  assert.equal(half.dismiss, false);
  const back = nextHoverLeaveState({
    cursor: { x: 2300, y: 1300 },
    near: NEAR,
    dwellMs: 1200,
    outsideSince: half.outsideSince,
    now: 1600,
  });
  assert.equal(back.outsideSince, null);
  const out = nextHoverLeaveState({
    cursor: FAR,
    near: NEAR,
    dwellMs: 1200,
    outsideSince: back.outsideSince,
    now: 1600,
  });
  assert.deepEqual(out, { outsideSince: 1600, dismiss: false });
});

test("unreadable cursor position never dismisses", () => {
  const s = nextHoverLeaveState({
    cursor: null,
    near: NEAR,
    dwellMs: 1200,
    outsideSince: 1000,
    now: 999999,
  });
  assert.deepEqual(s, { outsideSince: null, dismiss: false });
});
