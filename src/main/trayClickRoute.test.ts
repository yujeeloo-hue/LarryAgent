import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveTrayLeftClickAction } from "../main/trayClickRoute.js";


const deps = (
  open: boolean,
  foreground: boolean,
  popupOpen: boolean,
): Parameters<typeof resolveTrayLeftClickAction>[0] => ({
  isMainWindowOpen: () => open,
  isMainWindowForeground: () => foreground,
  isUsagePopupOpen: () => popupOpen,
});

describe("resolveTrayLeftClickAction", () => {
  it("reopens the window when it is not open", () => {
    assert.equal(resolveTrayLeftClickAction(deps(false, false, false)), "open-window");
  });

  it("reopens even when the popup is open but the window is not", () => {
    assert.equal(resolveTrayLeftClickAction(deps(false, false, true)), "open-window");
  });

  it("dismisses the popup on a second click (popup open, window background)", () => {
    assert.equal(resolveTrayLeftClickAction(deps(true, false, true)), "usage-popup");
  });

  it("dismisses the popup even when the window reports foreground", () => {
    assert.equal(resolveTrayLeftClickAction(deps(true, true, true)), "usage-popup");
  });

  it("focuses the window when it is open but not foreground", () => {
    assert.equal(resolveTrayLeftClickAction(deps(true, false, false)), "focus-window");
  });

  it("opens the usage popup when the window is open and foreground", () => {
    assert.equal(resolveTrayLeftClickAction(deps(true, true, false)), "usage-popup");
  });
});
