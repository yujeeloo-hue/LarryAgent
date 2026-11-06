import type { CocoSnapshot } from "../../../coco/types.js";

type Listener = (snapshot: CocoSnapshot) => void;
/** Push from `coco:changed` keeps the snapshot fresh; the poll is only a safety net. */
const FALLBACK_POLL_MS = 30_000;
/** Full snapshots for the mounted CoCo screen only; the shell icon uses `coco:activity`. */
export class CocoState {
  private snapshot: CocoSnapshot | undefined;
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubChanged: (() => void) | undefined;
  private pending: Promise<void> | undefined;
  private revision = 0;
  constructor(private read: () => Promise<CocoSnapshot>, private onChanged: (handler: () => void) => () => void = () => () => {}) {}
  publish(snapshot: CocoSnapshot): void {
    this.revision++;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    const revision = this.revision;
    this.pending = this.read().then(snapshot => {
      // A command may have delivered a newer snapshot while this request was in flight.
      if (revision === this.revision) this.publish(snapshot);
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  /** Session-side changes (CoCo chat / execution turns) only matter while someone is watching. */
  refreshIfObserved(): void {
    if (this.listeners.size) void this.refresh().catch(() => {});
  }
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.snapshot) listener(this.snapshot);
    if (!this.timer) {
      void this.refresh().catch(() => {});
      this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, FALLBACK_POLL_MS);
      this.unsubChanged = this.onChanged(() => { void this.refresh().catch(() => {}); });
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.timer) {
        clearInterval(this.timer); this.timer = undefined;
        this.unsubChanged?.(); this.unsubChanged = undefined;
      }
    };
  }
}

export const cocoState = new CocoState(async () => {
  if (!window.jellybot?.cocoSnapshot) throw new Error("CoCo requires an updated Larry Agent connection");
  return window.jellybot.cocoSnapshot();
}, handler => window.jellybot?.onCocoChanged?.(handler) ?? (() => {}));
