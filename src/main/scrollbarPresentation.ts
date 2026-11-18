import { app } from "electron";
import { overlayScrollbarsForced } from "../platformCaps.js";


export function shouldForceOverlayScrollbars(): boolean {
  return overlayScrollbarsForced;
}

export function mergeOverlayScrollbarFeature(current: string): string {
  const features = current
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && f !== "OverlayScrollbar");
  return [...features, "OverlayScrollbar"].join(",");
}

export function applyScrollbarPresentationSwitches(): void {
  if (!shouldForceOverlayScrollbars()) return;
  const current = app.commandLine.getSwitchValue("enable-features");
  app.commandLine.appendSwitch(
    "enable-features",
    mergeOverlayScrollbarFeature(current),
  );
}
