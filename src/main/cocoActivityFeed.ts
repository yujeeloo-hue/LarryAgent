import { IDLE_COCO_ACTIVITY, sameCocoActivity, type CocoActivity } from "../coco/activity.js";

export function createCocoActivityFeed(read: () => CocoActivity, publish: (activity: CocoActivity) => void, options: { throttleMs?: number } = {}) {
  const throttleMs = options.throttleMs ?? 150;
  let last: CocoActivity = IDLE_COCO_ACTIVITY, pending: ReturnType<typeof setTimeout> | undefined;
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
    start: (): void => { check(); },
    stop: (): void => {
      if (pending) clearTimeout(pending);
      pending = undefined;
    },
  };
}

export function trailing(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer) return;
    timer = setTimeout(() => { timer = undefined; fn(); }, ms);
    timer.unref?.();
  };
}
