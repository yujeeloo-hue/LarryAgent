import { app } from "electron";
import { overlayScrollbarsForced } from "../platformCaps.js";

/**
 * Scrollbar presentation parity (Windows ↔ macOS).
 *
 * macOS renders Chromium's native overlay scrollbars: slim, floating, they
 * appear while scrolling and auto-hide — and they never consume layout.
 * Windows Chromium defaults to classic bars: ~15px, always visible, grey
 * track, permanently reserved inside the scrollable box (sidebar, screens,
 * detail drawers). That divergence is the single biggest "this port looks
 * different" tell, so the main process force-enables the OverlayScrollbar
 * feature on win32 to reuse the exact same presentation code path macOS
 * already exercises.
 *
 * macOS is untouched: the flag is only appended on win32 (see
 * platformCaps.ts), and app.commandLine switches must be set before app
 * ready — callers apply this module's side effect at import time.
 */

/** True when this process should force overlay scrollbars. */
export function shouldForceOverlayScrollbars(): boolean {
  return overlayScrollbarsForced;
}

/**
 * Merge the overlay-scrollbar feature into an existing `--enable-features`
 * value without clobbering other features the caller (or a wrapper script)
 * may have set. Pure — unit tested in scrollbarPresentation.test.ts.
 */
export function mergeOverlayScrollbarFeature(current: string): string {
  const features = current
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && f !== "OverlayScrollbar");
  return [...features, "OverlayScrollbar"].join(",");
}

/** Apply the Chromium switch. No-op on macOS by design. */
export function applyScrollbarPresentationSwitches(): void {
  if (!shouldForceOverlayScrollbars()) return;
  const current = app.commandLine.getSwitchValue("enable-features");
  app.commandLine.appendSwitch(
    "enable-features",
    mergeOverlayScrollbarFeature(current),
  );
}
