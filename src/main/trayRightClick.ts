/**
 * Windows tray right-click dedupe — one toggle per physical gesture.
 *
 * Shell_NotifyIcon delivers a physical right-click on a tray icon as up to
 * TWO callback messages: WM_RBUTTONDOWN (press) and WM_CONTEXTMENU (which
 * Explorer synthesizes after the button is released). Electron maps BOTH
 * to the `right-click` event (shell/browser/ui/win/notify_icon_host.cc),
 * so a naive toggle handler runs twice per gesture — press opens the usage
 * popup, the release echo closes it a beat later ("flashes twice").
 *
 * HOWEVER, Explorer does NOT always emit the WM_CONTEXTMENU echo (e.g. when
 * the mouse drifts off the icon before release, when a popup appears during
 * the click, or when the icon lives in the Win11 overflow flyout). A blind
 * odd/even alternator stays stuck in `echoExpected = true` after a single-event
 * gesture and swallows the user's NEXT real right-click ("sometimes right-click
 * fails to open").
 *
 * Fix: combine single-echo pairing with a release-window ceiling
 * (`RIGHT_CLICK_ECHO_WINDOW_MS`). If a second event arrives within the window,
 * it is swallowed as the release echo and the gate resets immediately (so rapid
 * repeated clicks still toggle every time). If the window expires without an
 * echo, the next `right-click` is treated as a fresh gesture and never swallowed.
 *
 * macOS menu bar items emit `right-click` once (NSStatusItem), so this
 * wrapper is used only by the Windows resident tray (appTray.ts).
 */

/** Maximum delay (ms) between WM_RBUTTONDOWN and its WM_CONTEXTMENU echo. */
export const RIGHT_CLICK_ECHO_WINDOW_MS = 320;

export type RightClickBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RightClickToggleOptions = {
  now?: () => number;
  echoWindowMs?: number;
};

export function createRightClickToggle(
  toggle: (bounds: RightClickBounds) => void,
  opts?: RightClickToggleOptions,
): (bounds: RightClickBounds) => void {
  const now = opts?.now ?? Date.now;
  const echoWindowMs = opts?.echoWindowMs ?? RIGHT_CLICK_ECHO_WINDOW_MS;
  let awaitingEchoUntil = 0;

  return (bounds) => {
    const t = now();
    if (t < awaitingEchoUntil) {
      // Consume the single release echo and disarm immediately so a rapid
      // follow-up right-click is not mistaken for another echo.
      awaitingEchoUntil = 0;
      return;
    }
    awaitingEchoUntil = t + echoWindowMs;
    toggle(bounds);
  };
}
