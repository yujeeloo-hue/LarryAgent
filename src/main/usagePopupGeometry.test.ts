import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampUsagePopupHeight,
  computeUsagePopupRect,
  inferTaskbarEdge,
  USAGE_POPUP_DEFAULT_HEIGHT,
  USAGE_POPUP_MAX_HEIGHT,
  USAGE_POPUP_MIN_HEIGHT,
  USAGE_POPUP_WIDTH,
} from "./usagePopupGeometry.js";

const DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 };
// macOS: menu bar reserves the top 25px.
const MAC_WORK_AREA = { x: 0, y: 25, width: 1920, height: 1055 };
// Windows: taskbar (48px) on the bottom.
const WIN_WORK_AREA = { x: 0, y: 0, width: 1920, height: 1032 };

const MAC_TRAY = { x: 1700, y: 0, width: 24, height: 24 };
const WIN_TRAY = { x: 1888, y: 1040, width: 24, height: 24 };

const SIZE = { width: USAGE_POPUP_WIDTH, height: 360 };

describe("inferTaskbarEdge", () => {
  it("reads the four edges from workArea insets", () => {
    assert.equal(inferTaskbarEdge(WIN_WORK_AREA, DISPLAY), "bottom");
    assert.equal(
      inferTaskbarEdge({ x: 0, y: 48, width: 1920, height: 1032 }, DISPLAY),
      "top",
    );
    assert.equal(
      inferTaskbarEdge({ x: 64, y: 0, width: 1856, height: 1080 }, DISPLAY),
      "left",
    );
    assert.equal(
      inferTaskbarEdge({ x: 0, y: 0, width: 1856, height: 1080 }, DISPLAY),
      "right",
    );
  });

  it("defaults to bottom when nothing is reserved", () => {
    assert.equal(inferTaskbarEdge(DISPLAY, DISPLAY), "bottom");
  });
});

describe("computeUsagePopupRect (macOS)", () => {
  it("drops below the menu-bar icon, centered on it", () => {
    const rect = computeUsagePopupRect({
      platform: "darwin",
      trayBounds: MAC_TRAY,
      workArea: MAC_WORK_AREA,
      displayBounds: DISPLAY,
      size: SIZE,
    });
    // anchored 0+24+6 = 30, but the workArea edge margin (25+8 = 33) wins
    assert.equal(rect.y, 33);
    // centered on icon: 1712 - 140 = 1572
    assert.equal(rect.x, 1572);
    assert.equal(rect.width, USAGE_POPUP_WIDTH);
    assert.equal(rect.height, 360);
  });

  it("clamps horizontally when the icon sits near the screen edge", () => {
    const rect = computeUsagePopupRect({
      platform: "darwin",
      trayBounds: { x: 1910, y: 0, width: 10, height: 24 },
      workArea: MAC_WORK_AREA,
      displayBounds: DISPLAY,
      size: SIZE,
    });
    assert.equal(rect.x, 1920 - USAGE_POPUP_WIDTH - 8);
  });

  it("returns whole pixels", () => {
    const rect = computeUsagePopupRect({
      platform: "darwin",
      trayBounds: { x: 1701, y: 0, width: 23, height: 24 },
      workArea: MAC_WORK_AREA,
      displayBounds: DISPLAY,
      size: SIZE,
    });
    assert.equal(rect.x, Math.round(rect.x));
    assert.equal(rect.y, Math.round(rect.y));
  });
});

describe("computeUsagePopupRect (Windows)", () => {
  it("rises above a bottom taskbar, centered on the icon", () => {
    const rect = computeUsagePopupRect({
      platform: "win32",
      trayBounds: WIN_TRAY,
      workArea: WIN_WORK_AREA,
      displayBounds: DISPLAY,
      size: SIZE,
    });
    // anchored 1040-360-6 = 674, clamped to workArea bottom margin (1032-360-8)
    assert.equal(rect.y, 664);
    // centered on icon (1900 - 140 = 1760) but clamped to 1920-280-8 = 1632
    assert.equal(rect.x, 1632);
  });

  it("hangs below a top taskbar", () => {
    const topWorkArea = { x: 0, y: 48, width: 1920, height: 1032 };
    const rect = computeUsagePopupRect({
      platform: "win32",
      trayBounds: { x: 800, y: 8, width: 24, height: 24 },
      workArea: topWorkArea,
      displayBounds: DISPLAY,
      size: SIZE,
    });
    // anchored 8+24+6 = 38, clamped to workArea top margin (48+8 = 56)
    assert.equal(rect.y, 56);
    assert.equal(rect.x, 812 - 140);
  });

  it("opens beside a left taskbar, vertically centered on the icon", () => {
    const leftWorkArea = { x: 64, y: 0, width: 1856, height: 1080 };
    const rect = computeUsagePopupRect({
      platform: "win32",
      trayBounds: { x: 8, y: 500, width: 40, height: 24 },
      workArea: leftWorkArea,
      displayBounds: DISPLAY,
      size: SIZE,
    });
    // anchored 8+40+6 = 54, clamped to workArea left margin (64+8 = 72)
    assert.equal(rect.x, 72);
    assert.equal(rect.y, 512 - 180);
  });

  it("opens left of a right taskbar", () => {
    const rightWorkArea = { x: 0, y: 0, width: 1856, height: 1080 };
    const rect = computeUsagePopupRect({
      platform: "win32",
      trayBounds: { x: 1872, y: 500, width: 40, height: 24 },
      workArea: rightWorkArea,
      displayBounds: DISPLAY,
      size: SIZE,
    });
    // anchored 1872-280-6 = 1586, clamped to workArea right margin (1856-280-8)
    assert.equal(rect.x, 1568);
  });
});

describe("computeUsagePopupRect (fallbacks & clamping)", () => {
  it("falls back to the top-right corner on macOS when tray bounds are empty", () => {
    const rect = computeUsagePopupRect({
      platform: "darwin",
      trayBounds: { x: 0, y: 0, width: 0, height: 0 },
      workArea: MAC_WORK_AREA,
      displayBounds: DISPLAY,
      size: SIZE,
    });
    assert.equal(rect.x, 1920 - USAGE_POPUP_WIDTH - 8);
    assert.equal(rect.y, 25 + 8);
  });

  it("falls back to the bottom-right corner on Windows", () => {
    const rect = computeUsagePopupRect({
      platform: "win32",
      trayBounds: { x: 0, y: 0, width: 0, height: 0 },
      workArea: WIN_WORK_AREA,
      displayBounds: DISPLAY,
      size: SIZE,
    });
    assert.equal(rect.x, 1920 - USAGE_POPUP_WIDTH - 8);
    assert.equal(rect.y, 1032 - 360 - 8);
  });

  it("caps the height at USAGE_POPUP_MAX_HEIGHT and at the workArea", () => {
    const capped = computeUsagePopupRect({
      platform: "darwin",
      trayBounds: MAC_TRAY,
      workArea: MAC_WORK_AREA,
      displayBounds: DISPLAY,
      size: { width: USAGE_POPUP_WIDTH, height: 9999 },
    });
    assert.equal(capped.height, USAGE_POPUP_MAX_HEIGHT);
    const tiny = computeUsagePopupRect({
      platform: "darwin",
      trayBounds: MAC_TRAY,
      workArea: { x: 0, y: 25, width: 1920, height: 300 },
      displayBounds: DISPLAY,
      size: { width: USAGE_POPUP_WIDTH, height: 9999 },
    });
    assert.equal(tiny.height, 300 - 16);
  });
});

describe("clampUsagePopupHeight", () => {
  it("keeps a short panel exactly as measured", () => {
    // DeepSeek-only panel: one section without plan bars ≈ 105px. A 120px
    // floor inflated the opaque macOS window by 15px of panel fill, which
    // read as an empty band in the card's own colour under the footer.
    assert.equal(clampUsagePopupHeight(105), 105);
    assert.equal(clampUsagePopupHeight(119), 119);
    assert.equal(clampUsagePopupHeight(120), 120);
  });

  it("rounds fractional measurements and caps at the maximum", () => {
    assert.equal(clampUsagePopupHeight(104.4), 104);
    assert.equal(clampUsagePopupHeight(104.6), 105);
    assert.equal(clampUsagePopupHeight(9_999), USAGE_POPUP_MAX_HEIGHT);
  });

  it("floors only degenerate measurements and ignores garbage", () => {
    assert.equal(clampUsagePopupHeight(0), USAGE_POPUP_MIN_HEIGHT);
    assert.equal(clampUsagePopupHeight(Number.NaN), USAGE_POPUP_DEFAULT_HEIGHT);
    assert.equal(clampUsagePopupHeight("320"), USAGE_POPUP_DEFAULT_HEIGHT);
    assert.equal(clampUsagePopupHeight(null), USAGE_POPUP_DEFAULT_HEIGHT);
  });
});
