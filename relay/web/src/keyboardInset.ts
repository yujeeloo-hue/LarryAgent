/**
 * iOS virtual-keyboard avoidance.
 *
 * Safari never shrinks the layout viewport when the on-screen keyboard
 * opens, so absolutely-positioned mobile panes (`.main`, with the composer
 * pinned to their bottom) stay buried behind the keyboard. Track the visual
 * viewport and publish the overlap as a CSS variable the ≤768px layout
 * consumes as a bottom inset. Raising only the top edge leaves a bottom-
 * anchored composer behind the keyboard.
 *
 * The keyboard inset is inert on desktop, during pinch-zoom (scale > 1
 * shrinks the visual viewport too), and on engines that resize the layout
 * viewport themselves. Document-origin recovery also covers landscape
 * phones above the mobile breakpoint, once the keyboard is gone.
 */
export function installKeyboardInset(): () => void {
  const vv = window.visualViewport;
  if (!vv || typeof vv.addEventListener !== "function") return () => {};
  const root = document.documentElement;
  const mobileMQ = window.matchMedia("(max-width: 768px)");
  let frame: number | null = null;
  let timers: number[] = [];
  const clear = () => root.style.removeProperty("--kb-inset");
  const editableFocused = () => {
    const active = document.activeElement;
    if (!active) return false;
    if (active.tagName === "TEXTAREA") {
      const input = active as HTMLTextAreaElement;
      return !input.disabled && !input.readOnly;
    }
    if (active.tagName === "INPUT") {
      const input = active as HTMLInputElement;
      return !input.disabled && !input.readOnly &&
        !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/.test(input.type);
    }
    return (active as HTMLElement).isContentEditable;
  };
  let baselineWidth = root.clientWidth || window.innerWidth;
  // A restored Safari page may already have a focused field and keyboard.
  let baselineHeight = editableFocused()
    ? root.clientHeight || window.innerHeight
    : vv.height;
  let keyboardActive = false;
  const apply = () => {
    const layoutHeight = root.clientHeight || window.innerHeight;
    // Safari can retain document scrolling/auto-pan after rotation or a
    // keyboard close, despite overflow:hidden. Restore only the document's
    // origin once the keyboard is gone; never reset a list/conversation or
    // fight the viewport pan needed to keep a focused field visible.
    if (Math.abs(vv.scale - 1) <= 0.01 && layoutHeight - vv.height < 100 &&
        (window.scrollX || window.scrollY || root.scrollTop || root.scrollLeft || vv.offsetTop)) {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    }
    if (Math.abs(vv.scale - 1) > 0.01) {
      keyboardActive = false;
      clear();
      return;
    }
    const width = root.clientWidth || window.innerWidth;
    const focused = editableFocused();
    if (width !== baselineWidth) {
      baselineWidth = width;
      baselineHeight = focused || keyboardActive ? layoutHeight : vv.height;
    }
    // Landscape phones may cross 768px. Rebase their geometry even while
    // the desktop layout is active, before returning to portrait.
    if (!mobileMQ.matches) {
      keyboardActive = false;
      clear();
      return;
    }
    const shrunk = baselineHeight - vv.height >= 100;
    if (!focused && !(keyboardActive && shrunk)) {
      // Blur precedes the keyboard's closing animation. Do not replace the
      // remembered unobstructed height with that animation's short viewport.
      keyboardActive = false;
      baselineHeight = Math.max(baselineHeight, vv.height);
      clear();
      return;
    }
    // Browser toolbars also resize the visual viewport. Require both an
    // editable focus and a substantial loss from its unfocused height.
    if (!shrunk) {
      keyboardActive = false;
      clear();
      return;
    }
    // Keep a confirmed keyboard's inset through transient blur/focus gaps
    // until its visual viewport actually recovers, rather than dropping the
    // composer under the still-closing keyboard.
    keyboardActive = true;
    const overlap = Math.round(
      Math.max(0, layoutHeight - vv.height - vv.offsetTop),
    );
    // <8px is just toolbar/rubber-band jitter, not a keyboard.
    if (overlap >= 8) root.style.setProperty("--kb-inset", `${overlap}px`);
    else clear();
  };
  const schedule = () => {
    if (frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      apply();
    });
  };
  const settle = () => {
    schedule();
    for (const timer of timers) window.clearTimeout(timer);
    // Safari's final viewport/offset can arrive after focus, the keyboard
    // animation, or the collapsed composer's height morph. Re-read without
    // relying on another resize event, then stop polling.
    timers = [80, 200, 400, 800].map((delay) => window.setTimeout(schedule, delay));
  };
  vv.addEventListener("resize", settle);
  vv.addEventListener("scroll", settle);
  mobileMQ.addEventListener("change", settle);
  document.addEventListener("focusin", settle);
  document.addEventListener("focusout", settle);
  document.addEventListener("visibilitychange", settle);
  window.addEventListener("resize", settle);
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("orientationchange", settle);
  window.addEventListener("pageshow", settle);
  apply();
  return () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    for (const timer of timers) window.clearTimeout(timer);
    vv.removeEventListener("resize", settle);
    vv.removeEventListener("scroll", settle);
    mobileMQ.removeEventListener("change", settle);
    document.removeEventListener("focusin", settle);
    document.removeEventListener("focusout", settle);
    document.removeEventListener("visibilitychange", settle);
    window.removeEventListener("resize", settle);
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("orientationchange", settle);
    window.removeEventListener("pageshow", settle);
    clear();
  };
}
