
const ENTER_DISTANCE_PX = 18;
const ENTER_DURATION_MS = 460;
const ENTER_EASING = "cubic-bezier(0.16, 1, 0.3, 1)";

const played = new WeakSet<Element>();

function motionAllowed(): boolean {
  return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function playCardEnterAnimation(el: HTMLElement): void {
  if (played.has(el)) return;
  played.add(el);
  if (typeof el.animate !== "function" || !motionAllowed()) return;

  el.animate(
    [
      { opacity: 0, transform: `translate3d(0, ${ENTER_DISTANCE_PX}px, 0)` },
      { opacity: 1, transform: "translate3d(0, 0, 0)" },
    ],
    {
      duration: ENTER_DURATION_MS,
      easing: ENTER_EASING,
      fill: "backwards",
    },
  );
}

const HEIGHT_DURATION_MS = 380;
const HEIGHT_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

export function playCardHeightTransition(
  outgoing: HTMLElement,
  incoming: HTMLElement,
): void {
  const from = outgoing.getBoundingClientRect().height;
  outgoing.replaceWith(incoming);
  if (typeof incoming.animate !== "function" || !motionAllowed()) return;
  const to = incoming.getBoundingClientRect().height;
  if (!Number.isFinite(from) || !Number.isFinite(to) || Math.abs(from - to) < 2) {
    return;
  }
  try {
    const anim = incoming.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      {
        duration: HEIGHT_DURATION_MS,
        easing: HEIGHT_EASING,
      },
    );
    void anim.finished.catch(() => undefined);
  } catch {
  }
}
