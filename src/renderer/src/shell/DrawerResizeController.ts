/** Detail drawer vertical resize (main column ↔ drawer). */

const STORAGE_KEY = "jellybot.detailDrawerRatio";
const DEFAULT_RATIO = 0.5;
const MIN_RATIO = 0.18;
const MAX_RATIO = 0.75;

function clampRatio(ratio: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

function readStoredRatio(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_RATIO;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_RATIO;
    return clampRatio(n);
  } catch {
    return DEFAULT_RATIO;
  }
}

function writeStoredRatio(ratio: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(clampRatio(ratio)));
  } catch {
    // ignore
  }
}

export type DrawerResizeHost = {
  root: HTMLElement;
  mainColumn: HTMLElement;
  drawerResizeHandle: HTMLElement;
  setDrawerHeightRatio(ratio: number): void;
  setDrawerResizeDragging(dragging: boolean): void;
};

/**
 * Pointer-drag + keyboard resize for the Detail bottom drawer.
 * Dragging the top edge up grows the drawer; down shrinks it.
 */
export class DrawerResizeController {
  private ratio = DEFAULT_RATIO;
  private dragging = false;
  private startY = 0;
  private startRatio = 0;
  private readonly onPointerMove: (event: PointerEvent) => void;
  private readonly onPointerUp: (event: PointerEvent) => void;

  constructor(private readonly view: DrawerResizeHost) {
    this.onPointerMove = (event) => this.handlePointerMove(event);
    this.onPointerUp = (event) => this.handlePointerUp(event);
  }

  mount(): void {
    this.ratio = readStoredRatio();
    this.view.setDrawerHeightRatio(this.ratio);
    this.view.drawerResizeHandle.setAttribute(
      "aria-valuemin",
      String(Math.round(MIN_RATIO * 100)),
    );
    this.view.drawerResizeHandle.setAttribute(
      "aria-valuemax",
      String(Math.round(MAX_RATIO * 100)),
    );

    this.view.drawerResizeHandle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (this.view.drawerResizeHandle.hidden) return;
      event.preventDefault();
      this.dragging = true;
      this.startY = event.clientY;
      this.startRatio = this.ratio;
      this.view.setDrawerResizeDragging(true);
      this.view.drawerResizeHandle.setPointerCapture(event.pointerId);
      window.addEventListener("pointermove", this.onPointerMove);
      window.addEventListener("pointerup", this.onPointerUp);
      window.addEventListener("pointercancel", this.onPointerUp);
    });

    this.view.drawerResizeHandle.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 0.05 : 0.02;
      if (event.key === "ArrowUp") {
        event.preventDefault();
        this.applyRatio(this.ratio + step, true);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        this.applyRatio(this.ratio - step, true);
      } else if (event.key === "Home") {
        event.preventDefault();
        this.applyRatio(MIN_RATIO, true);
      } else if (event.key === "End") {
        event.preventDefault();
        this.applyRatio(MAX_RATIO, true);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.applyRatio(DEFAULT_RATIO, true);
      }
    });

    this.view.drawerResizeHandle.addEventListener("dblclick", () => {
      this.applyRatio(DEFAULT_RATIO, true);
    });
  }

  destroy(): void {
    this.teardownDrag();
  }

  private columnHeight(): number {
    return Math.max(1, this.view.mainColumn.getBoundingClientRect().height);
  }

  private handlePointerMove(event: PointerEvent): void {
    if (!this.dragging) return;
    const colH = this.columnHeight();
    // Dragging up (smaller Y) increases drawer height.
    const deltaRatio = (this.startY - event.clientY) / colH;
    this.applyRatio(this.startRatio + deltaRatio, false);
  }

  private handlePointerUp(event: PointerEvent): void {
    if (!this.dragging) return;
    try {
      this.view.drawerResizeHandle.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
    this.teardownDrag();
    writeStoredRatio(this.ratio);
  }

  private teardownDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.view.setDrawerResizeDragging(false);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
  }

  private applyRatio(ratio: number, persist: boolean): void {
    this.ratio = clampRatio(ratio);
    this.view.setDrawerHeightRatio(this.ratio);
    if (persist) writeStoredRatio(this.ratio);
  }

  /** Current drawer height in px (ratio × main column height). */
  getDrawerHeightPx(): number {
    return this.ratio * this.columnHeight();
  }

  /**
   * Toggle the drawer between two pixel heights (Timeline compact ↔ tall).
   * The height closer to the current one flips to the other, so repeated
   * clicks cycle 218 → 405 → 218…; the CSS flex-basis transition glides.
   */
  toggleHeightPx(shortPx: number, tallPx: number): void {
    const colH = this.columnHeight();
    const current = this.ratio * colH;
    const targetPx =
      Math.abs(current - shortPx) < Math.abs(current - tallPx)
        ? tallPx
        : shortPx;
    this.applyRatio(targetPx / colH, true);
  }

  /** Grow the drawer to `px` when currently shorter (no-op otherwise). */
  ensureHeightPx(px: number): void {
    const colH = this.columnHeight();
    if (this.ratio * colH < px) this.applyRatio(px / colH, true);
  }
}
