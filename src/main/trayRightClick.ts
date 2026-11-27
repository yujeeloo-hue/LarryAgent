
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
      awaitingEchoUntil = 0;
      return;
    }
    awaitingEchoUntil = t + echoWindowMs;
    toggle(bounds);
  };
}
