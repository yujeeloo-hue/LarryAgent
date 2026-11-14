import { IDLE_COCO_ACTIVITY, sameCocoActivity, type CocoActivity } from "../coco/activity.js";

/**
 * Shell icon state, pushed only when it changes. `schedule()` is the fast path
 * (engine emits, CoCo session stream events); the fallback poll covers state
 * written without an emit, so correctness never depends on every call site.
 */
export function createCocoActivityFeed(read: () => CocoActivity, publish: (activity: CocoActivity) => void, options: { throttleMs?: number; pollMs?: number } = {}) {
  const throttleMs = options.throttleMs ?? 150, pollMs = options.pollMs ?? 2000;
  let last: CocoActivity = IDLE_COCO_ACTIVITY, pending: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined;
  const check = (): void => {
    let next: CocoActivity;
    try { next = read(); } catch { next = IDLE_COCO_ACTIVITY; }
    if (sameCocoActivity(next, last)) return;
    last = next;
    publish(next);
  };
  return {
    current: (): CocoActivity => { check(); return last; },
    schedule: (): void => {
      if (pending) return;
      pending = setTimeout(() => { pending = undefined; check(); }, throttleMs);
      pending.unref?.();
    },
    start: (): void => {
      if (poll) return;
      check();
      poll = setInterval(check, pollMs);
      poll.unref?.();
    },
    stop: (): void => {
      if (pending) clearTimeout(pending);
      if (poll) clearInterval(poll);
      pending = poll = undefined;
    },
  };
}

/** Trailing coalesce: bursts collapse to one call that always fires after the last trigger. */
export function trailing(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer) return;
    timer = setTimeout(() => { timer = undefined; fn(); }, ms);
    timer.unref?.();
  };
}
