/** Sidebar ↔ main column resize (Detail shell). */

const STORAGE_KEY = "jellybot.sidebarWidth";
const DEFAULT_WIDTH = 305;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

function clampWidth(px: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(px)));
}

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_WIDTH;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_WIDTH;
    return clampWidth(n);
  } catch {
    return DEFAULT_WIDTH;
  }
}

function writeStoredWidth(px: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(clampWidth(px)));
  } catch {
    // ignore quota / private mode
  }
}

export type SidebarResizeHost = {
  root: HTMLElement;
  resizeHandle: HTMLElement;
  setSidebarWidth(px: number): void;
  setResizeDragging(dragging: boolean): void;
};

/**
 * Pointer-drag + keyboard resize for the shell sidebar.
 */
export class SidebarResizeController {
  private width = DEFAULT_WIDTH;
  private dragging = false;
  private startX = 0;
  private startWidth = 0;
  private readonly onPointerMove: (event: PointerEvent) => void;
  private readonly onPointerUp: (event: PointerEvent) => void;

  constructor(private readonly view: SidebarResizeHost) {
    this.onPointerMove = (event) => this.handlePointerMove(event);
    this.onPointerUp = (event) => this.handlePointerUp(event);
  }

  mount(): void {
    this.width = readStoredWidth();
    this.view.setSidebarWidth(this.width);
    this.view.resizeHandle.setAttribute("aria-valuemin", String(MIN_WIDTH));
    this.view.resizeHandle.setAttribute("aria-valuemax", String(MAX_WIDTH));

    this.view.resizeHandle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.dragging = true;
      this.startX = event.clientX;
      this.startWidth = this.width;
      this.view.setResizeDragging(true);
      this.view.resizeHandle.setPointerCapture(event.pointerId);
      window.addEventListener("pointermove", this.onPointerMove);
      window.addEventListener("pointerup", this.onPointerUp);
      window.addEventListener("pointercancel", this.onPointerUp);
    });

    this.view.resizeHandle.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 24 : 8;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        this.applyWidth(this.width - step, true);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        this.applyWidth(this.width + step, true);
      } else if (event.key === "Home") {
        event.preventDefault();
        this.applyWidth(MIN_WIDTH, true);
      } else if (event.key === "End") {
        event.preventDefault();
        this.applyWidth(MAX_WIDTH, true);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.applyWidth(DEFAULT_WIDTH, true);
      }
    });

    this.view.resizeHandle.addEventListener("dblclick", () => {
      this.applyWidth(DEFAULT_WIDTH, true);
    });
  }

  destroy(): void {
    this.teardownDrag();
  }

  private handlePointerMove(event: PointerEvent): void {
    if (!this.dragging) return;
    const next = this.startWidth + (event.clientX - this.startX);
    this.applyWidth(next, false);
  }

  private handlePointerUp(event: PointerEvent): void {
    if (!this.dragging) return;
    try {
      this.view.resizeHandle.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
    this.teardownDrag();
    writeStoredWidth(this.width);
  }

  private teardownDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.view.setResizeDragging(false);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
  }

  private applyWidth(px: number, persist: boolean): void {
    this.width = clampWidth(px);
    this.view.setSidebarWidth(this.width);
    if (persist) writeStoredWidth(this.width);
  }
}
