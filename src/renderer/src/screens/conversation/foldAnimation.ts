/**
 * Shared max-height fold + transition helpers for conversation chrome
 * (plan review panel, long user prompts). Presentation only.
 */

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export type FoldOptions = {
  /** Animate opacity alongside height. Default true. */
  fade?: boolean;
  /** Collapsed height in px. Default 0. */
  collapsedHeight?: number;
};

/** Settled inline value — never "" (that falls back to the CSS default). */
export function settleFold(
  el: HTMLElement,
  open: boolean,
  options?: FoldOptions,
): void {
  const collapsed = options?.collapsedHeight ?? 0;
  el.style.maxHeight = open ? "none" : `${collapsed}px`;
  if (options?.fade !== false) el.style.opacity = open ? "1" : "0";
}

const cleanups = new WeakMap<HTMLElement, () => void>();

/**
 * Animate an element's max-height between its collapsed height and its natural
 * height. Resolves once the transition settles, so callers can chain teardown
 * (e.g. unmounting after a collapse).
 */
export function animateFold(
  el: HTMLElement,
  open: boolean,
  options?: FoldOptions,
): Promise<void> {
  cleanups.get(el)?.();

  if (prefersReducedMotion()) {
    settleFold(el, open, options);
    return Promise.resolve();
  }

  const collapsed = options?.collapsedHeight ?? 0;
  const fade = options?.fade !== false;
  const from = el.getBoundingClientRect().height;
  // Measure the natural target height without painting an intermediate frame.
  el.style.maxHeight = "none";
  const to = open ? el.scrollHeight : collapsed;
  el.style.maxHeight = `${from}px`;
  if (fade) el.style.opacity = open ? "0" : "1";
  // Force layout so the browser keeps the start value.
  void el.offsetHeight;

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      el.removeEventListener("transitionend", onEnd);
      window.clearTimeout(timer);
      cleanups.delete(el);
      // Release the cap so later content growth is not clipped.
      settleFold(el, open, options);
      resolve();
    };
    const onEnd = (event: TransitionEvent): void => {
      if (event.target !== el) return;
      if (event.propertyName !== "max-height") return;
      finish();
    };
    const timer = window.setTimeout(finish, 400);
    cleanups.set(el, finish);
    el.addEventListener("transitionend", onEnd);

    requestAnimationFrame(() => {
      el.style.maxHeight = `${to}px`;
      if (fade) el.style.opacity = open ? "1" : "0";
    });
  });
}

/**
 * Resolve when a class-driven transition on `el` settles. Used for the
 * slide + fade of panels whose start/end states live in CSS.
 */
export function waitForTransition(
  el: HTMLElement,
  properties: string[],
  timeoutMs: number,
): Promise<void> {
  if (prefersReducedMotion()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      el.removeEventListener("transitionend", onEnd);
      window.clearTimeout(timer);
      resolve();
    };
    const onEnd = (event: TransitionEvent): void => {
      if (event.target !== el) return;
      if (!properties.includes(event.propertyName)) return;
      finish();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    el.addEventListener("transitionend", onEnd);
  });
}

/**
 * Paint `from` for one frame, then drop it so the CSS transition runs.
 * Two frames: the first can still be batched with the initial mount.
 */
export function playClassEnter(el: HTMLElement, fromClass: string): void {
  if (prefersReducedMotion()) return;
  el.classList.add(fromClass);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.remove(fromClass));
  });
}
