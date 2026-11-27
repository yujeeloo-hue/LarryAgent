import type { CocoSnapshot } from "../../../coco/types.js";

type Listener = (snapshot: CocoSnapshot) => void;
export class CocoState {
  private snapshot: CocoSnapshot | undefined;
  private listeners = new Set<Listener>();
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
      if (revision === this.revision) this.publish(snapshot);
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  refreshIfObserved(): void {
    if (this.listeners.size) void this.refresh().catch(() => {});
  }
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.snapshot) listener(this.snapshot);
    if (!this.unsubChanged) {
      void this.refresh().catch(() => {});
      this.unsubChanged = this.onChanged(() => { void this.refresh().catch(() => {}); });
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.unsubChanged) {
        this.unsubChanged(); this.unsubChanged = undefined;
      }
    };
  }
}

export const cocoState = new CocoState(async () => {
  if (!window.jellybot?.cocoSnapshot) throw new Error("CoCo requires an updated Larry Agent connection");
  return window.jellybot.cocoSnapshot();
}, handler => window.jellybot?.onCocoChanged?.(handler) ?? (() => {}));
