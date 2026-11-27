const SHOW_DISTANCE_PX = 64;
const HIDE_DISTANCE_PX = 32;
const TAIL_GAP_PX = 24;
const VISIBILITY_EPSILON_PX = 2;
const CLEARANCE_PROPERTY = "--conversation-composer-clearance";

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

  private visibleBounds(): { top: number; bottom: number } | null {
    if (this.disposed || this.scroller.clientHeight <= 0) return null;
    const viewport = this.scroller.getBoundingClientRect();
    const top = viewport.top + this.scroller.clientTop;
    const bottom = top + this.scroller.clientHeight;
    const overlay = this.overlay.getBoundingClientRect();
    return { top, bottom: overlay.height > 0 ? Math.min(bottom, overlay.top) : bottom };
  }

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
    this.shown = !following && distance > (this.shown ? HIDE_DISTANCE_PX : SHOW_DISTANCE_PX);
    return this.shown;
  }

  destroy(): void {
    this.disposed = true;
    this.observer?.disconnect();
  }
}
