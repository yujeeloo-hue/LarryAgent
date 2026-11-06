const SHOW_DISTANCE_PX = 64;
const HIDE_DISTANCE_PX = 32;
const TAIL_GAP_PX = 24;
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

  shouldShowButton(following: boolean): boolean {
    if (this.disposed) return false;
    let distance = 0;
    if (this.scroller.clientHeight > 0) {
      const viewport = this.scroller.getBoundingClientRect();
      const overlay = this.overlay.getBoundingClientRect();
      const bottom = viewport.top + this.scroller.clientTop + this.scroller.clientHeight;
      const visibleBottom = overlay.height > 0 ? Math.min(bottom, overlay.top) : bottom;
      for (const element of this.content) {
        const rect = element.getBoundingClientRect();
        if (rect.height > 0) distance = Math.max(distance, rect.bottom - visibleBottom);
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
