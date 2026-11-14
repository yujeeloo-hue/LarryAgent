const STORAGE_KEY = "jellybot.cocoChatWidth";
export const DEFAULT_COCO_CHAT_WIDTH = 400;
const MIN_WIDTH = 220;
const MAX_WIDTH = 720;

export function cocoChatWidthBounds(workspaceWidth: number): { min: number; max: number } {
  if (workspaceWidth <= 0) return { min: MIN_WIDTH, max: MAX_WIDTH };
  const docked = workspaceWidth > 900;
  const available = docked ? workspaceWidth - 154 - 280 - 16 : workspaceWidth - (workspaceWidth <= 500 ? 75 : 164);
  const max = Math.max(0, Math.min(MAX_WIDTH, Math.round(available)));
  return { min: Math.min(docked ? 280 : MIN_WIDTH, max), max };
}
const clamp = (width: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(width)));
function storedWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && Number.isFinite(Number(raw))) return clamp(Number(raw), MIN_WIDTH, MAX_WIDTH);
  } catch { /* Storage may be unavailable. */ }
  return DEFAULT_COCO_CHAT_WIDTH;
}

/** Left-edge resizing for the right-hand chat; keeps the preferred width across navigation. */
export class CocoChatResizeController {
  readonly handle = document.createElement("div");
  private width = storedWidth();
  private pointer: { id: number; x: number; width: number } | undefined;
  private observer: ResizeObserver | undefined;

  constructor(private workspace: HTMLElement, private card: HTMLElement) {
    this.handle.className = "coco-chat-resize";
    this.handle.tabIndex = 0;
    this.handle.setAttribute("role", "separator");
    this.handle.setAttribute("aria-orientation", "vertical");
    this.handle.setAttribute("aria-label", "Resize CoCo chat");
    this.handle.title = "Drag to resize · Double-click to reset";
  }
  mount(): void {
    this.workspace.style.setProperty("--coco-chat-width", `${this.width}px`);
    this.card.prepend(this.handle);
    this.handle.addEventListener("pointerdown", this.pointerDown);
    this.handle.addEventListener("keydown", this.keyDown);
    this.handle.addEventListener("dblclick", this.reset);
    this.handle.addEventListener("lostpointercapture", this.pointerUp);
    this.observer = new ResizeObserver(() => this.syncAria());
    this.observer.observe(this.workspace);
    this.syncAria();
  }
  destroy(): void {
    this.cancelDrag(); this.observer?.disconnect();
    this.handle.removeEventListener("pointerdown", this.pointerDown);
    this.handle.removeEventListener("keydown", this.keyDown);
    this.handle.removeEventListener("dblclick", this.reset);
    this.handle.removeEventListener("lostpointercapture", this.pointerUp);
    this.handle.remove();
  }
  cancelDrag(): void { this.finish(false); }
  private bounds() { return cocoChatWidthBounds(this.workspace.getBoundingClientRect().width); }
  private currentWidth(): number {
    const bounds = this.bounds();
    return clamp(this.card.getBoundingClientRect().width || this.width, bounds.min, bounds.max);
  }
  private syncAria(): void {
    const bounds = this.bounds();
    this.handle.setAttribute("aria-valuemin", String(bounds.min));
    this.handle.setAttribute("aria-valuemax", String(bounds.max));
    this.handle.setAttribute("aria-valuenow", String(this.currentWidth()));
    this.handle.setAttribute("aria-valuetext", `${this.currentWidth()} pixels`);
    this.handle.hidden = bounds.max <= bounds.min;
  }
  private persist(): void {
    try { localStorage.setItem(STORAGE_KEY, String(this.width)); } catch { /* Keep the live width. */ }
  }
  private apply(width: number, persist: boolean): void {
    const bounds = this.bounds(), next = clamp(width, bounds.min, bounds.max);
    // A constrained panel cannot grow further; keep its wider saved preference.
    if (next === this.currentWidth() && next !== this.width) return;
    this.width = next;
    this.workspace.style.setProperty("--coco-chat-width", `${this.width}px`);
    this.syncAria(); if (persist) this.persist();
  }
  private reset = (): void => {
    this.width = DEFAULT_COCO_CHAT_WIDTH;
    this.workspace.style.setProperty("--coco-chat-width", `${this.width}px`);
    this.syncAria(); this.persist();
  };
  private keyDown = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? 24 : 8, bounds = this.bounds();
    if (event.key === "ArrowLeft") this.apply(this.currentWidth() + step, true);
    else if (event.key === "ArrowRight") this.apply(this.currentWidth() - step, true);
    else if (event.key === "Home") this.apply(bounds.min, true);
    else if (event.key === "End") this.apply(bounds.max, true);
    else if (event.key === "Enter" || event.key === " ") this.reset();
    else return;
    event.preventDefault();
  };
  private pointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.card.getBoundingClientRect().width || this.handle.hidden) return;
    event.preventDefault(); this.cancelDrag();
    this.pointer = { id: event.pointerId, x: event.clientX, width: this.currentWidth() };
    this.workspace.classList.add("is-chat-resizing");
    this.handle.setPointerCapture(event.pointerId);
    window.addEventListener("pointermove", this.pointerMove);
    window.addEventListener("pointerup", this.pointerUp);
    window.addEventListener("pointercancel", this.pointerUp);
    window.addEventListener("blur", this.blur);
  };
  private pointerMove = (event: PointerEvent): void => {
    if (!this.pointer || event.pointerId !== this.pointer.id) return;
    event.preventDefault(); this.apply(this.pointer.width + this.pointer.x - event.clientX, false);
  };
  private pointerUp = (event: PointerEvent): void => {
    if (this.pointer && event.pointerId === this.pointer.id) this.finish(true);
  };
  private blur = (): void => this.finish(true);
  private finish(persist: boolean): void {
    const pointer = this.pointer; if (!pointer) return; this.pointer = undefined;
    this.workspace.classList.remove("is-chat-resizing");
    window.removeEventListener("pointermove", this.pointerMove);
    window.removeEventListener("pointerup", this.pointerUp);
    window.removeEventListener("pointercancel", this.pointerUp);
    window.removeEventListener("blur", this.blur);
    try { this.handle.releasePointerCapture(pointer.id); } catch { /* Capture may already be gone. */ }
    if (persist) this.persist();
  }
}
