/** Lock page pinch zoom in an installed web app without cancelling the
 * single-finger touch stream used by native list scrolling/rubber-banding. */
export function installStandaloneZoomLock(): () => void {
  const root = document.documentElement;
  const mode = typeof window.matchMedia === "function"
    ? window.matchMedia("(display-mode: standalone)")
    : null;
  const options = { capture: true, passive: false };
  const cancelGesture = (event: Event) => {
    if (event.cancelable) event.preventDefault();
  };
  const cancelMultitouch = (event: Event) => {
    if ((event as TouchEvent).touches?.length > 1) cancelGesture(event);
  };
  const listeners = [
    ["touchstart", cancelMultitouch],
    ["touchmove", cancelMultitouch],
    ["gesturestart", cancelGesture],
    ["gesturechange", cancelGesture],
  ] as const;
  let locked: boolean | null = null;
  const setLocked = (enabled: boolean) => {
    if (locked === enabled) return;
    locked = enabled;
    root.classList.toggle("standalone-zoom-locked", enabled);
    for (const [type, handler] of listeners) {
      if (enabled) document.addEventListener(type, handler, options);
      else document.removeEventListener(type, handler, options);
    }
  };
  const sync = () => setLocked(
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    mode?.matches === true,
  );
  sync();
  mode?.addEventListener("change", sync);
  window.addEventListener("pageshow", sync);
  return () => {
    mode?.removeEventListener("change", sync);
    window.removeEventListener("pageshow", sync);
    setLocked(false);
  };
}
