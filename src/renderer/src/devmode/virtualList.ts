export type VirtualRowSource = {
  count(): number;
  key(index: number): unknown;
  type(index: number): string;
  create(type: string): HTMLElement;
  bind(el: HTMLElement, index: number): void;
  version?(index: number): number;
  estimate?(index: number, width: number): number;
  remeasure?(): void;
};

export type VirtualListOptions = {
  rowHeight?: number;
  followTail?: boolean;
  tailSlack?: number;
  insetTop?: number;
  insetBottom?: number;
  overscan?: number;
};

type Slot = { el: HTMLElement; type: string; version: number };

const FALLBACK_VIEWPORT = 600;
const FALLBACK_WIDTH = 800;
const FALLBACK_ROW = 17;
const POOL_LIMIT = 64;
const MAX_PASSES = 3;

function scheduleFrame(run: () => void): void {
  if (typeof globalThis.requestAnimationFrame === "function") globalThis.requestAnimationFrame(run);
  else run();
}

export class VirtualList {
  private readonly sizer = document.createElement("div");
  private readonly window = document.createElement("div");
  private keys: unknown[] = [];
  private versions: number[] = [];
  private heights: number[] = [];
  private offsets: number[] = [0];
  private slots = new Map<unknown, Slot>();
  private readonly pools = new Map<string, HTMLElement[]>();
  private width = -1;
  private pinned: boolean;
  private anchor: { key: unknown; index: number; delta: number } | null = null;
  private scheduled = false;
  private destroyed = false;
  private readonly resizeObserver: ResizeObserver | null = null;
  private readonly insetTop: number;
  private readonly insetBottom: number;
  private readonly overscan: number;
  private readonly tailSlack: number;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly source: VirtualRowSource,
    private readonly options: VirtualListOptions = {},
  ) {
    this.insetTop = options.insetTop ?? 0;
    this.insetBottom = options.insetBottom ?? 0;
    this.overscan = options.overscan ?? 320;
    this.tailSlack = options.tailSlack ?? 4;
    this.pinned = options.followTail === true;
    this.sizer.className = "virtual-list-sizer";
    this.sizer.style.position = "relative";
    this.window.className = "virtual-list-window";
    this.window.style.position = "absolute";
    this.window.style.top = "0";
    this.window.style.left = "0";
    this.window.style.right = "0";
    this.sizer.append(this.window);
    viewport.append(this.sizer);
    viewport.addEventListener("scroll", this.onScroll, { passive: true });
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => this.invalidate());
      this.resizeObserver.observe(viewport);
    }
  }

  get renderedCount(): number {
    return this.slots.size;
  }

  invalidate(): void {
    if (this.scheduled || this.destroyed) return;
    this.scheduled = true;
    scheduleFrame(() => this.render());
  }

  refresh(): void {
    this.render();
  }

  scrollToEnd(): void {
    if (!this.options.followTail) return;
    this.pinned = true;
    this.anchor = null;
    this.invalidate();
  }

  destroy(): void {
    this.destroyed = true;
    this.viewport.removeEventListener("scroll", this.onScroll);
    this.resizeObserver?.disconnect();
    this.slots.clear();
    this.pools.clear();
    this.sizer.remove();
  }

  private readonly onScroll = (): void => {
    const top = this.viewport.scrollTop || 0;
    if (this.options.followTail) {
      this.pinned = this.totalHeight() - top - this.viewportHeight() <= this.tailSlack;
    }
    this.captureAnchor(top);
    this.invalidate();
  };

  private render(): void {
    this.scheduled = false;
    if (this.destroyed) return;
    const width = this.contentWidth();
    const widthChanged = width !== this.width;
    if (widthChanged) {
      this.width = width;
      this.source.remeasure?.();
    }
    this.sync(widthChanged);
    const viewH = this.viewportHeight();
    let top = 0;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      top = this.place(viewH);
      if (!this.paint(top, viewH)) break;
      this.recomputeOffsets();
    }
    this.captureAnchor(top);
  }

  private sync(reestimate: boolean): void {
    const n = this.source.count();
    if (n === 0) {
      this.keys = [];
      this.versions = [];
      this.heights = [];
      this.offsets = [0];
      this.anchor = null;
      this.pinned = this.options.followTail === true;
      return;
    }
    if (this.keys.length && this.source.key(0) !== this.keys[0]) {
      const shift = this.keys.indexOf(this.source.key(0));
      if (shift > 0) {
        this.keys.splice(0, shift);
        this.versions.splice(0, shift);
        this.heights.splice(0, shift);
      } else {
        this.keys = [];
        this.versions = [];
        this.heights = [];
      }
    }
    if (this.keys.length > n) {
      this.keys.length = n;
      this.versions.length = n;
      this.heights.length = n;
    }
    let dirty = this.offsets.length !== n + 1;
    for (let i = 0; i < n; i++) {
      const key = this.source.key(i);
      const version = this.source.version?.(i) ?? 0;
      if (!reestimate && i < this.keys.length && this.keys[i] === key && this.versions[i] === version) continue;
      this.keys[i] = key;
      this.versions[i] = version;
      this.heights[i] = this.estimate(i);
      dirty = true;
    }
    if (dirty) this.recomputeOffsets();
  }

  private estimate(index: number): number {
    if (this.options.rowHeight) return this.options.rowHeight;
    const width = this.width > 0 ? this.width : FALLBACK_WIDTH;
    return this.source.estimate?.(index, width) ?? FALLBACK_ROW;
  }

  private recomputeOffsets(): void {
    const n = this.heights.length;
    const offsets = new Array<number>(n + 1);
    offsets[0] = 0;
    for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i]! + this.heights[i]!;
    this.offsets = offsets;
  }

  private place(viewH: number): number {
    const total = this.totalHeight();
    this.sizer.style.height = `${total}px`;
    const max = Math.max(0, total - viewH);
    let top: number;
    if (this.pinned) top = max;
    else if (this.anchor) {
      const index = this.anchorIndex();
      top = index < 0 ? 0 : this.offsets[index]! + this.anchor.delta + this.insetTop;
    } else top = this.viewport.scrollTop || 0;
    top = Math.min(max, Math.max(0, top));
    if (Math.abs((this.viewport.scrollTop || 0) - top) > 0.5) this.viewport.scrollTop = top;
    return top;
  }

  private paint(top: number, viewH: number): boolean {
    const n = this.keys.length;
    const next = new Map<unknown, Slot>();
    const ordered: HTMLElement[] = [];
    let start = 0;
    let end = 0;
    if (n > 0) {
      const y = top - this.insetTop;
      start = this.indexAt(Math.max(0, y - this.overscan));
      end = Math.min(n, this.indexAt(y + viewH + this.overscan) + 1);
    }
    const wanted = new Set<unknown>();
    for (let i = start; i < end; i++) wanted.add(this.keys[i]);
    for (const [key, slot] of this.slots) {
      if (wanted.has(key)) continue;
      this.release(slot);
      this.slots.delete(key);
    }
    for (let i = start; i < end; i++) {
      const key = this.keys[i];
      const type = this.source.type(i);
      let slot = this.slots.get(key);
      if (slot && slot.type === type) {
        this.slots.delete(key);
        if (slot.version !== this.versions[i]) {
          this.source.bind(slot.el, i);
          slot.version = this.versions[i]!;
        }
      } else {
        if (slot) {
          this.release(slot);
          this.slots.delete(key);
        }
        const el = this.pools.get(type)?.pop() ?? this.source.create(type);
        this.source.bind(el, i);
        slot = { el, type, version: this.versions[i]! };
      }
      next.set(key, slot);
      ordered.push(slot.el);
    }
    for (const slot of this.slots.values()) this.release(slot);
    this.slots = next;
    let cursor = this.window.firstElementChild;
    for (const el of ordered) {
      if (el === cursor) cursor = cursor.nextElementSibling;
      else this.window.insertBefore(el, cursor);
    }
    this.window.style.transform = `translateY(${this.insetTop + (this.offsets[start] ?? 0)}px)`;
    if (this.options.rowHeight) return false;
    let changed = false;
    for (let i = start; i < end; i++) {
      const measured = ordered[i - start]!.offsetHeight;
      if (typeof measured !== "number" || !(measured > 0)) continue;
      if (Math.abs(measured - this.heights[i]!) > 0.5) {
        this.heights[i] = measured;
        changed = true;
      }
    }
    return changed;
  }

  private release(slot: Slot): void {
    slot.el.remove();
    let pool = this.pools.get(slot.type);
    if (!pool) {
      pool = [];
      this.pools.set(slot.type, pool);
    }
    if (pool.length < POOL_LIMIT) pool.push(slot.el);
  }

  private captureAnchor(top: number): void {
    const n = this.keys.length;
    const y = top - this.insetTop;
    if (this.pinned || n === 0 || y <= 0) {
      this.anchor = null;
      return;
    }
    const index = this.indexAt(y);
    this.anchor = { key: this.keys[index], index, delta: y - this.offsets[index]! };
  }

  private anchorIndex(): number {
    const anchor = this.anchor!;
    if (this.keys[anchor.index] === anchor.key) return anchor.index;
    anchor.index = this.keys.indexOf(anchor.key);
    return anchor.index;
  }

  private indexAt(y: number): number {
    const n = this.keys.length;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid]! <= y) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  private totalHeight(): number {
    return this.offsets[this.offsets.length - 1]! + this.insetTop + this.insetBottom;
  }

  private viewportHeight(): number {
    const height = this.viewport.clientHeight;
    return typeof height === "number" && height > 0 ? height : FALLBACK_VIEWPORT;
  }

  private contentWidth(): number {
    const width = this.sizer.clientWidth;
    return typeof width === "number" && width > 0 ? width : 0;
  }
}
