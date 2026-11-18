export const CONVERSATION_SCROLL_INTENT = "conversation-scroll-intent";

const BOTTOM_EPSILON = 2;
const RESUME_EPSILON_PX = 32;
const DOWN_KEYS = new Set(["ArrowDown", "PageDown", "End", " "]);
const EASE = 0.22;

function requestFrame(callback: () => void): number {
  return typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : setTimeout(callback, 16) as unknown as number;
}

function cancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  else clearTimeout(id);
}

export class ConversationAutoScroll {
  private enabled: boolean;
  private frame: number | null = null;
  private observer: ResizeObserver | null = null;
  private disposed = false;
  private manualScroll = false;
  private draggingScrollbar = false;
  private lastTop = 0;

  constructor(
    private readonly scroller: HTMLElement,
    content: HTMLElement | readonly HTMLElement[],
    private readonly onChange: () => void = () => {},
    following = true,
  ) {
    this.enabled = following;
    this.lastTop = scroller.scrollTop;
    scroller.addEventListener("wheel", this.onWheel, { capture: true, passive: true });
    scroller.addEventListener("touchmove", this.onTouchMove, { capture: true, passive: true });
    scroller.addEventListener("pointerdown", this.onPointerDown, true);
    scroller.addEventListener("keydown", this.onKeyDown, true);
    scroller.addEventListener("scroll", this.onScroll, true);
    scroller.addEventListener(CONVERSATION_SCROLL_INTENT, this.onScrollIntent);
    scroller.ownerDocument.addEventListener("pointerup", this.onPointerUp, true);
    scroller.ownerDocument.addEventListener("pointercancel", this.onPointerUp, true);
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.contentChanged());
      this.observer.observe(scroller);
      for (const element of Array.isArray(content) ? content : [content]) {
        this.observer.observe(element);
      }
    }
  }

  get following(): boolean { return this.enabled; }

  isAtBottom(): boolean {
    return this.maxTop() - this.scroller.scrollTop <= BOTTOM_EPSILON;
  }

  private nearBottom(): boolean {
    return this.maxTop() - this.scroller.scrollTop <= RESUME_EPSILON_PX;
  }

  private targetScrollsOuter(target: EventTarget | null): boolean {
    let node = target as Element | null;
    while (node && node !== this.scroller) {
      if (typeof getComputedStyle === "function") {
        const style = getComputedStyle(node);
        if (
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          node.scrollHeight > node.clientHeight
        ) {
          const top = typeof node.scrollTop === "number" ? node.scrollTop : 0;
          if (node.scrollHeight - node.clientHeight - top > BOTTOM_EPSILON) {
            return false;
          }
        }
      }
      node = node.parentElement;
    }
    return node === this.scroller;
  }

  private maxTop(): number {
    return Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight);
  }

  follow(): void {
    if (this.disposed) return;
    this.enabled = true;
    this.manualScroll = false;
    this.contentChanged();
  }

  pause(): void {
    this.enabled = false;
    this.manualScroll = false;
    if (this.frame !== null) cancelFrame(this.frame);
    this.frame = null;
    this.onChange();
  }

  contentChanged(): void {
    if (this.disposed) return;
    this.onChange();
    if (!this.enabled || this.frame !== null) return;
    this.frame = requestFrame(this.tick);
  }

  snapIfFollowing(): void {
    if (!this.enabled || this.disposed) return;
    this.scroller.scrollTop = this.maxTop();
    this.onChange();
  }

  restoreTop(top: number): void {
    this.manualScroll = false;
    this.scroller.scrollTop = top;
    this.lastTop = this.scroller.scrollTop;
    this.onChange();
  }

  private tick = (): void => {
    this.frame = null;
    if (!this.enabled || this.disposed) return;
    const target = this.maxTop();
    const remaining = target - this.scroller.scrollTop;
    this.scroller.scrollTop = remaining <= BOTTOM_EPSILON
      ? target
      : this.scroller.scrollTop + remaining * EASE;
    this.onChange();
    if (remaining > 1.5) this.frame = requestFrame(this.tick);
  };

  private onScrollIntent = (): void => {
    this.pause();
    this.lastTop = this.scroller.scrollTop;
    this.manualScroll = true;
  };

  private onWheel = (event: WheelEvent): void => {
    if (!event.deltaX && !event.deltaY) return;
    if (
      !event.deltaX &&
      event.deltaY > 0 &&
      this.targetScrollsOuter(event.target) &&
      this.nearBottom()
    ) {
      this.follow();
      return;
    }
    this.onScrollIntent();
  };

  private lastTouchY: number | null = null;

  private onTouchMove = (event: TouchEvent): void => {
    const touch = event.touches?.[0];
    const y = touch && typeof touch.clientY === "number" ? touch.clientY : null;
    const downward = this.lastTouchY !== null && y !== null && y < this.lastTouchY;
    if (y !== null) this.lastTouchY = y;
    if (
      downward &&
      this.targetScrollsOuter(event.target) &&
      this.nearBottom()
    ) {
      this.follow();
      return;
    }
    this.onScrollIntent();
  };

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const element = event.target instanceof HTMLElement ? event.target : null;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const left = element.clientLeft;
    const top = element.clientTop;
    const vertical = element.scrollHeight > element.clientHeight &&
      (x < left || x >= left + element.clientWidth - 12);
    const horizontal = element.scrollWidth > element.clientWidth &&
      (y < top || y >= top + element.clientHeight - 12);
    if (vertical || horizontal) {
      this.draggingScrollbar = true;
      this.onScrollIntent();
    }
  };

  private onPointerUp = (): void => { this.draggingScrollbar = false; };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest("input, textarea, select, button, [contenteditable]:not([contenteditable='false'])")) return;
    if (DOWN_KEYS.has(event.key) && this.nearBottom()) {
      this.follow();
      return;
    }
    this.onScrollIntent();
  };

  private onScroll = (event: Event): void => {
    if (event.target !== this.scroller) return;
    const top = this.scroller.scrollTop;
    if (this.draggingScrollbar && top < this.lastTop) this.onScrollIntent();
    if (!this.enabled && this.manualScroll && top > this.lastTop && this.nearBottom()) {
      this.follow();
    }
    this.lastTop = top;
    this.onChange();
  };

  destroy(): void {
    this.disposed = true;
    if (this.frame !== null) cancelFrame(this.frame);
    this.frame = null;
    this.observer?.disconnect();
    this.scroller.removeEventListener("wheel", this.onWheel, true);
    this.scroller.removeEventListener("touchmove", this.onTouchMove, true);
    this.scroller.removeEventListener("pointerdown", this.onPointerDown, true);
    this.scroller.removeEventListener("keydown", this.onKeyDown, true);
    this.scroller.removeEventListener("scroll", this.onScroll, true);
    this.scroller.removeEventListener(CONVERSATION_SCROLL_INTENT, this.onScrollIntent);
    this.scroller.ownerDocument.removeEventListener("pointerup", this.onPointerUp, true);
    this.scroller.ownerDocument.removeEventListener("pointercancel", this.onPointerUp, true);
  }
}
