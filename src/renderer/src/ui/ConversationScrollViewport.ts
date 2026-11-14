const SHOW_DISTANCE_PX = 64;
const HIDE_DISTANCE_PX = 32;
const TAIL_GAP_PX = 24;
/** Sub-pixel/rounding slack for the fully-visible row test. */
const VISIBILITY_EPSILON_PX = 2;
const CLEARANCE_PROPERTY = "--conversation-composer-clearance";

/** Actual transcript visibility above an overlay containing composer, queue
 * and approvals. Shared by the desktop client and Relay. Follow intent stays
 * in ConversationAutoScroll; spare bottom padding is never unread content. */
export class ConversationScrollViewport {
  private readonly content: readonly HTMLElement[];
  private readonly observer: ResizeObserver | null;
  private shown = false;
  private disposed = false;

  constructor(
    private readonly scroller: HTMLElement,
    content: HTMLElement | readonly HTMLElement[],
    private readonly overlay: HTMLElement,
    private readonly onResize: () => void,
  ) {
    this.content = Array.isArray(content) ? content : [content];
    this.observer = typeof ResizeObserver === "undefined" ? null :
      new ResizeObserver(() => this.refresh());
    this.observer?.observe(overlay);
    this.observer?.observe(scroller);
  }

  /** Border-box observations include queue folds, textarea growth, mobile
   * composer morphs and keyboard/viewport resizing. Resize padding first,
   * then let the owner preserve following or the paused reader's position. */
  refresh(): void {
    if (this.disposed || !this.scroller.isConnected) return;
    const height = this.overlay.getBoundingClientRect().height;
    if (height <= 0) return;
    const next = `${Math.ceil(height + TAIL_GAP_PX)}px`;
    if (this.scroller.style.getPropertyValue(CLEARANCE_PROPERTY) !== next) {
      this.scroller.style.setProperty(CLEARANCE_PROPERTY, next);
    }
    this.onResize();
  }

  /** Content-space band the reader can actually see: the scrollport's bottom
   * edge further clipped by the overlay covering it. Null when unmeasurable. */
  private visibleBounds(): { top: number; bottom: number } | null {
    if (this.disposed || this.scroller.clientHeight <= 0) return null;
    const viewport = this.scroller.getBoundingClientRect();
    const top = viewport.top + this.scroller.clientTop;
    const bottom = top + this.scroller.clientHeight;
    const overlay = this.overlay.getBoundingClientRect();
    return { top, bottom: overlay.height > 0 ? Math.min(bottom, overlay.top) : bottom };
  }

  /** True when every pixel of `element` sits inside the visible band — a row
   * hidden behind the composer or below the fold counts as unseen. */
  isFullyVisible(element: HTMLElement): boolean {
    const bounds = this.visibleBounds();
    if (!bounds) return false;
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0) return false;
    return (
      rect.top >= bounds.top - VISIBILITY_EPSILON_PX &&
      rect.bottom <= bounds.bottom + VISIBILITY_EPSILON_PX
    );
  }

  shouldShowButton(following: boolean): boolean {
    if (this.disposed) return false;
    let distance = 0;
    const bounds = this.visibleBounds();
    if (bounds) {
      for (const element of this.content) {
        const rect = element.getBoundingClientRect();
        if (rect.height > 0) distance = Math.max(distance, rect.bottom - bounds.bottom);
      }
    }
    // Live following already brings new content into view. Neither its eased
    // chase nor a nested card pausing follow should flash a redundant button.
    this.shown = !following && distance > (this.shown ? HIDE_DISTANCE_PX : SHOW_DISTANCE_PX);
    return this.shown;
  }

  destroy(): void {
    this.disposed = true;
    this.observer?.disconnect();
  }
}
