import { screen } from "electron";
import type { OverlayChannelFactory } from "../../tools/computerUse/cursorOverlay.js";
import { OverlayController } from "./OverlayController.js";
import { createOverlayWindowsView } from "./OverlayWindowsView.js";
import type { OverlayScreen } from "./overlayTypes.js";

function electronOverlayScreen(): OverlayScreen {
  return {
    toDipPoint: (point) => screen.screenToDipPoint(point),
    toDipRect: (rect) => screen.screenToDipRect(null, rect),
    workArea: (at) => {
      const point = at ? { x: Math.round(at.x), y: Math.round(at.y) } : screen.getCursorScreenPoint();
      return screen.getDisplayNearestPoint(point).workArea;
    },
  };
}

export function createElectronOverlayChannel(): OverlayChannelFactory {
  return (handlers) => new OverlayController(handlers, createOverlayWindowsView(), electronOverlayScreen());
}
