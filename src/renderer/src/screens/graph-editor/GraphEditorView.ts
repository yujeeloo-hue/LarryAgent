import {
  ArrowLeft,
  Box,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Download,
  GripVertical,
  Plug,
  Plus,
  Save,
  SlidersHorizontal,
  Trash2,
  X,
  type IconNode,
} from "lucide";
import { createLucideIcon } from "../../ui/originalIcons.js";
import "../../dev-tools/dev-tools.css";
import "../setting/setting.css";
import type { GraphConfigJson } from "./graphConfigEdit.js";
import {
  GraphEditorCanvas,
  type SelectedWire,
} from "./GraphEditorCanvas.js";
import type { NodeLayoutMap } from "./graphEditorLayout.js";
import { NEON_PALETTE } from "./neonPalette.js";
import {
  bindDetailsTip,
  bindInspectorTip,
  disposeInspectorTip,
  hideDetailsTip,
  hideInspectorTip,
} from "./inspectorTip.js";
import "./graph-editor.css";

const INSPECTOR_WIDTH_STORAGE_KEY = "jellybot.graphEditor.inspectorWidth";
const INSPECTOR_WIDTH_DEFAULT = 300;
const INSPECTOR_WIDTH_MIN = 220;
const INSPECTOR_WIDTH_MAX = 480;

function clampInspectorWidth(px: number): number {
  return Math.min(
    INSPECTOR_WIDTH_MAX,
    Math.max(INSPECTOR_WIDTH_MIN, Math.round(px)),
  );
}

function readStoredInspectorWidth(): number {
  try {
    const raw =
      localStorage.getItem(INSPECTOR_WIDTH_STORAGE_KEY) ??
      localStorage.getItem("jellybot.graphEditor.panelWidth");
    if (!raw) return INSPECTOR_WIDTH_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return INSPECTOR_WIDTH_DEFAULT;
    return clampInspectorWidth(n);
  } catch {
    return INSPECTOR_WIDTH_DEFAULT;
  }
}

function writeStoredInspectorWidth(px: number): void {
  try {
    localStorage.setItem(
      INSPECTOR_WIDTH_STORAGE_KEY,
      String(clampInspectorWidth(px)),
    );
  } catch {
    // ignore quota / private mode
  }
}

export type GraphEditorViewCallbacks = {
  onBack: () => void;
  onSave: () => void;
  onExport: () => void;
  onAddNode: () => void;
  onNodeSelect: (nodeId: string) => void;
  onNodeLayoutChange: (nodeLayout: NodeLayoutMap) => void;
  onWireNodes: (fromNodeId: string, toNodeId: string) => void;
  onWireSelect: (fromNodeId: string, toNodeId: string) => void;
  onClearSelection: () => void;
  onDeleteSelection: () => void;
  onAutoArrange: () => void;
  onNodeNameChange: (name: string) => void;
  onSelfLoopChange: (enabled: boolean) => void;
  onSelectAction: (index: number | null) => void;
  onCloseActionOverlay: () => void;
  onAddAction: (actionType: string) => void;
  onRemoveAction: (index: number) => void;
  onReorderAction: (from: number, to: number) => void;
  onRemoveNode: () => void;
};

export class GraphEditorView {
  readonly root: HTMLElement;
  private titleInput!: HTMLInputElement;
  private colorButton!: HTMLButtonElement;
  private colorSwatch!: HTMLElement;
  private colorMenu!: HTMLElement;
  private colorCells: HTMLButtonElement[] = [];
  private colorMenuOpen = false;
  /** Current identity color (`#rrggbb`); seeded by setGraphColor on load. */
  private currentColor = "";
  /** Capture-phase outside-press dismiss for the palette popover. */
  private colorOutsideDismiss: (event: PointerEvent) => void = () => {};
  private readonly statusEl: HTMLElement;
  private readonly canvasHost: HTMLElement;
  private readonly inspectorHost: HTMLElement;
  private readonly inspectorScrollHost: HTMLElement;
  private readonly actionOverlay: HTMLElement;
  private readonly actionOverlayTitle: HTMLElement;
  private readonly actionOverlayList: HTMLElement;
  private readonly actionOverlayAdd: HTMLElement;
  private readonly inspectorResizeZone: HTMLElement;
  private readonly inspectorResizeKnob: HTMLElement;
  private actionRowDrag: {
    pointerId: number;
    from: number;
    startY: number;
    row: HTMLElement;
    rows: HTMLElement[];
    centers: number[];
    dragSlot: number;
    active: boolean;
    target: number;
  } | null = null;
  private suppressRowClick = false;
  private readonly canvas: GraphEditorCanvas;
  private callbacks: Partial<GraphEditorViewCallbacks> = {};

  private overlayDrag: {
    pointerId: number;
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
  } | null = null;

  /** Inspector (right settings cards) width only — Actions overlay stays fixed. */
  private inspectorWidth = INSPECTOR_WIDTH_DEFAULT;
  private inspectorResize: {
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null = null;
  private inspectorResizeHover = false;

  constructor() {
    this.root = document.createElement("section");
    this.root.className = "screen graph-editor-screen";
    // Selects use the app popup in every theme, including new params rows.
    this.root.setAttribute("data-app-select", "");

    this.statusEl = document.createElement("p");
    this.statusEl.className = "graph-editor-status";
    this.statusEl.hidden = true;

    const body = document.createElement("div");
    body.className = "graph-editor-body";
    // Dark island starts BELOW the top chrome: toolbar (title input, color
    // picker, zoom) + status bar follow the app theme; canvas, action
    // overlay and inspector cards stay dark in every theme via this marker
    // (see state/theme.ts darkIslandCss).
    body.setAttribute("data-dark-island", "");

    this.canvasHost = document.createElement("div");
    this.canvasHost.className = "graph-editor-canvas-host";

    this.actionOverlay = document.createElement("div");
    this.actionOverlay.className = "graph-editor-action-overlay";
    this.actionOverlay.hidden = true;

    const overlayHead = document.createElement("div");
    overlayHead.className = "graph-editor-action-overlay-head";
    overlayHead.title = "Drag to move";
    this.actionOverlayTitle = document.createElement("div");
    this.actionOverlayTitle.className = "graph-editor-action-overlay-title";
    this.actionOverlayTitle.textContent = "Actions";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "graph-editor-icon-chip";
    close.title = "Close";
    close.append(createLucideIcon(X, { size: 14 }));
    close.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.callbacks.onCloseActionOverlay?.();
    });
    overlayHead.append(this.actionOverlayTitle, close);
    this.bindOverlayDrag(overlayHead);

    this.actionOverlayList = document.createElement("div");
    this.actionOverlayList.className = "graph-editor-action-overlay-list";
    this.actionOverlayAdd = document.createElement("div");
    this.actionOverlayAdd.className = "graph-editor-overlay-add";

    this.actionOverlay.append(
      overlayHead,
      this.actionOverlayList,
      this.actionOverlayAdd,
    );

    this.inspectorHost = document.createElement("aside");
    this.inspectorHost.className = "graph-editor-inspector";
    this.inspectorHost.hidden = true;
    this.inspectorHost.addEventListener("pointerleave", hideInspectorTip);

    this.inspectorResizeZone = document.createElement("div");
    this.inspectorResizeZone.className = "graph-editor-inspector-resize-zone";
    this.inspectorResizeZone.setAttribute("role", "separator");
    this.inspectorResizeZone.setAttribute("aria-orientation", "vertical");
    this.inspectorResizeZone.setAttribute("aria-label", "Resize inspector");
    this.inspectorResizeZone.title =
      "Drag to resize · double-click to reset";
    this.inspectorResizeZone.tabIndex = 0;
    this.inspectorResizeZone.setAttribute(
      "aria-valuemin",
      String(INSPECTOR_WIDTH_MIN),
    );
    this.inspectorResizeZone.setAttribute(
      "aria-valuemax",
      String(INSPECTOR_WIDTH_MAX),
    );

    this.inspectorResizeKnob = document.createElement("div");
    this.inspectorResizeKnob.className = "graph-editor-inspector-resize-knob";
    this.inspectorResizeKnob.setAttribute("aria-hidden", "true");
    this.inspectorResizeKnob.append(
      createLucideIcon(ChevronLeft, { size: 14 }),
      createLucideIcon(ChevronRight, { size: 14 }),
    );

    this.inspectorScrollHost = document.createElement("div");
    this.inspectorScrollHost.className = "graph-editor-inspector-scroll";
    this.inspectorScrollHost.addEventListener("scroll", hideInspectorTip, {
      passive: true,
    });

    this.bindInspectorResize();
    this.inspectorHost.append(
      this.inspectorScrollHost,
      this.inspectorResizeZone,
      this.inspectorResizeKnob,
    );

    this.canvasHost.append(this.actionOverlay, this.inspectorHost);
    body.append(this.canvasHost);

    this.canvas = new GraphEditorCanvas();
    this.composeToolbar();
    this.root.append(this.canvas.toolbarEl, this.statusEl, body);
    this.canvas.mount(this.canvasHost);
    this.applyInspectorWidth(readStoredInspectorWidth(), false);
    this.canvas.setCallbacks({
      onNodeSelect: (nodeId) => this.callbacks.onNodeSelect?.(nodeId),
      onNodeLayoutChange: (layout) =>
        this.callbacks.onNodeLayoutChange?.(layout),
      onWireNodes: (fromId, toId) => this.callbacks.onWireNodes?.(fromId, toId),
      onWireSelect: (fromId, toId) =>
        this.callbacks.onWireSelect?.(fromId, toId),
      onBackgroundClick: () => this.callbacks.onClearSelection?.(),
      onAutoArrange: () => this.callbacks.onAutoArrange?.(),
    });

    this.root.tabIndex = -1;
    this.root.addEventListener("keydown", (ev) => {
      if (ev.key !== "Delete" && ev.key !== "Backspace") return;
      const target = ev.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable ||
          target.closest("input, textarea, select, [contenteditable=true]")
        ) {
          return;
        }
      }
      ev.preventDefault();
      this.callbacks.onDeleteSelection?.();
    });
  }

  private bindInspectorResize(): void {
    const zone = this.inspectorResizeZone;
    const knob = this.inspectorResizeKnob;

    const showKnobAt = (clientY: number): void => {
      const rect = this.inspectorHost.getBoundingClientRect();
      if (rect.height <= 0) return;
      const pad = 22;
      const y = Math.min(
        Math.max(clientY - rect.top, pad),
        rect.height - pad,
      );
      knob.style.top = `${y}px`;
      this.setInspectorResizeKnobVisible(true);
    };

    const onEnterMove = (event: PointerEvent): void => {
      if (this.inspectorHost.hidden) return;
      this.inspectorResizeHover = true;
      showKnobAt(event.clientY);
    };

    const onLeave = (event: PointerEvent): void => {
      if (this.inspectorResize) return;
      const next = event.relatedTarget;
      if (
        next instanceof Node &&
        (zone.contains(next) || knob.contains(next))
      ) {
        return;
      }
      this.inspectorResizeHover = false;
      this.setInspectorResizeKnobVisible(false);
    };

    zone.addEventListener("pointerenter", onEnterMove);
    zone.addEventListener("pointermove", onEnterMove);
    zone.addEventListener("pointerleave", onLeave);
    knob.addEventListener("pointerenter", onEnterMove);
    knob.addEventListener("pointermove", onEnterMove);
    knob.addEventListener("pointerleave", onLeave);

    const startDrag = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      this.inspectorResize = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: this.inspectorWidth,
      };
      zone.classList.add("is-dragging");
      knob.classList.add("is-dragging");
      showKnobAt(event.clientY);
      const captureTarget = event.currentTarget as HTMLElement;
      captureTarget.setPointerCapture(event.pointerId);
      window.addEventListener("pointermove", this.onInspectorResizeMove);
      window.addEventListener("pointerup", this.onInspectorResizeUp);
      window.addEventListener("pointercancel", this.onInspectorResizeUp);
    };

    zone.addEventListener("pointerdown", startDrag);
    knob.addEventListener("pointerdown", startDrag);

    zone.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.applyInspectorWidth(INSPECTOR_WIDTH_DEFAULT, true);
    });
    knob.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.applyInspectorWidth(INSPECTOR_WIDTH_DEFAULT, true);
    });

    zone.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 24 : 8;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        this.applyInspectorWidth(this.inspectorWidth + step, true);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        this.applyInspectorWidth(this.inspectorWidth - step, true);
      } else if (event.key === "Home") {
        event.preventDefault();
        this.applyInspectorWidth(INSPECTOR_WIDTH_MIN, true);
      } else if (event.key === "End") {
        event.preventDefault();
        this.applyInspectorWidth(INSPECTOR_WIDTH_MAX, true);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.applyInspectorWidth(INSPECTOR_WIDTH_DEFAULT, true);
      }
    });
  }

  private setInspectorResizeKnobVisible(visible: boolean): void {
    this.inspectorResizeKnob.classList.toggle("is-visible", visible);
  }

  private readonly onInspectorResizeMove = (event: PointerEvent): void => {
    const drag = this.inspectorResize;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const delta = drag.startX - event.clientX;
    this.applyInspectorWidth(drag.startWidth + delta, false);
    const rect = this.inspectorHost.getBoundingClientRect();
    const pad = 22;
    const y = Math.min(
      Math.max(event.clientY - rect.top, pad),
      Math.max(pad, rect.height - pad),
    );
    this.inspectorResizeKnob.style.top = `${y}px`;
  };

  private readonly onInspectorResizeUp = (event: PointerEvent): void => {
    const drag = this.inspectorResize;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.inspectorResizeZone.classList.remove("is-dragging");
    this.inspectorResizeKnob.classList.remove("is-dragging");
    for (const el of [this.inspectorResizeZone, this.inspectorResizeKnob]) {
      try {
        if (el.hasPointerCapture(event.pointerId)) {
          el.releasePointerCapture(event.pointerId);
        }
      } catch {
        // already released
      }
    }
    this.inspectorResize = null;
    window.removeEventListener("pointermove", this.onInspectorResizeMove);
    window.removeEventListener("pointerup", this.onInspectorResizeUp);
    window.removeEventListener("pointercancel", this.onInspectorResizeUp);
    this.applyInspectorWidth(this.inspectorWidth, true);
    if (!this.inspectorResizeHover) {
      this.setInspectorResizeKnobVisible(false);
    }
  };

  private applyInspectorWidth(px: number, persist: boolean): void {
    this.inspectorWidth = clampInspectorWidth(px);
    this.root.style.setProperty(
      "--graph-editor-inspector-width",
      `${this.inspectorWidth}px`,
    );
    this.inspectorResizeZone.setAttribute(
      "aria-valuenow",
      String(this.inspectorWidth),
    );
    if (persist) writeStoredInspectorWidth(this.inspectorWidth);
  }

  private composeToolbar(): void {
    const start = document.createElement("div");
    start.className = "graph-editor-toolbar-start";

    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "graph-editor-canvas-tool";
    backBtn.title = "Back to graphs";
    backBtn.setAttribute("aria-label", "Back to graphs");
    backBtn.append(createLucideIcon(ArrowLeft, { size: 14 }));
    backBtn.addEventListener("click", () => this.callbacks.onBack?.());

    this.titleInput = document.createElement("input");
    this.titleInput.type = "text";
    this.titleInput.className = "graph-editor-title-input";
    this.titleInput.placeholder = "Graph name";

    start.append(backBtn, this.titleInput, this.composeColorPicker());

    const end = document.createElement("div");
    end.className = "graph-editor-toolbar-end";

    const addNodeBtn = document.createElement("button");
    addNodeBtn.type = "button";
    addNodeBtn.className = "graph-editor-canvas-tool graph-editor-toolbar-btn action-primary";
    addNodeBtn.append(
      createLucideIcon(Plus, { size: 14 }),
      document.createTextNode("Node"),
    );
    addNodeBtn.addEventListener("click", () => this.callbacks.onAddNode?.());

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className =
      "graph-editor-canvas-tool graph-editor-toolbar-btn is-primary action-primary";
    saveBtn.append(
      createLucideIcon(Save, { size: 14 }),
      document.createTextNode("Save"),
    );
    saveBtn.addEventListener("click", () => this.callbacks.onSave?.());

    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "graph-editor-canvas-tool graph-editor-toolbar-btn";
    exportBtn.append(
      createLucideIcon(Download, { size: 14 }),
      document.createTextNode("Export"),
    );
    exportBtn.addEventListener("click", () => this.callbacks.onExport?.());

    end.append(addNodeBtn, saveBtn, exportBtn);

    this.canvas.toolbarEl.replaceChildren(
      start,
      this.canvas.zoomControlsEl,
      end,
    );
  }

  /**
   * Identity color picker: trigger swatch + popover with the 64-color neon
   * palette (8×8 grid). The color tints the focused composer border while
   * this graph is the selected run mode; the value round-trips on save.
   */
  private composeColorPicker(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "graph-editor-color-wrap";

    this.colorButton = document.createElement("button");
    this.colorButton.type = "button";
    this.colorButton.className = "graph-editor-color-btn";
    this.colorButton.title =
      "Graph color — tints the focused composer border when this graph is selected";
    this.colorButton.setAttribute("aria-label", "Graph color");
    this.colorButton.setAttribute("aria-haspopup", "true");
    this.colorButton.setAttribute("aria-expanded", "false");
    this.colorSwatch = document.createElement("span");
    this.colorSwatch.className = "graph-editor-color-swatch";
    this.colorSwatch.setAttribute("aria-hidden", "true");
    this.colorButton.append(this.colorSwatch);

    this.colorMenu = document.createElement("div");
    this.colorMenu.className = "graph-editor-color-menu";
    this.colorMenu.setAttribute("role", "radiogroup");
    this.colorMenu.setAttribute("aria-label", "Neon palette");
    this.colorMenu.hidden = true;

    const grid = document.createElement("div");
    grid.className = "graph-editor-color-grid";
    for (const color of NEON_PALETTE) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "graph-editor-color-cell";
      cell.style.setProperty("--c", color);
      cell.title = color;
      cell.setAttribute("role", "radio");
      cell.setAttribute("aria-checked", "false");
      cell.addEventListener("click", () => {
        this.selectGraphColor(color);
        this.setColorMenuOpen(false);
      });
      this.colorCells.push(cell);
      grid.append(cell);
    }
    this.colorMenu.append(grid);

    this.colorButton.addEventListener("click", () => {
      this.setColorMenuOpen(!this.colorMenuOpen);
    });
    // Outside press dismisses the palette (capture: settle before other
    // handlers can move focus).
    this.colorOutsideDismiss = (event: PointerEvent) => {
      if (!this.colorMenuOpen) return;
      if (event.target instanceof Node && wrap.contains(event.target)) return;
      this.setColorMenuOpen(false);
    };
    document.addEventListener(
      "pointerdown",
      this.colorOutsideDismiss,
      true,
    );

    wrap.append(this.colorButton, this.colorMenu);
    return wrap;
  }

  private setColorMenuOpen(open: boolean): void {
    this.colorMenuOpen = open;
    this.colorMenu.hidden = !open;
    this.colorButton.classList.toggle("is-open", open);
    this.colorButton.setAttribute("aria-expanded", open ? "true" : "false");
  }

  /** Apply a picked palette color to the trigger + selection ring. */
  private selectGraphColor(color: string): void {
    this.currentColor = color;
    this.refreshColorVisuals();
  }

  /** Swatch fill + palette selection state from `currentColor`. */
  private refreshColorVisuals(): void {
    this.colorSwatch.style.setProperty("--c", this.currentColor);
    for (const cell of this.colorCells) {
      const selected = cell.title === this.currentColor;
      cell.classList.toggle("is-selected", selected);
      cell.setAttribute("aria-checked", selected ? "true" : "false");
    }
  }

  destroy(): void {
    document.removeEventListener(
      "pointerdown",
      this.colorOutsideDismiss,
      true,
    );
    disposeInspectorTip();
    this.canvas.destroy();
  }

  /** So Delete / Backspace reach the editor (not trapped by a lost focus). */
  focusShell(): void {
    this.root.focus({ preventScroll: true });
  }

  setCallbacks(callbacks: Partial<GraphEditorViewCallbacks>): void {
    this.callbacks = callbacks;
  }

  setGraphName(name: string): void {
    this.titleInput.value = name;
  }

  getGraphName(): string {
    return this.titleInput.value.trim();
  }

  /** Seed the color swatch; invalid/absent stored colors fall back to violet. */
  setGraphColor(color: string | null | undefined, fallback: string): void {
    const hex = typeof color === "string" ? color.trim().toLowerCase() : "";
    this.currentColor = /^#[0-9a-f]{6}$/.test(hex) ? hex : fallback;
    this.refreshColorVisuals();
  }

  /** Always a valid `#rrggbb` (seeded via setGraphColor before save can run). */
  getGraphColor(): string {
    return this.currentColor;
  }

  setStatus(message: string | null, kind: "error" | "info" = "info"): void {
    if (!message) {
      this.statusEl.hidden = true;
      return;
    }
    this.statusEl.hidden = false;
    this.statusEl.textContent = message;
    this.statusEl.dataset.kind = kind;
  }

  updateCanvas(
    config: GraphConfigJson,
    nodeLayout: NodeLayoutMap | undefined,
    selectedNodeId: string | null,
    options?: { resetCamera?: boolean; selectedWire?: SelectedWire | null },
  ): NodeLayoutMap {
    return this.canvas.update(config, nodeLayout, selectedNodeId, options);
  }

  setInspector(content: HTMLElement): void {
    hideInspectorTip();
    const hasContent = content.childElementCount > 0 || content.textContent?.trim();
    this.inspectorHost.hidden = !hasContent;
    this.inspectorScrollHost.replaceChildren(content);
    if (!hasContent) {
      this.inspectorResizeHover = false;
      this.setInspectorResizeKnobVisible(false);
    }
  }

  hideActionOverlay(): void {
    this.actionOverlay.hidden = true;
  }

  /**
   * Floating list of actions on the selected node (canvas overlay).
   * Shell (header / drag) is stable; only body content is refreshed.
   */
  setActionOverlay(options: {
    nodeId: string;
    actions: Array<{
      type: string;
      index: number;
      label: string;
      summary: string | null;
      details: string | null;
    }>;
    selectedIndex: number | null;
    actionCatalog: Array<{ type: string; label: string }>;
  }): void {
    hideDetailsTip();
    this.cancelActionRowDrag();
    this.actionOverlay.hidden = false;
    this.actionOverlayTitle.textContent = `Actions · ${options.nodeId}`;

    this.actionOverlayList.replaceChildren();
    const rows: HTMLElement[] = [];
    if (options.actions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "graph-editor-muted";
      empty.textContent = "No actions on this node yet.";
      this.actionOverlayList.append(empty);
    } else {
      for (const action of options.actions) {
        const row = document.createElement("div");
        row.className = "graph-editor-action-chip";
        if (action.index === options.selectedIndex) {
          row.classList.add("is-selected");
        }
        row.tabIndex = 0;
        row.setAttribute("role", "button");
        row.title = "Drag to reorder · ⌥↑/⌥↓ to move";
        const grip = document.createElement("span");
        grip.className = "graph-editor-action-chip-grip";
        grip.setAttribute("aria-hidden", "true");
        grip.append(createLucideIcon(GripVertical, { size: 13 }));
        const label = document.createElement("span");
        label.className = "graph-editor-action-chip-label";
        label.textContent = action.label;
        const type = document.createElement("span");
        type.className = "graph-editor-action-chip-type";
        type.textContent = action.type;
        const text = document.createElement("span");
        text.className = "graph-editor-action-chip-text";
        text.append(label, type);
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "graph-editor-icon-chip";
        rm.title = "Remove action";
        rm.append(createLucideIcon(Trash2, { size: 12 }));
        rm.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.callbacks.onRemoveAction?.(action.index);
        });
        row.append(grip, text, rm);
        bindDetailsTip(row, {
          title: action.label,
          subtitle: action.type,
          body: action.details ?? action.summary,
        });
        row.addEventListener("click", () => {
          if (this.suppressRowClick) {
            this.suppressRowClick = false;
            return;
          }
          this.callbacks.onSelectAction?.(action.index);
        });
        row.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            this.callbacks.onSelectAction?.(action.index);
            return;
          }
          if (
            ev.altKey &&
            (ev.key === "ArrowUp" || ev.key === "ArrowDown")
          ) {
            ev.preventDefault();
            const to =
              ev.key === "ArrowUp" ? action.index - 1 : action.index + 1;
            if (to >= 0 && to < options.actions.length) {
              this.callbacks.onReorderAction?.(action.index, to);
            }
          }
        });
        rows.push(row);
        this.actionOverlayList.append(row);
      }
      this.bindActionRowReorder(rows);
    }

    this.actionOverlayAdd.replaceChildren();
    const select = document.createElement("select");
    select.className = "graph-editor-control";
    for (const entry of options.actionCatalog) {
      const opt = document.createElement("option");
      opt.value = entry.type;
      opt.textContent = entry.label;
      select.append(opt);
    }
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "setting-btn action-primary";
    addBtn.append(
      createLucideIcon(Plus, { size: 14 }),
      document.createTextNode("Add"),
    );
    addBtn.addEventListener("click", () => {
      if (select.value) this.callbacks.onAddAction?.(select.value);
    });
    this.actionOverlayAdd.append(select, addBtn);
  }

  /**
   * Pointer-based row reorder for the action list: a 4px threshold starts
   * the drag (plain clicks still select), sibling rows glide aside with
   * transforms, and the drop splices the node's action order.
   */
  private bindActionRowReorder(rows: HTMLElement[]): void {
    if (rows.length < 2) return;
    const GAP = 4; // .graph-editor-action-overlay-list gap
    rows.forEach((row, index) => {
      row.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0 || this.actionRowDrag) return;
        if ((ev.target as Element).closest("button")) return;
        this.actionRowDrag = {
          pointerId: ev.pointerId,
          from: index,
          startY: ev.clientY,
          row,
          rows,
          centers: [],
          dragSlot: 0,
          active: false,
          target: index,
        };
        row.setPointerCapture(ev.pointerId);
      });
      row.addEventListener("pointermove", (ev) => {
        const drag = this.actionRowDrag;
        if (!drag || drag.pointerId !== ev.pointerId || drag.row !== row) {
          return;
        }
        const dy = ev.clientY - drag.startY;
        if (!drag.active) {
          if (Math.abs(dy) < 4) return;
          drag.active = true;
          hideDetailsTip();
          drag.centers = rows.map(
            (r) => r.offsetTop + r.offsetHeight / 2,
          );
          drag.dragSlot = row.offsetHeight + GAP;
          row.classList.add("is-reorder-live", "is-reorder-dragging");
        }
        ev.preventDefault();
        // Insert slot from the dragged row's live center.
        const liveCenter = drag.centers[drag.from]! + dy;
        let slot = 0;
        for (let i = 0; i < drag.centers.length; i += 1) {
          if (liveCenter > drag.centers[i]!) slot = i + 1;
        }
        const target = slot > drag.from ? slot - 1 : slot;
        drag.target = target;
        rows.forEach((r, i) => {
          if (i === drag.from) {
            r.style.transform = `translateY(${dy}px)`;
          } else if (i > drag.from && i <= target) {
            r.style.transform = `translateY(${-drag.dragSlot}px)`;
          } else if (i < drag.from && i >= target) {
            r.style.transform = `translateY(${drag.dragSlot}px)`;
          } else {
            r.style.transform = "";
          }
        });
      });
      const finish = (ev: PointerEvent) => {
        const drag = this.actionRowDrag;
        if (!drag || drag.pointerId !== ev.pointerId || drag.row !== row) {
          return;
        }
        this.actionRowDrag = null;
        rows.forEach((r) => {
          r.style.transform = "";
          r.classList.remove("is-reorder-live", "is-reorder-dragging");
        });
        if (drag.active) {
          this.suppressRowClick = true;
          if (drag.target !== drag.from) {
            this.callbacks.onReorderAction?.(drag.from, drag.target);
          }
        }
      };
      row.addEventListener("pointerup", finish);
      row.addEventListener("pointercancel", finish);
    });
  }

  /** Drop any in-flight row drag (list is about to be re-rendered). */
  private cancelActionRowDrag(): void {
    const drag = this.actionRowDrag;
    if (!drag) return;
    this.actionRowDrag = null;
    drag.rows.forEach((r) => {
      r.style.transform = "";
      r.classList.remove("is-reorder-live", "is-reorder-dragging");
    });
  }

  private bindOverlayDrag(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      if ((ev.target as Element).closest("button")) return;
      const rect = this.actionOverlay.getBoundingClientRect();
      const hostRect = this.canvasHost.getBoundingClientRect();
      this.overlayDrag = {
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        originLeft: rect.left - hostRect.left,
        originTop: rect.top - hostRect.top,
      };
      this.actionOverlay.classList.add("is-dragging");
      handle.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });

    handle.addEventListener("pointermove", (ev) => {
      if (!this.overlayDrag || this.overlayDrag.pointerId !== ev.pointerId) {
        return;
      }
      const dx = ev.clientX - this.overlayDrag.startX;
      const dy = ev.clientY - this.overlayDrag.startY;
      const hostW = this.canvasHost.clientWidth;
      const hostH = this.canvasHost.clientHeight;
      const boxW = this.actionOverlay.offsetWidth;
      const boxH = this.actionOverlay.offsetHeight;
      const left = Math.min(
        Math.max(8, this.overlayDrag.originLeft + dx),
        Math.max(8, hostW - boxW - 8),
      );
      const top = Math.min(
        Math.max(8, this.overlayDrag.originTop + dy),
        Math.max(8, hostH - boxH - 8),
      );
      this.actionOverlay.style.left = `${left}px`;
      this.actionOverlay.style.top = `${top}px`;
      this.actionOverlay.style.right = "auto";
    });

    const endDrag = (ev: PointerEvent): void => {
      if (!this.overlayDrag || this.overlayDrag.pointerId !== ev.pointerId) {
        return;
      }
      this.overlayDrag = null;
      this.actionOverlay.classList.remove("is-dragging");
      if (handle.hasPointerCapture(ev.pointerId)) {
        handle.releasePointerCapture(ev.pointerId);
      }
    };
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
  }

  buildInspectorShell(options: {
    nodeId: string;
    nodeName: string;
    selfLoop: boolean;
    pins: Array<{ name: string; target: string }>;
    canRemoveNode: boolean;
    selectedAction: {
      type: string;
      label: string;
      description: string | null;
      details: string | null;
    } | null;
  }): { shell: HTMLElement; paramsFormHost: HTMLElement | null } {
    const wrap = document.createElement("div");
    wrap.className = "graph-editor-inspector-inner";

    const nodeBody = document.createElement("div");
    const nameRow = this.fieldRow("Name");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "graph-editor-control";
    nameInput.value = options.nodeName;
    nameInput.addEventListener("change", () => {
      this.callbacks.onNodeNameChange?.(nameInput.value);
    });
    nameRow.append(nameInput);

    const loopRow = document.createElement("label");
    loopRow.className = "graph-editor-row graph-editor-row-check";
    const loopLabel = document.createElement("span");
    loopLabel.className = "graph-editor-row-label";
    loopLabel.textContent = "Self-loop";
    bindInspectorTip(
      loopLabel,
      "Fallback edge back to this node when no pin matches.",
    );
    const loopCheck = document.createElement("input");
    loopCheck.type = "checkbox";
    loopCheck.checked = options.selfLoop;
    loopCheck.addEventListener("change", () => {
      this.callbacks.onSelfLoopChange?.(loopCheck.checked);
    });
    loopRow.append(loopLabel, loopCheck);
    nodeBody.append(nameRow, loopRow);

    if (options.canRemoveNode) {
      const actions = document.createElement("div");
      actions.className = "graph-editor-inspector-actions";
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "setting-btn graph-editor-danger-btn action-danger";
      removeBtn.append(
        createLucideIcon(Trash2, { size: 14 }),
        document.createTextNode("Remove"),
      );
      removeBtn.addEventListener("click", () => this.callbacks.onRemoveNode?.());
      actions.append(removeBtn);
      nodeBody.append(actions);
    }

    wrap.append(
      this.inspectorCard({
        title: "Node",
        description: options.nodeId,
        icon: Box,
        body: nodeBody,
      }),
    );

    const pinBody = document.createElement("div");
    if (options.pins.length === 0) {
      const empty = document.createElement("p");
      empty.className = "graph-editor-muted";
      empty.textContent = "None";
      bindInspectorTip(empty, "Alt-drag from this node onto another to wire.");
      pinBody.append(empty);
    } else {
      const pinList = document.createElement("ul");
      pinList.className = "graph-editor-pin-list";
      for (const pin of options.pins) {
        const li = document.createElement("li");
        li.className = "graph-editor-pin-row";
        const name = document.createElement("span");
        name.className = "graph-editor-pin-name";
        name.textContent = pin.name;
        const target = document.createElement("span");
        target.className = "graph-editor-pin-target";
        target.textContent = pin.target;
        li.append(name, target);
        pinList.append(li);
      }
      pinBody.append(pinList);
    }

    wrap.append(
      this.inspectorCard({
        title: "Pins",
        description:
          options.pins.length === 0
            ? "No wires"
            : `${options.pins.length} wired`,
        icon: Plug,
        body: pinBody,
      }),
    );

    const paramsHost = document.createElement("div");
    paramsHost.className = "graph-editor-params-host";
    let paramsFormHost: HTMLElement | null = null;

    if (!options.selectedAction) {
      const hint = document.createElement("p");
      hint.className = "graph-editor-muted";
      hint.textContent = "Select an action to edit.";
      paramsHost.append(hint);
    } else {
      paramsFormHost = document.createElement("div");
      paramsFormHost.className = "graph-editor-params-form";
      paramsHost.append(paramsFormHost);
    }

    const details = options.selectedAction?.details ?? null;
    let helpChip: HTMLElement | null = null;
    if (details && options.selectedAction) {
      helpChip = this.buildActionHelpChip(options.selectedAction, details);
    }

    const actionCard = this.inspectorCard({
      title: options.selectedAction?.label ?? "Action",
      description: options.selectedAction?.type ?? "No action selected",
      icon: SlidersHorizontal,
      body: paramsHost,
      ...(helpChip ? { headerWidget: helpChip } : {}),
    });
    if (options.selectedAction) {
      const titleEl = actionCard.querySelector(".setting-card-title");
      if (titleEl instanceof HTMLElement) {
        bindInspectorTip(
          titleEl,
          options.selectedAction.description ?? options.selectedAction.type,
        );
      }
    }
    wrap.append(actionCard);

    return { shell: wrap, paramsFormHost };
  }

  /**
   * [?] chip in the action card header: hovering shows the same rich details
   * float as the action chips; clicking pins it open (click again / click
   * outside / leave the float to dismiss). No in-card panel — the card must
   * not change height.
   */
  private buildActionHelpChip(
    action: { type: string; label: string },
    details: string,
  ): HTMLElement {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "graph-editor-icon-chip graph-editor-help-chip";
    chip.title = "What this action does";
    chip.setAttribute("aria-label", "Action details");
    chip.append(createLucideIcon(CircleHelp, { size: 14 }));
    bindDetailsTip(
      chip,
      { title: action.label, subtitle: action.type, body: details },
      { pinOnClick: true },
    );
    return chip;
  }

  private inspectorCard(options: {
    title: string;
    description?: string;
    icon: IconNode;
    body: HTMLElement;
    headerWidget?: HTMLElement;
  }): HTMLElement {
    const card = document.createElement("article");
    card.className = "setting-card graph-editor-inspector-card";

    const header = document.createElement("div");
    header.className = "setting-card-header";
    const iconWrap = document.createElement("div");
    iconWrap.className = "setting-card-icon";
    iconWrap.append(createLucideIcon(options.icon, { size: 16 }));
    const titles = document.createElement("div");
    titles.className = "setting-card-titles";
    const title = document.createElement("h3");
    title.className = "setting-card-title";
    title.textContent = options.title;
    titles.append(title);
    if (options.description) {
      const desc = document.createElement("p");
      desc.className = "setting-card-desc";
      desc.textContent = options.description;
      titles.append(desc);
    }
    header.append(iconWrap, titles);
    if (options.headerWidget) {
      header.append(options.headerWidget);
    }

    const body = document.createElement("div");
    body.className = "setting-card-body";
    body.append(options.body);

    card.append(header, body);
    return card;
  }

  private fieldRow(labelText: string): HTMLElement {
    const row = document.createElement("label");
    row.className = "graph-editor-row";
    const label = document.createElement("span");
    label.className = "graph-editor-row-label";
    label.textContent = labelText;
    row.append(label);
    return row;
  }
}
