const WIDTH_KEY = "jellybot.devmode.buildProblemsWidth";
const HEIGHT_KEY = "jellybot.devmode.buildProblemsHeight";
export const DEFAULT_BUILD_PROBLEMS_WIDTH = 252;
export const DEFAULT_BUILD_PROBLEMS_HEIGHT = 168;
const MIN_SIZE = 148;
const MIN_OUTPUT = 160;
const MAX_RATIO = 0.72;
const STEP = 16;
const STEP_LARGE = 48;

export type BuildProblemsAxis = "x" | "y";

function readStored(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, px: number): void {
  try {
    localStorage.setItem(key, String(Math.round(px)));
  } catch {
  }
}

export class BuildProblemsResizeController {
  readonly handle = document.createElement("div");
  private container: HTMLElement | null = null;
  private pane: HTMLElement | null = null;
  private width = readStored(WIDTH_KEY, DEFAULT_BUILD_PROBLEMS_WIDTH);
  private height = readStored(HEIGHT_KEY, DEFAULT_BUILD_PROBLEMS_HEIGHT);
  private drag: {
    id: number;
    axis: BuildProblemsAxis;
    origin: number;
    size: number;
    desired: number;
  } | null = null;
  private observer: ResizeObserver | null = null;
  private lastAxis: BuildProblemsAxis = "x";

  constructor() {
    this.handle.className = "devmode-build-problems-resize";
    this.handle.setAttribute("role", "separator");
    this.handle.setAttribute("aria-orientation", "vertical");
    this.handle.setAttribute("aria-label", "Resize problems");
    this.handle.title = "Drag to resize · Double-click to reset";
    this.handle.tabIndex = 0;
  }

  mount(container: HTMLElement, pane: HTMLElement): void {
    this.container = container;
    this.pane = pane;
    this.handle.addEventListener("pointerdown", this.pointerDown);
    this.handle.addEventListener("keydown", this.keyDown);
    this.handle.addEventListener("dblclick", this.reset);
    this.handle.addEventListener("lostpointercapture", this.pointerUp);
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.sync());
      this.observer.observe(container);
    }
    this.sync();
  }

  destroy(): void {
    if (this.drag) this.finishDrag(this.drag.id);
    this.observer?.disconnect();
    this.observer = null;
    this.handle.removeEventListener("pointerdown", this.pointerDown);
    this.handle.removeEventListener("keydown", this.keyDown);
    this.handle.removeEventListener("dblclick", this.reset);
    this.handle.removeEventListener("lostpointercapture", this.pointerUp);
    this.handle.remove();
  }

  sync(): void {
    this.paint(this.preferred(this.axis()), false);
  }

  private axis(): BuildProblemsAxis {
    const rect = this.handle.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.lastAxis = rect.width > rect.height ? "y" : "x";
    }
    return this.lastAxis;
  }

  private preferred(axis: BuildProblemsAxis): number {
    return axis === "x" ? this.width : this.height;
  }

  private rendered(axis: BuildProblemsAxis): number {
    const rect = this.pane?.getBoundingClientRect();
    const size = rect ? (axis === "x" ? rect.width : rect.height) : 0;
    return size > 0 ? size : this.preferred(axis);
  }

  private bounds(axis: BuildProblemsAxis): { min: number; max: number } {
    const rect = this.container?.getBoundingClientRect();
    const extent = (axis === "x" ? rect?.width : rect?.height) ?? 0;
    if (!(extent > 0)) {
      return { min: MIN_SIZE, max: axis === "x" ? 960 : 480 };
    }
    const max = Math.max(
      MIN_SIZE,
      Math.min(Math.round(extent * MAX_RATIO), Math.round(extent - MIN_OUTPUT)),
    );
    return { min: Math.min(MIN_SIZE, max), max };
  }

  private paint(px: number, commit: boolean, axis = this.axis()): void {
    const { min, max } = this.bounds(axis);
    const size = Math.min(max, Math.max(min, Math.round(px)));
    this.pane?.style.setProperty("--devmode-build-problems-size", `${size}px`);
    if (commit) {
      if (axis === "x") {
        this.width = size;
        store(WIDTH_KEY, size);
      } else {
        this.height = size;
        store(HEIGHT_KEY, size);
      }
    }
    this.syncAria(axis, size, min, max);
  }

  private syncAria(
    axis: BuildProblemsAxis,
    size: number,
    min: number,
    max: number,
  ): void {
    this.handle.setAttribute(
      "aria-orientation",
      axis === "x" ? "vertical" : "horizontal",
    );
    this.handle.setAttribute("aria-valuemin", String(min));
    this.handle.setAttribute("aria-valuemax", String(max));
    this.handle.setAttribute("aria-valuenow", String(size));
    this.handle.setAttribute("aria-valuetext", `${size} pixels`);
  }

  private pointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const axis = this.axis();
    const size = this.rendered(axis);
    this.drag = {
      id: event.pointerId,
      axis,
      origin: axis === "x" ? event.clientX : event.clientY,
      size,
      desired: size,
    };
    this.pane?.classList.add("is-resizing");
    this.pane?.style.setProperty(
      "cursor",
      axis === "x" ? "col-resize" : "row-resize",
    );
    this.handle.classList.add("is-dragging");
    try {
      this.handle.setPointerCapture(event.pointerId);
    } catch {
    }
    window.addEventListener("pointermove", this.pointerMove);
    window.addEventListener("pointerup", this.pointerUp);
    window.addEventListener("pointercancel", this.pointerUp);
  };

  private pointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    const position = drag.axis === "x" ? event.clientX : event.clientY;
    drag.desired = drag.size + (position - drag.origin);
    this.paint(drag.desired, false, drag.axis);
  };

  private pointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id) return;
    this.paint(drag.desired, true, drag.axis);
    this.finishDrag(drag.id);
  };

  private finishDrag(pointerId: number): void {
    if (!this.drag) return;
    this.drag = null;
    this.pane?.classList.remove("is-resizing");
    this.pane?.style.removeProperty("cursor");
    this.handle.classList.remove("is-dragging");
    window.removeEventListener("pointermove", this.pointerMove);
    window.removeEventListener("pointerup", this.pointerUp);
    window.removeEventListener("pointercancel", this.pointerUp);
    try {
      this.handle.releasePointerCapture(pointerId);
    } catch {
    }
  }

  private keyDown = (event: KeyboardEvent): void => {
    const axis = this.axis();
    const step = event.shiftKey ? STEP_LARGE : STEP;
    const shrink = axis === "x" ? "ArrowLeft" : "ArrowUp";
    const grow = axis === "x" ? "ArrowRight" : "ArrowDown";
    const size = this.rendered(axis);
    if (event.key === shrink) this.paint(size - step, true, axis);
    else if (event.key === grow) this.paint(size + step, true, axis);
    else if (event.key === "Home") this.paint(this.bounds(axis).min, true, axis);
    else if (event.key === "End") this.paint(this.bounds(axis).max, true, axis);
    else if (event.key === "Enter" || event.key === " ") this.reset();
    else return;
    event.preventDefault();
  };

  private reset = (): void => {
    const axis = this.axis();
    this.paint(
      axis === "x" ? DEFAULT_BUILD_PROBLEMS_WIDTH : DEFAULT_BUILD_PROBLEMS_HEIGHT,
      true,
      axis,
    );
  };
}
