import {
  edgeArrowSegment,
  fitGraphInViewport,
  type FsmLayout,
} from "../../dev-tools/fsmLayout.js";
import { blueprintEdgePath, blueprintPreviewPath } from "./wirePath.js";
import { Maximize, Minus, Plus, Sparkles, type IconNode } from "lucide";
import { createLucideIcon } from "../../ui/originalIcons.js";
import type { GraphConfigJson } from "./graphConfigEdit.js";
import { graphViewInputFromConfig } from "./graphConfigEdit.js";
import {
  layoutForEditor,
  type NodeLayoutMap,
} from "./graphEditorLayout.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const FIT_PADDING = 16;
const GRID_MINOR = 20;
const GRID_MAJOR = 100;
const DRAG_THRESHOLD_PX = 4;
const ZOOM_MIN = 0.35;
const ZOOM_MAX = 2.5;
/** Soft snap distance to other node edges (world units). */
const ALIGN_SNAP_PX = 10;
/** Camera pose tween (Fit / zoom buttons) — easeOutCubic length. */
const CAM_EASE_MS = 260;

export type GraphEditorCanvasCallbacks = {
  onNodeSelect: (nodeId: string) => void;
  onNodeLayoutChange: (nodeLayout: NodeLayoutMap) => void;
  /** Alt+drag from source node onto target node. */
  onWireNodes: (fromNodeId: string, toNodeId: string) => void;
  /** Click a drawn wire (from → to). */
  onWireSelect: (fromNodeId: string, toNodeId: string) => void;
  /** Click empty canvas (not a drag / pan). */
  onBackgroundClick: () => void;
  /** Tidy: reset to the viewer's auto layout (nodes + corridor routing). */
  onAutoArrange: () => void;
};

export type SelectedWire = { from: string; to: string };

/** Interactive graph canvas: pan, zoom, fit, draggable nodes. */
export class GraphEditorCanvas {
  readonly root: HTMLElement;
  /** Shared chrome row — view injects back / title / actions around zoom controls. */
  readonly toolbarEl: HTMLElement;
  readonly zoomControlsEl: HTMLElement;
  private readonly viewportEl: HTMLElement;
  private readonly zoomLabel: HTMLElement;
  private readonly svgEl: SVGSVGElement;
  private readonly worldEl: SVGGElement;
  private readonly edgeLayer: SVGGElement;
  private readonly guideLayer: SVGGElement;
  private readonly nodeLayer: SVGGElement;
  private readonly wirePreviewEl: SVGPathElement;
  private callbacks: Partial<GraphEditorCanvasCallbacks> = {};

  private layout: FsmLayout | null = null;
  private nodeLayout: NodeLayoutMap = {};
  private graphInput: ReturnType<typeof graphViewInputFromConfig> | null = null;
  private selectedNodeId: string | null = null;
  private selectedWire: SelectedWire | null = null;
  private wiring = false;

  private fitScale = 1;
  private userZoom = 1;
  private panX = 0;
  private panY = 0;
  private keepFitted = true;
  private pendingFit = false;
  private camAnimId = 0;
  private camFrom = { x: 0, y: 0, s: 1 };
  private camTo = { x: 0, y: 0, s: 1 };
  private camStartMs = 0;

  private panning = false;
  private panDidMove = false;
  private panStartX = 0;
  private panStartY = 0;
  private panOriginX = 0;
  private panOriginY = 0;

  private draggingNodeId: string | null = null;
  private dragNodeStartX = 0;
  private dragNodeStartY = 0;
  private dragNodeOriginX = 0;
  private dragNodeOriginY = 0;
  private nodeEls = new Map<string, SVGGElement>();

  /** Alt+drag wire gesture (from node → drop on another). */
  private wireFromNodeId: string | null = null;
  private wireHoverNodeId: string | null = null;

  private resizeObserver: ResizeObserver | null = null;
  private mounted = false;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "graph-editor-canvas";

    this.toolbarEl = document.createElement("div");
    this.toolbarEl.className = "graph-editor-canvas-toolbar";

    this.zoomControlsEl = document.createElement("div");
    this.zoomControlsEl.className = "graph-editor-canvas-zoom-group";
    const zoomOut = this.toolButton("−", "Zoom out");
    const zoomIn = this.toolButton("+", "Zoom in");
    const fitBtn = this.toolButtonIcon(Maximize, "Fit graph");
    const tidyBtn = this.toolButtonIcon(
      Sparkles,
      "Auto-arrange nodes and wires (like the viewer)",
    );
    this.zoomLabel = document.createElement("span");
    this.zoomLabel.className = "graph-editor-canvas-zoom";
    this.zoomLabel.textContent = "100%";
    this.zoomControlsEl.append(zoomOut, this.zoomLabel, zoomIn, fitBtn, tidyBtn);
    this.toolbarEl.append(this.zoomControlsEl);

    this.viewportEl = document.createElement("div");
    this.viewportEl.className = "graph-editor-viewport fsm-pane-viewport";

    this.svgEl = document.createElementNS(SVG_NS, "svg");
    this.svgEl.setAttribute("width", "100%");
    this.svgEl.setAttribute("height", "100%");
    this.svgEl.classList.add("fsm-graph-svg");
    this.ensureArrowMarkers(this.svgEl);

    this.worldEl = document.createElementNS(SVG_NS, "g");
    this.worldEl.classList.add("fsm-world");
    this.edgeLayer = document.createElementNS(SVG_NS, "g");
    this.guideLayer = document.createElementNS(SVG_NS, "g");
    this.guideLayer.classList.add("graph-editor-guide-layer");
    this.nodeLayer = document.createElementNS(SVG_NS, "g");
    this.wirePreviewEl = document.createElementNS(SVG_NS, "path");
    this.wirePreviewEl.classList.add("graph-editor-wire-preview");
    this.wirePreviewEl.setAttribute("visibility", "hidden");
    this.wirePreviewEl.setAttribute(
      "marker-end",
      "url(#graph-editor-arrow-preview)",
    );
    this.worldEl.append(
      this.edgeLayer,
      this.guideLayer,
      this.nodeLayer,
      this.wirePreviewEl,
    );
    this.svgEl.append(this.worldEl);
    this.viewportEl.append(this.svgEl);

    // Toolbar is mounted by GraphEditorView across the full editor width.
    this.root.append(this.viewportEl);

    zoomIn.addEventListener("click", () =>
      this.zoomBy(1.2, { animate: true }),
    );
    zoomOut.addEventListener("click", () =>
      this.zoomBy(1 / 1.2, { animate: true }),
    );
    fitBtn.addEventListener("click", () => this.fitToView());
    tidyBtn.addEventListener("click", () =>
      this.callbacks.onAutoArrange?.(),
    );

    this.bindInteractions();
  }

  mount(host: HTMLElement): void {
    if (this.mounted) return;
    host.append(this.root);
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.viewportEl);
    this.mounted = true;
  }

  destroy(): void {
    this.cancelCameraAnim();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.root.remove();
    this.mounted = false;
  }

  setCallbacks(callbacks: Partial<GraphEditorCanvasCallbacks>): void {
    this.callbacks = callbacks;
  }

  setWiring(active: boolean): void {
    this.wiring = active;
    this.viewportEl.classList.toggle("is-wiring", active);
  }

  /**
   * Refresh graph geometry. Preserves camera unless `resetCamera` or first paint.
   */
  update(
    config: GraphConfigJson,
    nodeLayout: NodeLayoutMap | undefined,
    selectedNodeId: string | null,
    options?: { resetCamera?: boolean; selectedWire?: SelectedWire | null },
  ): NodeLayoutMap {
    this.selectedNodeId = selectedNodeId;
    this.selectedWire = options?.selectedWire ?? null;
    this.graphInput = graphViewInputFromConfig(config);
    const result = layoutForEditor(this.graphInput, nodeLayout);
    this.layout = result.layout;
    this.nodeLayout = result.nodeLayout;
    this.paint();
    if (options?.resetCamera) {
      this.fitToView(true);
    } else {
      this.applyCamera();
    }
    return this.nodeLayout;
  }

  private paint(): void {
    if (!this.layout || !this.graphInput) return;
    this.clearSnapGuides();
    this.edgeLayer.replaceChildren();
    this.nodeLayer.replaceChildren();
    this.nodeEls.clear();

    for (const edge of this.layout.edges) {
      const group = document.createElementNS(SVG_NS, "g");
      group.classList.add("fsm-edge-hit");
      group.dataset.from = edge.from;
      group.dataset.to = edge.to;
      if (
        this.selectedWire &&
        this.selectedWire.from === edge.from &&
        this.selectedWire.to === edge.to
      ) {
        group.classList.add("is-selected");
      }

      const hit = document.createElementNS(SVG_NS, "path");
      hit.setAttribute("d", edge.path);
      hit.classList.add("fsm-edge-hitarea");

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", edge.path);
      path.classList.add(
        "fsm-edge",
        `fsm-edge-${edge.kind}`,
        `fsm-kind-${edge.kind}`,
      );

      const flow = document.createElementNS(SVG_NS, "path");
      flow.setAttribute("d", edge.path);
      flow.classList.add("fsm-edge-flow", `fsm-edge-flow-${edge.kind}`);

      // Arrowhead as the LAST painted element: it must sit on top of both
      // the base line and the flow overlay instead of being crossed by them.
      // stroke-width (CSS) keeps the marker scale identical to the line.
      const arrow = document.createElementNS(SVG_NS, "path");
      const arrowD = edgeArrowSegment(edge.path);
      if (arrowD) arrow.setAttribute("d", arrowD);
      arrow.classList.add("fsm-edge-arrow");
      arrow.setAttribute("marker-end", `url(#graph-editor-arrow-${edge.kind})`);

      const tip = document.createElementNS(SVG_NS, "title");
      tip.textContent = edge.when
        ? `${edge.from} → ${edge.to}  (${edge.when})`
        : `${edge.from} → ${edge.to}`;

      group.append(hit, path, flow, arrow, tip);
      group.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        ev.preventDefault();
        this.callbacks.onWireSelect?.(edge.from, edge.to);
      });
      this.edgeLayer.append(group);
    }

    for (const node of this.layout.nodes) {
      const g = document.createElementNS(SVG_NS, "g");
      g.classList.add("fsm-node", "graph-editor-node");
      if (node.id === this.selectedNodeId) g.classList.add("is-active");
      if (node.id === this.graphInput.entryNodeId) g.classList.add("is-entry");
      if (node.id === this.graphInput.terminalNodeId) {
        g.classList.add("is-terminal");
      }
      g.dataset.nodeId = node.id;
      g.style.cursor = "grab";

      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", String(node.x));
      rect.setAttribute("y", String(node.y));
      rect.setAttribute("width", String(node.w));
      rect.setAttribute("height", String(node.h));
      rect.setAttribute("rx", "10");
      g.append(rect);

      const meta = this.graphInput.nodes.find((n) => n.id === node.id);
      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("x", String(node.x + node.w / 2));
      label.setAttribute("y", String(node.y + node.h / 2 - 6));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("dominant-baseline", "middle");
      label.classList.add("fsm-node-label");
      label.textContent = meta?.name?.trim() || node.id;
      g.append(label);

      if (meta && meta.actionTypes.length > 0) {
        const sub = document.createElementNS(SVG_NS, "text");
        sub.setAttribute("x", String(node.x + node.w / 2));
        sub.setAttribute("y", String(node.y + node.h / 2 + 10));
        sub.setAttribute("text-anchor", "middle");
        sub.classList.add("fsm-node-sublabel");
        sub.textContent =
          meta.actionTypes.length === 1
            ? meta.actionTypes[0]!
            : `${meta.actionTypes.length} actions`;
        g.append(sub);
      }

      g.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        if (ev.altKey) {
          this.startWireDrag(ev, node.id);
          return;
        }
        this.startNodeDrag(ev, node.id);
      });

      this.nodeLayer.append(g);
      this.nodeEls.set(node.id, g);
    }
  }

  private bindInteractions(): void {
    this.viewportEl.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        if (ev.metaKey || ev.ctrlKey) {
          this.zoomBy(Math.exp(-ev.deltaY * 0.0022), {
            anchorClientX: ev.clientX,
            anchorClientY: ev.clientY,
          });
          return;
        }
        this.cancelCameraAnim();
        this.keepFitted = false;
        this.panX -= ev.deltaX;
        this.panY -= ev.deltaY;
        this.applyCamera();
      },
      { passive: false },
    );

    this.viewportEl.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      const target = ev.target as Element;
      if (target.closest(".graph-editor-node")) return;
      if (target.closest(".fsm-edge-hit")) return;
      this.cancelCameraAnim();
      this.panning = true;
      this.panDidMove = false;
      this.panStartX = ev.clientX;
      this.panStartY = ev.clientY;
      this.panOriginX = this.panX;
      this.panOriginY = this.panY;
      this.viewportEl.setPointerCapture(ev.pointerId);
      this.viewportEl.classList.add("is-panning");
    });

    this.viewportEl.addEventListener("pointermove", (ev) => {
      if (this.wireFromNodeId) {
        this.moveWireDrag(ev);
        return;
      }
      if (this.draggingNodeId) {
        this.moveNodeDrag(ev);
        return;
      }
      if (!this.panning) return;
      const dx = ev.clientX - this.panStartX;
      const dy = ev.clientY - this.panStartY;
      if (
        !this.panDidMove &&
        dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX
      ) {
        return;
      }
      this.panDidMove = true;
      this.keepFitted = false;
      this.panX = this.panOriginX + dx;
      this.panY = this.panOriginY + dy;
      this.applyCamera();
    });

    const endPointer = (ev: PointerEvent): void => {
      if (this.wireFromNodeId) {
        this.finishWireDrag(ev);
        return;
      }
      if (this.draggingNodeId) {
        this.finishNodeDrag(ev);
        return;
      }
      if (!this.panning) return;
      const wasClick = !this.panDidMove;
      this.panning = false;
      this.viewportEl.classList.remove("is-panning");
      if (this.viewportEl.hasPointerCapture(ev.pointerId)) {
        this.viewportEl.releasePointerCapture(ev.pointerId);
      }
      if (wasClick) {
        this.callbacks.onBackgroundClick?.();
      }
    };
    this.viewportEl.addEventListener("pointerup", endPointer);
    this.viewportEl.addEventListener("pointercancel", endPointer);
  }

  private startWireDrag(ev: PointerEvent, nodeId: string): void {
    if (!this.layout) return;
    ev.preventDefault();
    this.panning = false;
    this.draggingNodeId = null;
    this.cancelCameraAnim();
    this.wireFromNodeId = nodeId;
    this.wireHoverNodeId = null;
    this.viewportEl.classList.add("is-wiring");
    this.viewportEl.setPointerCapture(ev.pointerId);
    this.updateWirePreview(ev.clientX, ev.clientY);
  }

  private moveWireDrag(ev: PointerEvent): void {
    if (!this.wireFromNodeId) return;
    const hover = this.hitTestNode(ev.clientX, ev.clientY);
    this.wireHoverNodeId =
      hover && hover !== this.wireFromNodeId ? hover : null;
    for (const [id, el] of this.nodeEls) {
      el.classList.toggle(
        "is-wire-target",
        id === this.wireHoverNodeId,
      );
    }
    this.updateWirePreview(ev.clientX, ev.clientY);
  }

  private finishWireDrag(ev: PointerEvent): void {
    const fromId = this.wireFromNodeId;
    if (!fromId) return;
    const toId = this.hitTestNode(ev.clientX, ev.clientY);
    this.clearWireDrag(ev.pointerId);
    if (toId && toId !== fromId) {
      this.callbacks.onWireNodes?.(fromId, toId);
    } else {
      this.callbacks.onNodeSelect?.(fromId);
    }
  }

  private clearWireDrag(pointerId?: number): void {
    this.wireFromNodeId = null;
    this.wireHoverNodeId = null;
    this.wirePreviewEl.setAttribute("visibility", "hidden");
    this.viewportEl.classList.remove("is-wiring");
    for (const el of this.nodeEls.values()) {
      el.classList.remove("is-wire-target");
    }
    if (
      pointerId !== undefined &&
      this.viewportEl.hasPointerCapture(pointerId)
    ) {
      this.viewportEl.releasePointerCapture(pointerId);
    }
  }

  private updateWirePreview(clientX: number, clientY: number): void {
    if (!this.wireFromNodeId || !this.layout) return;
    const from = this.layout.nodes.find((n) => n.id === this.wireFromNodeId);
    if (!from) return;
    const world = this.clientToWorld(clientX, clientY);
    this.wirePreviewEl.setAttribute(
      "d",
      blueprintPreviewPath(from, { x: world.x, y: world.y }),
    );
    this.wirePreviewEl.setAttribute("visibility", "visible");
  }

  private clientToWorld(
    clientX: number,
    clientY: number,
  ): { x: number; y: number } {
    const rect = this.viewportEl.getBoundingClientRect();
    const scale = this.effectiveScale;
    return {
      x: (clientX - rect.left - this.panX) / scale,
      y: (clientY - rect.top - this.panY) / scale,
    };
  }

  private hitTestNode(clientX: number, clientY: number): string | null {
    if (!this.layout) return null;
    const { x, y } = this.clientToWorld(clientX, clientY);
    for (let i = this.layout.nodes.length - 1; i >= 0; i--) {
      const node = this.layout.nodes[i]!;
      if (
        x >= node.x &&
        x <= node.x + node.w &&
        y >= node.y &&
        y <= node.y + node.h
      ) {
        return node.id;
      }
    }
    return null;
  }

  private startNodeDrag(ev: PointerEvent, nodeId: string): void {
    if (!this.layout) return;
    const node = this.layout.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    ev.stopPropagation();
    this.panning = false;
    this.cancelCameraAnim();
    this.draggingNodeId = nodeId;
    this.dragNodeStartX = ev.clientX;
    this.dragNodeStartY = ev.clientY;
    this.dragNodeOriginX = node.x;
    this.dragNodeOriginY = node.y;
    this.nodeEls.get(nodeId)?.classList.add("is-dragging");
    this.viewportEl.setPointerCapture(ev.pointerId);
  }

  private moveNodeDrag(ev: PointerEvent): void {
    if (!this.draggingNodeId || !this.layout) return;
    const scale = this.effectiveScale;
    const dx = (ev.clientX - this.dragNodeStartX) / scale;
    const dy = (ev.clientY - this.dragNodeStartY) / scale;
    const rawX = this.dragNodeOriginX + dx;
    const rawY = this.dragNodeOriginY + dy;

    const node = this.layout.nodes.find((n) => n.id === this.draggingNodeId);
    if (!node) return;
    const snapped = this.snapDragPose(
      rawX,
      rawY,
      node.w,
      node.h,
      this.draggingNodeId,
    );
    const nextX = snapped.x;
    const nextY = snapped.y;
    node.x = nextX;
    node.y = nextY;
    this.nodeLayout[this.draggingNodeId] = { x: nextX, y: nextY };
    this.paintSnapGuides(snapped.vLines, snapped.hLines);

    const byId = new Map(this.layout.nodes.map((n) => [n.id, n]));
    const groups = this.edgeLayer.querySelectorAll(":scope > .fsm-edge-hit");
    this.layout.edges.forEach((edge, index) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return;
      const d = this.edgePath(from, to);
      edge.path = d;
      const group = groups[index];
      if (!group) return;
      for (const p of group.querySelectorAll("path")) {
        p.setAttribute("d", d);
      }
    });

    const g = this.nodeEls.get(this.draggingNodeId);
    if (g) {
      const rect = g.querySelector("rect");
      rect?.setAttribute("x", String(nextX));
      rect?.setAttribute("y", String(nextY));
      for (const text of g.querySelectorAll("text")) {
        const isSub = text.classList.contains("fsm-node-sublabel");
        text.setAttribute("x", String(nextX + node.w / 2));
        text.setAttribute(
          "y",
          String(nextY + node.h / 2 + (isSub ? 10 : -6)),
        );
      }
    }

    this.keepFitted = false;
    this.expandBounds();
  }

  /**
   * Prefer alignment with other nodes; otherwise snap to the minor grid.
   */
  private snapDragPose(
    rawX: number,
    rawY: number,
    w: number,
    h: number,
    excludeId: string,
  ): { x: number; y: number; vLines: number[]; hLines: number[] } {
    const others =
      this.layout?.nodes.filter((n) => n.id !== excludeId) ?? [];
    const selfEdgesX = [0, w / 2, w];
    const selfEdgesY = [0, h / 2, h];

    let bestDx: { delta: number; line: number } | null = null;
    let bestDy: { delta: number; line: number } | null = null;

    for (const other of others) {
      const otherXs = [other.x, other.x + other.w / 2, other.x + other.w];
      const otherYs = [other.y, other.y + other.h / 2, other.y + other.h];
      for (const offset of selfEdgesX) {
        for (const line of otherXs) {
          const delta = line - (rawX + offset);
          if (Math.abs(delta) > ALIGN_SNAP_PX) continue;
          if (!bestDx || Math.abs(delta) < Math.abs(bestDx.delta)) {
            bestDx = { delta, line };
          }
        }
      }
      for (const offset of selfEdgesY) {
        for (const line of otherYs) {
          const delta = line - (rawY + offset);
          if (Math.abs(delta) > ALIGN_SNAP_PX) continue;
          if (!bestDy || Math.abs(delta) < Math.abs(bestDy.delta)) {
            bestDy = { delta, line };
          }
        }
      }
    }

    let x = rawX;
    let y = rawY;
    const vLines: number[] = [];
    const hLines: number[] = [];

    if (bestDx) {
      x = rawX + bestDx.delta;
      vLines.push(bestDx.line);
    } else {
      x = Math.round(rawX / GRID_MINOR) * GRID_MINOR;
    }
    if (bestDy) {
      y = rawY + bestDy.delta;
      hLines.push(bestDy.line);
    } else {
      y = Math.round(rawY / GRID_MINOR) * GRID_MINOR;
    }

    // Collect every matching guide at the snapped pose (same edge lines).
    if (vLines.length > 0 || hLines.length > 0) {
      const snappedXs = selfEdgesX.map((o) => x + o);
      const snappedYs = selfEdgesY.map((o) => y + o);
      const allV = new Set<number>();
      const allH = new Set<number>();
      for (const other of others) {
        for (const line of [other.x, other.x + other.w / 2, other.x + other.w]) {
          if (snappedXs.some((sx) => Math.abs(sx - line) < 0.5)) allV.add(line);
        }
        for (const line of [other.y, other.y + other.h / 2, other.y + other.h]) {
          if (snappedYs.some((sy) => Math.abs(sy - line) < 0.5)) allH.add(line);
        }
      }
      return {
        x,
        y,
        vLines: [...allV],
        hLines: [...allH],
      };
    }

    return { x, y, vLines, hLines };
  }

  private paintSnapGuides(vLines: number[], hLines: number[]): void {
    this.guideLayer.replaceChildren();
    if (!this.layout || (vLines.length === 0 && hLines.length === 0)) return;
    const minX = Math.min(0, ...this.layout.nodes.map((n) => n.x)) - 40;
    const maxX =
      Math.max(this.layout.width, ...this.layout.nodes.map((n) => n.x + n.w)) +
      40;
    const minY = Math.min(0, ...this.layout.nodes.map((n) => n.y)) - 40;
    const maxY =
      Math.max(
        this.layout.height,
        ...this.layout.nodes.map((n) => n.y + n.h),
      ) + 40;

    for (const x of vLines) {
      const line = document.createElementNS(SVG_NS, "line");
      line.classList.add("graph-editor-snap-guide");
      line.setAttribute("x1", String(x));
      line.setAttribute("x2", String(x));
      line.setAttribute("y1", String(minY));
      line.setAttribute("y2", String(maxY));
      this.guideLayer.append(line);
    }
    for (const y of hLines) {
      const line = document.createElementNS(SVG_NS, "line");
      line.classList.add("graph-editor-snap-guide");
      line.setAttribute("x1", String(minX));
      line.setAttribute("x2", String(maxX));
      line.setAttribute("y1", String(y));
      line.setAttribute("y2", String(y));
      this.guideLayer.append(line);
    }
  }

  private clearSnapGuides(): void {
    this.guideLayer.replaceChildren();
  }

  private finishNodeDrag(ev: PointerEvent): void {
    const nodeId = this.draggingNodeId;
    if (!nodeId) return;
    this.nodeEls.get(nodeId)?.classList.remove("is-dragging");
    if (this.viewportEl.hasPointerCapture(ev.pointerId)) {
      this.viewportEl.releasePointerCapture(ev.pointerId);
    }
    this.draggingNodeId = null;
    this.clearSnapGuides();

    const moved =
      Math.abs(ev.clientX - this.dragNodeStartX) > DRAG_THRESHOLD_PX ||
      Math.abs(ev.clientY - this.dragNodeStartY) > DRAG_THRESHOLD_PX;

    if (moved) {
      this.callbacks.onNodeLayoutChange?.({ ...this.nodeLayout });
    } else {
      this.callbacks.onNodeSelect?.(nodeId);
    }
  }

  private edgePath(
    from: { x: number; y: number; w: number; h: number },
    to: { x: number; y: number; w: number; h: number },
  ): string {
    return blueprintEdgePath(from, to);
  }

  private toolButton(label: string, title: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "graph-editor-canvas-tool";
    btn.title = title;
    if (label === "+" || label === "−") {
      btn.append(createLucideIcon(label === "+" ? Plus : Minus, { size: 12 }));
    } else btn.textContent = label;
    return btn;
  }

  private toolButtonIcon(icon: IconNode, title: string): HTMLButtonElement {
    const btn = this.toolButton("", title);
    btn.append(createLucideIcon(icon, { size: 14 }));
    return btn;
  }

  private expandBounds(): void {
    if (!this.layout) return;
    const PAD = 28;
    this.layout.width =
      Math.max(...this.layout.nodes.map((n) => n.x + n.w)) + PAD;
    this.layout.height =
      Math.max(...this.layout.nodes.map((n) => n.y + n.h)) + PAD;
  }

  private get effectiveScale(): number {
    return this.fitScale * this.userZoom;
  }

  private updateZoomLabel(): void {
    this.zoomLabel.textContent = `${Math.round(this.userZoom * 100)}%`;
  }

  private applyCamera(): void {
    const scale = this.effectiveScale;
    this.worldEl.setAttribute(
      "transform",
      `matrix(${scale} 0 0 ${scale} ${this.panX} ${this.panY})`,
    );
    this.viewportEl.style.setProperty(
      "--fsm-grid-minor",
      `${GRID_MINOR * scale}px`,
    );
    this.viewportEl.style.setProperty(
      "--fsm-grid-major",
      `${GRID_MAJOR * scale}px`,
    );
    this.viewportEl.style.setProperty("--fsm-grid-x", `${this.panX}px`);
    this.viewportEl.style.setProperty("--fsm-grid-y", `${this.panY}px`);
  }

  private zoomBy(
    factor: number,
    options?: {
      anchorClientX?: number;
      anchorClientY?: number;
      animate?: boolean;
    },
  ): void {
    this.keepFitted = false;
    const baseZoom =
      this.camAnimId !== 0 ? this.camTo.s / this.fitScale : this.userZoom;
    const next = Math.min(
      ZOOM_MAX,
      Math.max(ZOOM_MIN, baseZoom * factor),
    );
    if (next === baseZoom) return;
    const rect = this.viewportEl.getBoundingClientRect();
    const sx =
      options?.anchorClientX !== undefined
        ? options.anchorClientX - rect.left
        : rect.width / 2;
    const sy =
      options?.anchorClientY !== undefined
        ? options.anchorClientY - rect.top
        : rect.height / 2;
    const oldScale = this.effectiveScale;
    const newScale = this.fitScale * next;
    const worldX = (sx - this.panX) / oldScale;
    const worldY = (sy - this.panY) / oldScale;
    this.animateCamera(
      {
        panX: sx - worldX * newScale,
        panY: sy - worldY * newScale,
        scale: newScale,
      },
      !options?.animate,
    );
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
      return;
    }
    this.pendingFit = false;
    this.keepFitted = true;
    this.fitScale = cam.scale;
    this.animateCamera(
      { panX: cam.panX, panY: cam.panY, scale: cam.scale },
      instant,
    );
  }

  private handleResize(): void {
    if (!this.layout) return;
    const w = this.viewportEl.clientWidth;
    const h = this.viewportEl.clientHeight;
    if (w <= 0 || h <= 0) {
      this.pendingFit = true;
      return;
    }
    if (!this.pendingFit && !this.keepFitted) return;
    this.fitToView(true);
  }

  private ensureArrowMarkers(svg: SVGSVGElement): void {
    const defs = document.createElementNS(SVG_NS, "defs");
    const kinds = ["forward", "back", "self", "cross"] as const;
    for (const kind of kinds) {
      defs.append(
        this.buildArrowMarker(
          `graph-editor-arrow-${kind}`,
          `fsm-arrow-head-${kind}`,
        ),
      );
    }
    defs.append(
      this.buildArrowMarker(
        "graph-editor-arrow-preview",
        "graph-editor-arrow-head-preview",
      ),
    );
    svg.append(defs);
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
    marker.setAttribute("markerUnits", "strokeWidth");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    path.setAttribute("class", cls);
    marker.append(path);
    return marker;
  }
}
