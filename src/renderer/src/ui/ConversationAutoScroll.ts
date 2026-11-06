/** Shared by the desktop transcript and the Relay console. */
export const CONVERSATION_SCROLL_INTENT = "conversation-scroll-intent";

const BOTTOM_EPSILON = 2;
/**
 * A paused reader resumes once they are back within this distance of the
 * bottom (matches the jump-to-bottom button's hide distance). Landing exact
 * is not a requirement: wheel/momentum quantization and subpixel heights
 * routinely stop a few pixels short, and a stranded near-bottom reader is
 * exactly the "why did it stop following" report.
 */
const RESUME_EPSILON_PX = 32;
/** Keys whose default action scrolls the transcript toward newer content. */
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

/**
 * Following is user intent, never inferred from geometry after a repaint.
 * A paused reader resumes by scrolling the transcript back to its bottom
 * at the bottom (or within RESUME_EPSILON_PX of it) — including a downward
 * nudge while already sitting there, so wheel momentum tails and key repeats
 * landing at the bottom can never strand the reader in a paused state. A
 * nested scrollport pauses the same state and cannot resume it, except one
 * parked at its own bottom: the gesture scroll-chains outward, so a
 * downward nudge there counts as the same return-to-bottom request.
 */
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

  /** Close enough to the bottom that a downward nudge means "keep following". */
  private nearBottom(): boolean {
    return this.maxTop() - this.scroller.scrollTop <= RESUME_EPSILON_PX;
  }

  /**
   * Whether a downward input over `target` reaches the outer transcript
   * rather than an inner scrollport (diff/code/reasoning cards). A nested
   * scroller with room left downward consumes the gesture; one parked at
   * its own bottom scroll-chains outward — streaming write/patch previews
   * are auto-pinned there, so momentum tails over them must count as
   * follow intent, else they cancel the chase and strand a bottomed
   * reader in a paused state (no scroll event ever fires to resume).
   */
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
          // Parked at its own bottom: the gesture chains to the next port.
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

  /** Also used when restoring a paused transcript after a snapshot rebuild. */
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

  /** Resize padding without leaving a gap underneath the floating composer. */
  snapIfFollowing(): void {
    if (!this.enabled || this.disposed) return;
    this.scroller.scrollTop = this.maxTop();
    this.onChange();
  }

  /** Restore layout/paging offsets without treating them as user scrolling. */
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
    // Chromium rounds offsets to device pixels; snap before the eased step
    // rounds to zero and leaves a permanent gap / animation at the bottom.
    this.scroller.scrollTop = remaining <= BOTTOM_EPSILON
      ? target
      : this.scroller.scrollTop + remaining * EASE;
    this.onChange();
    if (remaining > 1.5) this.frame = requestFrame(this.tick);
  };

  private onScrollIntent = (): void => {
    this.pause();
    // Remember the *actual* offset after canceling the chase. Queued scroll
    // events from that chase must not count as a manual return to the bottom.
    this.lastTop = this.scroller.scrollTop;
    this.manualScroll = true;
  };

  private onWheel = (event: WheelEvent): void => {
    if (!event.deltaX && !event.deltaY) return;
    // A downward wheel while paused (or just resumed) at the bottom is a
    // follow request, and momentum tails keep firing wheel events after the
    // scroller clamps at the bottom — those must not re-pause the follow.
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
    // Same bottom rule as wheels: a downward drag while at the bottom is a
    // follow request (finger-drag flicks generate no scroll events once
    // clamped, so the scroll-landing resume cannot cover this).
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
    // Include the narrow edge used by native overlay scrollbars, which do
    // not reserve a layout gutter. Card toggles and prose clicks stay active.
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
    // Held-down keys repeat at the bottom without producing scroll events;
    // treat the repeats as the follow request they express.
    if (DOWN_KEYS.has(event.key) && this.nearBottom()) {
      this.follow();
      return;
    }
    this.onScrollIntent();
  };

  private onScroll = (event: Event): void => {
    if (event.target !== this.scroller) return;
    const top = this.scroller.scrollTop;
    // A single thumb drag may reach the bottom and then move upward again.
    if (this.draggingScrollbar && top < this.lastTop) this.onScrollIntent();
    // Only downward movement of the outer transcript can resume following.
    // Nested scrolls, layout clamping and programmatic events cannot unpause it.
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
