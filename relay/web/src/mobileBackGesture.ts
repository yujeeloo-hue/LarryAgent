/** Swipe right to invoke the visible page's existing Back action. */
export function installMobileBackGesture(getLayout: () => HTMLElement | undefined): () => void {
  const mobile = window.matchMedia("(max-width: 768px)");
  const getBackButton = () => {
    if (document.querySelector(".sheet-scrim.is-open, .th-overlay, .files-panel:not([hidden])")) return null;
    return getLayout()?.querySelector<HTMLButtonElement>(".view:not([hidden]) .m-back:not(:disabled)") ?? null;
  };
  type Gesture = {
    id: number;
    x: number;
    y: number;
    time: number;
    button: HTMLButtonElement;
    horizontal: boolean;
  };
  let gesture: Gesture | null = null;
  const cancel = () => { gesture = null; };
  const available = () => mobile.matches && Math.abs((window.visualViewport?.scale ?? 1) - 1) < 0.01;
  const start = (event: TouchEvent) => {
    cancel();
    if (!available() || event.touches.length !== 1 || event.defaultPrevented) return;
    const button = getBackButton();
    const pane = button?.closest(".main");
    const target = event.target instanceof Element ? event.target : null;
    if (!button || !pane || !target || !pane.contains(target)) return;
    if (target.closest('button, a, input, textarea, select, pre, code, table, [role="slider"], [draggable="true"], [contenteditable]:not([contenteditable="false"])')) return;
    if (window.getSelection()?.isCollapsed === false) return;
    // A horizontally scrollable descendant owns its gesture, even at its edge.
    for (let node: Element | null = target; node && node !== pane; node = node.parentElement) {
      if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(window.getComputedStyle(node).overflowX)) return;
    }
    const touch = event.touches[0]!;
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, time: event.timeStamp, button, horizontal: false };
  };
  const current = () => gesture && available() && gesture.button.isConnected && getBackButton() === gesture.button;
  const move = (event: TouchEvent) => {
    if (!gesture) return;
    if (!current() || event.touches.length !== 1 || event.touches[0]!.identifier !== gesture.id || event.defaultPrevented) {
      cancel();
      return;
    }
    const dx = event.touches[0]!.clientX - gesture.x;
    const dy = Math.abs(event.touches[0]!.clientY - gesture.y);
    if (!gesture.horizontal) {
      if (dx < -12 || (dy >= 12 && dy > Math.abs(dx))) { cancel(); return; }
      if (dx < 12 || dx < dy * 1.5) return;
      gesture.horizontal = true;
    }
    if (event.cancelable) event.preventDefault();
    else cancel(); // Native scrolling already owns this touch stream.
  };
  const end = (event: TouchEvent) => {
    const active = gesture;
    const valid = current();
    cancel();
    if (!active?.horizontal || !valid || event.defaultPrevented || event.touches.length) return;
    const touch = Array.from(event.changedTouches).find(t => t.identifier === active.id);
    if (!touch) return;
    const dx = touch.clientX - active.x;
    const dy = Math.abs(touch.clientY - active.y);
    if (dx < 64 || dx < dy * 1.5 || event.timeStamp - active.time > 1000) return;
    if (event.cancelable) event.preventDefault(); // Suppress the synthetic tap.
    active.button.click();
  };
  document.addEventListener("touchstart", start, { passive: true });
  document.addEventListener("touchmove", move, { passive: false });
  document.addEventListener("touchend", end, { passive: false });
  document.addEventListener("touchcancel", cancel);
  document.addEventListener("visibilitychange", cancel);
  window.addEventListener("resize", cancel);
  window.addEventListener("orientationchange", cancel);
  return () => {
    cancel();
    document.removeEventListener("touchstart", start);
    document.removeEventListener("touchmove", move);
    document.removeEventListener("touchend", end);
    document.removeEventListener("touchcancel", cancel);
    document.removeEventListener("visibilitychange", cancel);
    window.removeEventListener("resize", cancel);
    window.removeEventListener("orientationchange", cancel);
  };
}
