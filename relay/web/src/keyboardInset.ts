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
  let baselineHeight = editableFocused()
    ? root.clientHeight || window.innerHeight
    : vv.height;
  let keyboardActive = false;
  const apply = () => {
    const layoutHeight = root.clientHeight || window.innerHeight;
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
    if (!mobileMQ.matches) {
      keyboardActive = false;
      clear();
      return;
    }
    const shrunk = baselineHeight - vv.height >= 100;
    if (!focused && !(keyboardActive && shrunk)) {
      keyboardActive = false;
      baselineHeight = Math.max(baselineHeight, vv.height);
      clear();
      return;
    }
    if (!shrunk) {
      keyboardActive = false;
      clear();
      return;
    }
    keyboardActive = true;
    const overlap = Math.round(
      Math.max(0, layoutHeight - vv.height - vv.offsetTop),
    );
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
