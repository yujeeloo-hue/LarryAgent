import "./dev-tools.css";
import {
  edgeArrowSegment,
  fitGraphInViewport,
  layoutFsmGraph,
  type FsmLayout,
} from "./fsmLayout.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const FIT_PADDING = 16;
const GRID_MINOR = 20;
const GRID_MAJOR = 100;
const DRAG_THRESHOLD_PX = 4;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
export const FSM_FOLLOW_RESUME_MS = 5000;
const CAM_EASE_MS = 260;

const EDGE_KINDS = ["forward", "back", "self", "cross"] as const;

export class FsmPaneView {
  readonly root: HTMLElement;
  readonly refreshButton: HTMLButtonElement;
  readonly zoomOutButton: HTMLButtonElement;
  readonly zoomInButton: HTMLButtonElement;
  readonly fitButton: HTMLButtonElement;
  private readonly statusEl: HTMLElement;
  private readonly zoomLabel: HTMLElement;
  private readonly legendEl: HTMLElement;
  private readonly viewportEl: HTMLElement;
  private readonly svgHost: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private worldEl: SVGGElement | null = null;
  private nodeEls = new Map<string, SVGGElement>();
  private activeNodeId = "";
  private layout: FsmLayout | null = null;
  private fitScale = 1;
  private userZoom = 1;
  private panX = 0;
  private panY = 0;
  private pendingFit = false;
  private keepFitted = true;
  private followPausedUntil = 0;
  private resizeObserver: ResizeObserver | null = null;
  private dragging = false;
  private didDrag = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragPanX = 0;
  private dragPanY = 0;
  private camAnimId = 0;
  private camFrom = { x: 0, y: 0, s: 1 };
  private camTo = { x: 0, y: 0, s: 1 };
  private camStartMs = 0;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "fsm-pane";

    const toolbar = document.createElement("div");
    toolbar.className = "fsm-pane-toolbar";

    this.statusEl = document.createElement("span");
    this.statusEl.className = "fsm-pane-status";
    this.statusEl.textContent = "";

    this.legendEl = document.createElement("div");
    this.legendEl.className = "fsm-legend";
    for (const kind of EDGE_KINDS) {
      const item = document.createElement("span");
      item.className = "fsm-legend-item";
      const dot = document.createElement("span");
      dot.className = `fsm-legend-dot fsm-kind-${kind}`;
      const label = document.createElement("span");
      label.className = "fsm-legend-label";
      label.textContent = kind === "self" ? "Self" : kind.charAt(0).toUpperCase() + kind.slice(1);
      item.append(dot, label);
      this.legendEl.append(item);
    }

    const actions = document.createElement("div");
    actions.className = "fsm-pane-toolbar-actions";

    const zoomGroup = document.createElement("div");
    zoomGroup.className = "fsm-zoom-group";

    this.zoomOutButton = document.createElement("button");
    this.zoomOutButton.type = "button";
    this.zoomOutButton.className = "fsm-zoom-btn";
    this.zoomOutButton.title = "Zoom out";
    this.zoomOutButton.setAttribute("aria-label", "Zoom out");
    this.zoomOutButton.textContent = "−";

    this.zoomLabel = document.createElement("span");
    this.zoomLabel.className = "fsm-zoom-label";
    this.zoomLabel.textContent = "100%";

    this.zoomInButton = document.createElement("button");
    this.zoomInButton.type = "button";
    this.zoomInButton.className = "fsm-zoom-btn";
    this.zoomInButton.title = "Zoom in";
    this.zoomInButton.setAttribute("aria-label", "Zoom in");
    this.zoomInButton.textContent = "+";

    zoomGroup.append(this.zoomOutButton, this.zoomLabel, this.zoomInButton);

    this.fitButton = document.createElement("button");
    this.fitButton.type = "button";
    this.fitButton.className = "fsm-zoom-btn fsm-zoom-fit";
    this.fitButton.title = "Reset zoom to fit";
    this.fitButton.setAttribute("aria-label", "Reset zoom to fit");
    this.fitButton.textContent = "Fit";

    this.refreshButton = document.createElement("button");
    this.refreshButton.type = "button";
    this.refreshButton.className = "fsm-pane-action";
    this.refreshButton.title = "Refresh";
    this.refreshButton.setAttribute("aria-label", "Refresh");
    this.refreshButton.textContent = "Refresh";

    actions.append(zoomGroup, this.fitButton, this.refreshButton);
    toolbar.append(this.statusEl, this.legendEl, actions);

    this.viewportEl = document.createElement("div");
    this.viewportEl.className = "fsm-pane-viewport";

    this.svgHost = document.createElement("div");
    this.svgHost.className = "fsm-pane-svg-host";
    this.svgHost.hidden = true;
    this.viewportEl.append(this.svgHost);

    this.emptyEl = document.createElement("div");
    this.emptyEl.className = "fsm-pane-empty";
    this.emptyEl.textContent = "Open a conversation to see its FSM graph.";
    this.viewportEl.append(this.emptyEl);

    this.root.append(toolbar, this.viewportEl);
    this.bindInteractions();
    this.resizeObserver = new ResizeObserver(() => {
      this.handleViewportResize();
    });
    this.resizeObserver.observe(this.viewportEl);
  }

  private bindInteractions(): void {
    this.zoomInButton.addEventListener("click", () => {
      this.zoomBy(1.2);
    });
    this.zoomOutButton.addEventListener("click", () => {
      this.zoomBy(1 / 1.2);
    });
    this.fitButton.addEventListener("click", () => {
      this.pauseFollow();
      this.fitToView();
    });

    this.viewportEl.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        this.pauseFollow();
        if (ev.metaKey || ev.ctrlKey) {
          const step = Math.exp(-ev.deltaY * 0.0022);
          this.zoomBy(step, ev.clientX, ev.clientY);
          return;
        }
        this.panX -= ev.deltaX;
        this.panY -= ev.deltaY;
        this.keepFitted = false;
        this.cancelCameraAnim();
        this.applyCamera();
      },
      { passive: false },
    );

    this.viewportEl.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      if ((ev.target as HTMLElement | null)?.closest("button")) return;
      ev.preventDefault();
      this.dragging = true;
      this.didDrag = false;
      this.cancelCameraAnim();
      this.dragStartX = ev.clientX;
      this.dragStartY = ev.clientY;
      this.dragPanX = this.panX;
      this.dragPanY = this.panY;
      this.viewportEl.setPointerCapture(ev.pointerId);
      this.viewportEl.classList.add("is-panning");
    });

    this.viewportEl.addEventListener("pointermove", (ev) => {
      if (!this.dragging) return;
      const dx = ev.clientX - this.dragStartX;
      const dy = ev.clientY - this.dragStartY;
      if (!this.didDrag && dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        return;
      }
      this.didDrag = true;
      this.pauseFollow();
      this.keepFitted = false;
      this.panX = this.dragPanX + dx;
      this.panY = this.dragPanY + dy;
      this.applyCamera();
    });

    const endDrag = (ev: PointerEvent): void => {
      if (!this.dragging) return;
      this.dragging = false;
      this.viewportEl.classList.remove("is-panning");
      if (this.viewportEl.hasPointerCapture(ev.pointerId)) {
        this.viewportEl.releasePointerCapture(ev.pointerId);
      }
      window.setTimeout(() => {
        this.didDrag = false;
      }, 0);
    };
    this.viewportEl.addEventListener("pointerup", endDrag);
    this.viewportEl.addEventListener("pointercancel", endDrag);
  }

  private pauseFollow(): void {
    this.followPausedUntil = Date.now() + FSM_FOLLOW_RESUME_MS;
  }

  resumeFollow(): void {
    this.followPausedUntil = 0;
  }


  private prefersReducedMotion(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  private cancelCameraAnim(): void {
    if (this.camAnimId !== 0) {
      cancelAnimationFrame(this.camAnimId);
      this.camAnimId = 0;
    }
  }

  private animateCamera(
    to: { panX: number; panY: number; scale: number },
    instant = false,
  ): void {
    const targetScale = Math.max(to.scale, 1e-6);
    const landInstantly = (): void => {
      this.cancelCameraAnim();
      this.userZoom = targetScale / this.fitScale;
      this.panX = to.panX;
      this.panY = to.panY;
      this.updateZoomLabel();
      this.applyCamera();
    };
    if (instant || this.prefersReducedMotion()) {
      landInstantly();
      return;
    }
    const dist = Math.hypot(to.panX - this.panX, to.panY - this.panY);
    const scaleDrift =
      Math.abs(targetScale - this.effectiveScale) /
      Math.max(this.effectiveScale, 1e-6);
    if (dist < 0.5 && scaleDrift < 0.005) {
      landInstantly();
      return;
    }
    this.camFrom = { x: this.panX, y: this.panY, s: this.effectiveScale };
    this.camTo = { x: to.panX, y: to.panY, s: targetScale };
    this.camStartMs = performance.now();
    if (this.camAnimId === 0) {
      this.camAnimId = requestAnimationFrame(this.stepCameraAnim);
    }
  }

  private stepCameraAnim = (now: number): void => {
    const t = Math.min(1, (now - this.camStartMs) / CAM_EASE_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    const from = this.camFrom;
    const to = this.camTo;
    this.panX = from.x + (to.x - from.x) * eased;
    this.panY = from.y + (to.y - from.y) * eased;
    const scale = from.s + (to.s - from.s) * eased;
    this.userZoom = scale / this.fitScale;
    this.updateZoomLabel();
    this.applyCamera();
    if (t < 1) {
      this.camAnimId = requestAnimationFrame(this.stepCameraAnim);
    } else {
      this.camAnimId = 0;
    }
  };

  private get effectiveScale(): number {
    return this.fitScale * this.userZoom;
  }

  private updateZoomLabel(): void {
    this.zoomLabel.textContent = `${Math.round(this.userZoom * 100)}%`;
  }

  private zoomBy(factor: number, anchorClientX?: number, anchorClientY?: number): void {
    const baseZoom =
      this.camAnimId !== 0 ? this.camTo.s / this.fitScale : this.userZoom;
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, baseZoom * factor));
    if (next === baseZoom) return;
    this.pauseFollow();
    this.keepFitted = false;
    const rect = this.viewportEl.getBoundingClientRect();
    const sx =
      anchorClientX !== undefined ? anchorClientX - rect.left : rect.width / 2;
    const sy =
      anchorClientY !== undefined ? anchorClientY - rect.top : rect.height / 2;
    const oldScale = this.effectiveScale;
    const newScale = this.fitScale * next;
    const worldX = (sx - this.panX) / oldScale;
    const worldY = (sy - this.panY) / oldScale;
    this.animateCamera({
      panX: sx - worldX * newScale,
      panY: sy - worldY * newScale,
      scale: newScale,
    });
  }

  private applyCamera(): void {
    const scale = this.effectiveScale;
    this.worldEl?.setAttribute(
      "transform",
      `matrix(${scale} 0 0 ${scale} ${this.panX} ${this.panY})`,
    );
    this.viewportEl.style.setProperty("--fsm-grid-minor", `${GRID_MINOR * scale}px`);
    this.viewportEl.style.setProperty("--fsm-grid-major", `${GRID_MAJOR * scale}px`);
    this.viewportEl.style.setProperty("--fsm-grid-x", `${this.panX}px`);
    this.viewportEl.style.setProperty("--fsm-grid-y", `${this.panY}px`);
  }

  private handleViewportResize(): void {
    if (!this.layout) return;
    const w = this.viewportEl.clientWidth;
    const h = this.viewportEl.clientHeight;
    if (w <= 0 || h <= 0) {
      this.pendingFit = true;
      this.svgHost.classList.add("is-awaiting-fit");
      return;
    }
    if (!this.pendingFit && !this.keepFitted) return;
    this.fitToView(true);
  }

  private fitToView(instant = false): void {
    if (!this.layout) return;
    const cam = fitGraphInViewport(
      this.layout,
      {
        width: this.viewportEl.clientWidth,
        height: this.viewportEl.clientHeight,
      },
      FIT_PADDING,
    );
    if (!cam) {
      this.pendingFit = true;
      this.svgHost.classList.add("is-awaiting-fit");
      return;
    }
    this.pendingFit = false;
    this.keepFitted = true;
    this.fitScale = cam.scale;
    this.svgHost.classList.remove("is-awaiting-fit");
    this.animateCamera(
      { panX: cam.panX, panY: cam.panY, scale: cam.scale },
      instant,
    );
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  setEmpty(message: string | null): void {
    if (message === null) {
      this.emptyEl.hidden = true;
      this.svgHost.hidden = false;
      return;
    }
    this.emptyEl.hidden = false;
    this.emptyEl.textContent = message;
    this.svgHost.hidden = true;
  }

  setActiveNode(nodeId: string): void {
    if (this.activeNodeId === nodeId) return;
    const prev = this.activeNodeId
      ? this.nodeEls.get(this.activeNodeId)
      : undefined;
    prev?.classList.remove("is-active");
    this.activeNodeId = nodeId;
    const next = nodeId ? this.nodeEls.get(nodeId) : undefined;
    if (next) {
      next.classList.add("is-active");
      this.centerNode(nodeId);
    }
  }

  private centerNode(nodeId: string): void {
    if (Date.now() < this.followPausedUntil) return;
    const node = this.layout?.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const scale = this.effectiveScale;
    const vw = this.viewportEl.clientWidth;
    const vh = this.viewportEl.clientHeight;
    this.animateCamera({
      panX: vw / 2 - (node.x + node.w / 2) * scale,
      panY: vh / 2 - (node.y + node.h / 2) * scale,
      scale,
    });
  }

  render(
    graph: {
      entryNodeId: string;
      terminalNodeId: string;
      nodes: Array<{
        id: string;
        name?: string;
        selfLoop: boolean;
        actionTypes: string[];
      }>;
      edges: Array<{ from: string; to: string; type: string; when?: string }>;
    },
    activeNodeId: string | null,
  ): void {
    this.cancelCameraAnim();
    const layout = layoutFsmGraph(graph);
    this.layout = layout;
    this.nodeEls = new Map();
    this.activeNodeId = activeNodeId ?? "";
    this.resumeFollow();
    this.userZoom = 1;
    this.updateZoomLabel();

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.classList.add("fsm-graph-svg");

    const world = document.createElementNS(SVG_NS, "g");
    world.classList.add("fsm-world");
    this.worldEl = world;

    for (const kind of EDGE_KINDS) {
      svg.append(this.buildArrowMarker(`fsm-arrow-${kind}`, `fsm-arrow-head-${kind}`));
    }

    for (const edge of layout.edges) {
      const group = document.createElementNS(SVG_NS, "g");
      group.classList.add("fsm-edge-hit");

      const hit = document.createElementNS(SVG_NS, "path");
      hit.setAttribute("d", edge.path);
      hit.classList.add("fsm-edge-hitarea");

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", edge.path);
      path.classList.add("fsm-edge", `fsm-edge-${edge.kind}`, `fsm-kind-${edge.kind}`);

      const flow = document.createElementNS(SVG_NS, "path");
      flow.setAttribute("d", edge.path);
      flow.classList.add("fsm-edge-flow", `fsm-edge-flow-${edge.kind}`);

      const arrow = document.createElementNS(SVG_NS, "path");
      const arrowD = edgeArrowSegment(edge.path);
      if (arrowD) arrow.setAttribute("d", arrowD);
      arrow.classList.add("fsm-edge-arrow");
      arrow.setAttribute("marker-end", `url(#fsm-arrow-${edge.kind})`);

      const tip = document.createElementNS(SVG_NS, "title");
      tip.textContent = edge.when
        ? `${edge.from} → ${edge.to}  (${edge.when})`
        : `${edge.from} → ${edge.to}`;
      group.append(hit, path, flow, arrow, tip);
      world.append(group);
    }

    for (const node of layout.nodes) {
      const g = document.createElementNS(SVG_NS, "g");
      g.classList.add("fsm-node");
      if (node.id === graph.entryNodeId) g.classList.add("is-entry");
      if (node.id === graph.terminalNodeId) g.classList.add("is-terminal");
      if (node.id === this.activeNodeId) g.classList.add("is-active");
      g.addEventListener("click", () => {
        if (this.didDrag) return;
        this.resumeFollow();
        this.centerNode(node.id);
      });

      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", String(node.x));
      rect.setAttribute("y", String(node.y));
      rect.setAttribute("width", String(node.w));
      rect.setAttribute("height", String(node.h));
      rect.setAttribute("rx", "10");
      g.append(rect);

      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("x", String(node.x + node.w / 2));
      label.setAttribute("y", String(node.y + node.h / 2));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("dominant-baseline", "middle");
      label.classList.add("fsm-node-label");
      label.textContent = node.id;
      g.append(label);

      const meta = graph.nodes.find((n) => n.id === node.id);
      const tip = document.createElementNS(SVG_NS, "title");
      tip.textContent =
        meta && meta.actionTypes.length > 0
          ? `${node.id}  [${meta.actionTypes.join(", ")}]`
          : node.id;
      g.append(tip);

      this.nodeEls.set(node.id, g);
      world.append(g);
    }

    svg.append(world);
    this.svgHost.replaceChildren(svg);
    this.keepFitted = true;
    this.pendingFit = true;
    this.handleViewportResize();
  }

  private buildArrowMarker(id: string, cls: string): SVGMarkerElement {
    const marker = document.createElementNS(SVG_NS, "marker");
    marker.setAttribute("id", id);
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto-start-reverse");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    path.setAttribute("class", cls);
    marker.append(path);
    return marker;
  }
}
