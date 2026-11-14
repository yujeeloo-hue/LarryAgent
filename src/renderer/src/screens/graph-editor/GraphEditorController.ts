import { ParamsFormView } from "./ParamsFormView.js";
import type { GraphEditorView } from "./GraphEditorView.js";
import {
  addAction,
  reorderAction,
  addIntermediateNode,
  edgeTargetForPin,
  GRAPH_NODE_END,
  GRAPH_NODE_START,
  pinNamesOfNode,
  pruneUnwiredPins,
  removeAction,
  removeNode,
  removeWire,
  updateActionParams,
  updateNodeMeta,
  wireNodeToNode,
  wiredPinNames,
  type GraphConfigJson,
} from "./graphConfigEdit.js";
import {
  dropNodeFromLayout,
  type NodeLayoutMap,
} from "./graphEditorLayout.js";
import type { SelectedWire } from "./GraphEditorCanvas.js";
import { schemaDetails } from "./actionDetails.js";
import { showTextPromptDialog } from "../../ui/TextPromptDialogView.js";
import { DEFAULT_CUSTOM_GRAPH_COLOR } from "../../ui/taskComposer/composerAccent.js";

function requireBridge(): NonNullable<Window["jellybot"]> {
  if (!window.jellybot) {
    throw new Error("JellyBot bridge is not available");
  }
  return window.jellybot;
}

function actionLabel(
  type: string,
  catalog?: Array<{ type: string; title?: string }>,
): string {
  const titled = catalog?.find((e) => e.type === type)?.title?.trim();
  if (titled) return titled;
  return type.replace(/^NodeAction/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function schemaDescription(schema: Record<string, unknown> | undefined): string | null {
  if (!schema) return null;
  const desc = schema.description;
  return typeof desc === "string" && desc.trim() ? desc.trim() : null;
}

/** Long-form action help (paramsSchema.details) for hover tip / [?] panel. */
function catalogDetails(entry: FsmActionCatalogEntry | undefined): string | null {
  return schemaDetails(entry?.paramsSchema as Record<string, unknown> | undefined);
}

/** Events for RouteTo dropdowns: sibling x-emitsRouteEvents + routeGuide. */
function collectRouteEventOptions(
  actions: Array<{ type: string; params?: Record<string, unknown> }>,
  catalog: FsmActionCatalogEntry[],
): string[] {
  const events = new Set<string>(["stay", "leave"]);
  for (const action of actions) {
    const entry = catalog.find((e) => e.type === action.type);
    const declared = entry?.paramsSchema?.["x-emitsRouteEvents"];
    if (Array.isArray(declared)) {
      for (const raw of declared) {
        if (typeof raw === "string" && raw.trim()) events.add(raw.trim());
      }
    }
    const guide = action.params?.routeGuide;
    if (!Array.isArray(guide)) continue;
    for (const row of guide) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const routeTo = (row as { routeTo?: unknown }).routeTo;
      if (typeof routeTo === "string" && routeTo.trim()) {
        events.add(routeTo.trim());
      }
    }
  }
  return [...events].sort((a, b) => a.localeCompare(b));
}

export type GraphEditorControllerOptions = {
  graphId: string;
  onBack: () => void;
};

/** Custom FSM graph blueprint editor (Phase 2 MVP). */
export class GraphEditorController {
  private destroyed = false;
  private record: FsmGraphLibraryRecord | null = null;
  private selectedNodeId: string | null = null;
  private selectedWire: SelectedWire | null = null;
  private selectedActionIndex: number | null = null;
  /** When false, action overlay stays hidden until the user selects a node again. */
  private actionOverlayOpen = false;
  private actionCatalog: FsmActionCatalogEntry[] = [];
  private firstPaint = true;
  private readonly paramsForm = new ParamsFormView();
  /**
   * Seeded node positions from the last auto-routed render (no manual
   * layout yet). Used to place newly added nodes sensibly in auto mode.
   */
  private lastAutoLayout: NodeLayoutMap | undefined;

  /** Shell reads this to restore the editor after a Settings round-trip. */
  get graphId(): string {
    return this.options.graphId;
  }

  constructor(
    private readonly view: GraphEditorView,
    private readonly options: GraphEditorControllerOptions,
  ) {
    this.view.setCallbacks({
      onBack: () => this.options.onBack(),
      onSave: () => void this.save(),
      onExport: () => this.exportJson(),
      onAddNode: () => void this.promptAddNode(),
      onNodeSelect: (id) => this.selectNode(id),
      onClearSelection: () => this.clearSelection(),
      onAutoArrange: () => this.tidy(),
      onWireSelect: (fromId, toId) => this.selectWire(fromId, toId),
      onDeleteSelection: () => this.deleteSelection(),
      onWireNodes: (fromId, toId) => {
        this.selectedNodeId = null;
        this.selectedWire = { from: fromId, to: toId };
        this.selectedActionIndex = null;
        this.actionOverlayOpen = false;
        this.mutate((c) => wireNodeToNode(c, fromId, toId));
        this.view.focusShell();
      },
      onNodeLayoutChange: (layout) => {
        if (!this.record) return;
        this.record = { ...this.record, nodeLayout: layout };
      },
      onNodeNameChange: (name) => this.patchNodeMeta({ name }),
      onSelfLoopChange: (enabled) => this.patchNodeMeta({ selfLoop: enabled }),
      onSelectAction: (index) => {
        this.selectedActionIndex = index;
        this.actionOverlayOpen = true;
        this.renderInspectorOnly();
      },
      onCloseActionOverlay: () => {
        this.actionOverlayOpen = false;
        this.selectedActionIndex = null;
        this.renderInspectorOnly();
      },
      onAddAction: (type) => {
        if (!this.selectedNodeId) return;
        const nodeId = this.selectedNodeId;
        this.mutate((c) => addAction(c, nodeId, type), undefined, {
          after: () => {
            const node = this.record?.config.nodes.find((n) => n.id === nodeId);
            const len = node?.actions?.length ?? 0;
            this.selectedActionIndex = len > 0 ? len - 1 : null;
          },
        });
      },
      onRemoveAction: (index) => {
        if (!this.selectedNodeId) return;
        this.mutate((c) => removeAction(c, this.selectedNodeId!, index));
        if (this.selectedActionIndex === index) {
          this.selectedActionIndex = null;
        } else if (
          this.selectedActionIndex !== null &&
          this.selectedActionIndex > index
        ) {
          this.selectedActionIndex -= 1;
        }
      },
      onReorderAction: (from, to) => {
        if (!this.selectedNodeId || from === to) return;
        const nodeId = this.selectedNodeId;
        this.mutate((c) => reorderAction(c, nodeId, from, to), undefined, {
          after: () => {
            // Keep the inspector glued to the action the user is editing.
            const sel = this.selectedActionIndex;
            if (sel === null) return;
            if (sel === from) this.selectedActionIndex = to;
            else if (from < to && sel > from && sel <= to)
              this.selectedActionIndex = sel - 1;
            else if (from > to && sel >= to && sel < from)
              this.selectedActionIndex = sel + 1;
          },
        });
      },
      onRemoveNode: () => {
        if (!this.selectedNodeId || !this.record) return;
        const removedId = this.selectedNodeId;
        this.mutate(
          (c) => pruneUnwiredPins(removeNode(c, removedId)),
          {
            nodeLayout: dropNodeFromLayout(this.record!.nodeLayout, removedId),
          },
        );
        this.selectedNodeId = null;
        this.selectedWire = null;
        this.selectedActionIndex = null;
        this.actionOverlayOpen = false;
        this.view.hideActionOverlay();
      },
    });
  }

  mount(): HTMLElement {
    void this.load();
    return this.view.root;
  }

  destroy(): void {
    this.destroyed = true;
    this.paramsForm.destroy();
    this.view.destroy();
  }

  private async load(): Promise<void> {
    this.view.setStatus(null);
    try {
      const [record, catalog] = await Promise.all([
        requireBridge().getFsmGraph(this.options.graphId),
        requireBridge().fsmActionCatalog(),
      ]);
      if (this.destroyed) return;
      if (!record) {
        this.view.setStatus("Graph not found.", "error");
        return;
      }
      const pruned = pruneUnwiredPins(record.config as GraphConfigJson);
      this.record = {
        ...record,
        config: pruned as FsmGraphLibraryRecord["config"],
      };
      this.actionCatalog = catalog;
      this.view.setGraphName(record.name);
      this.view.setGraphColor(record.color, DEFAULT_CUSTOM_GRAPH_COLOR);
      this.selectedNodeId = null;
      this.selectedWire = null;
      this.selectedActionIndex = null;
      this.actionOverlayOpen = false;
      this.render();
      this.view.focusShell();
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to load graph.";
      this.view.setStatus(message, "error");
    }
  }

  private render(options?: { resetCamera?: boolean }): void {
    if (!this.record) return;
    const config = this.record.config as GraphConfigJson;
    const resetCamera = options?.resetCamera ?? this.firstPaint;
    // Auto mode (no manual nodeLayout): keep the viewer's corridor routing.
    // The seeded positions are not persisted — any node drag stores a real
    // nodeLayout and switches edges back to follow-the-node beziers.
    const manual = this.record.nodeLayout;
    const layout = this.view.updateCanvas(
      config,
      manual,
      this.selectedNodeId,
      { resetCamera, selectedWire: this.selectedWire },
    );
    if (manual) {
      this.record = { ...this.record, nodeLayout: layout };
      this.lastAutoLayout = undefined;
    } else {
      this.lastAutoLayout = layout;
    }
    this.firstPaint = false;
    this.renderInspector(config);
    this.renderActionOverlay(config);
  }

  /**
   * Tidy: drop manual node positions and re-run the viewer's auto layout —
   * nodes return to the layered grid and wires to corridor routing.
   */
  private tidy(): void {
    if (!this.record) return;
    const { nodeLayout: _drop, ...rest } = this.record;
    this.record = rest;
    this.render({ resetCamera: true });
  }

  private renderInspectorOnly(): void {
    if (!this.record) return;
    const config = this.record.config as GraphConfigJson;
    this.renderInspector(config);
    this.renderActionOverlay(config);
  }

  private selectNode(nodeId: string): void {
    if (this.selectedNodeId === nodeId && !this.selectedWire) {
      // Re-clicking the same node reopens a closed overlay.
      this.actionOverlayOpen = true;
      this.renderInspectorOnly();
      return;
    }
    this.selectedNodeId = nodeId;
    this.selectedWire = null;
    this.selectedActionIndex = null;
    this.actionOverlayOpen = true;
    this.render();
  }

  private selectWire(fromId: string, toId: string): void {
    if (
      this.selectedWire?.from === fromId &&
      this.selectedWire?.to === toId
    ) {
      this.view.focusShell();
      return;
    }
    this.selectedWire = { from: fromId, to: toId };
    this.selectedNodeId = null;
    this.selectedActionIndex = null;
    this.actionOverlayOpen = false;
    this.render();
    this.view.focusShell();
  }

  private deleteSelection(): void {
    if (!this.record || !this.selectedWire) return;
    const { from, to } = this.selectedWire;
    this.selectedWire = null;
    this.mutate((c) => removeWire(c, from, to));
  }

  private clearSelection(): void {
    if (
      this.selectedNodeId === null &&
      this.selectedWire === null &&
      this.selectedActionIndex === null &&
      !this.actionOverlayOpen
    ) {
      return;
    }
    this.selectedNodeId = null;
    this.selectedWire = null;
    this.selectedActionIndex = null;
    this.actionOverlayOpen = false;
    this.render();
  }

  private renderActionOverlay(config: GraphConfigJson): void {
    const nodeId = this.selectedNodeId;
    if (!nodeId || !this.actionOverlayOpen) {
      this.view.hideActionOverlay();
      return;
    }
    const node = config.nodes.find((n) => n.id === nodeId);
    if (!node) {
      this.view.hideActionOverlay();
      return;
    }
    this.view.setActionOverlay({
      nodeId,
      actions: (node.actions ?? []).map((a, index) => {
        const entry = this.actionCatalog.find((e) => e.type === a.type);
        return {
          type: a.type,
          index,
          label: actionLabel(a.type, this.actionCatalog),
          summary: schemaDescription(
            entry?.paramsSchema as Record<string, unknown> | undefined,
          ),
          details: catalogDetails(entry),
        };
      }),
      selectedIndex: this.selectedActionIndex,
      actionCatalog: this.actionCatalog.map((e) => ({
        type: e.type,
        label: actionLabel(e.type, this.actionCatalog),
      })),
    });
  }

  private renderInspector(config: GraphConfigJson): void {
    const nodeId = this.selectedNodeId;
    if (!nodeId) {
      this.view.setInspector(document.createElement("div"));
      this.view.hideActionOverlay();
      return;
    }
    const node = config.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const wired = wiredPinNames(config, nodeId);
    const pins = [...wired]
      .map((name) => ({
        name,
        target: edgeTargetForPin(config, nodeId, name) ?? "?",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    let selectedAction: {
      type: string;
      label: string;
      description: string | null;
      details: string | null;
    } | null = null;
    const actions = node.actions ?? [];
    if (
      this.selectedActionIndex !== null &&
      this.selectedActionIndex >= 0 &&
      this.selectedActionIndex < actions.length
    ) {
      const action = actions[this.selectedActionIndex]!;
      const catalog = this.actionCatalog.find((e) => e.type === action.type);
      selectedAction = {
        type: action.type,
        label: actionLabel(action.type, this.actionCatalog),
        description: schemaDescription(
          catalog?.paramsSchema as Record<string, unknown> | undefined,
        ),
        details: catalogDetails(catalog),
      };
    }

    const { shell, paramsFormHost } = this.view.buildInspectorShell({
      nodeId,
      nodeName: node.name ?? nodeId,
      selfLoop: node.selfLoop === true,
      pins,
      canRemoveNode:
        nodeId !== GRAPH_NODE_START && nodeId !== GRAPH_NODE_END,
      selectedAction,
    });

    if (
      paramsFormHost &&
      this.selectedActionIndex !== null &&
      actions[this.selectedActionIndex]
    ) {
      const action = actions[this.selectedActionIndex]!;
      const catalog = this.actionCatalog.find((e) => e.type === action.type);
      const pinNames = pinNamesOfNode(config, nodeId);
      const actionIndex = this.selectedActionIndex;
      if (catalog?.paramsSchema) {
        this.paramsForm.mount(
          paramsFormHost,
          catalog.paramsSchema as Record<string, unknown>,
          { ...(action.params ?? {}) },
          pinNames,
          (params) => {
            if (!this.record) return;
            const nextConfig = updateActionParams(
              this.record.config as GraphConfigJson,
              nodeId,
              actionIndex,
              params,
            );
            this.record = {
              ...this.record,
              config: nextConfig as FsmGraphLibraryRecord["config"],
            };
          },
          {
            routeEventOptions: collectRouteEventOptions(
              actions,
              this.actionCatalog,
            ),
          },
        );
      } else {
        const note = document.createElement("p");
        note.className = "graph-editor-muted";
        note.textContent = "No parameters.";
        paramsFormHost.append(note);
      }
    }

    this.view.setInspector(shell);
  }

  private patchNodeMeta(patch: {
    name?: string;
    selfLoop?: boolean;
  }): void {
    if (!this.selectedNodeId) return;
    this.mutate((c) => updateNodeMeta(c, this.selectedNodeId!, patch));
  }

  private mutate(
    mutator: (config: GraphConfigJson) => GraphConfigJson,
    patch?: { nodeLayout?: NodeLayoutMap | undefined },
    options?: { after?: () => void },
  ): void {
    if (!this.record) return;
    const nextConfig = pruneUnwiredPins(
      mutator(this.record.config as GraphConfigJson),
    );
    this.record = {
      ...this.record,
      config: nextConfig as FsmGraphLibraryRecord["config"],
    };
    if (patch && "nodeLayout" in patch) {
      if (patch.nodeLayout) {
        this.record = { ...this.record, nodeLayout: patch.nodeLayout };
      } else {
        const { nodeLayout: _drop, ...rest } = this.record;
        this.record = rest;
      }
    }
    options?.after?.();
    this.render();
  }

  private async promptAddNode(): Promise<void> {
    if (!this.record) return;
    const id = await showTextPromptDialog({
      title: "Add node",
      message: "Enter a unique node id (not start or end).",
      confirmLabel: "Add",
    });
    if (!id?.trim() || this.destroyed || !this.record) return;
    const trimmed = id.trim();
    if (trimmed === GRAPH_NODE_START || trimmed === GRAPH_NODE_END) {
      this.view.setStatus(`"${trimmed}" is reserved.`, "error");
      return;
    }
    const config = this.record.config as GraphConfigJson;
    if (config.nodes.some((n) => n.id === trimmed)) {
      this.view.setStatus(`Node "${trimmed}" already exists.`, "error");
      return;
    }

    const layout: NodeLayoutMap = {
      ...(this.record.nodeLayout ?? this.lastAutoLayout ?? {}),
    };
    const GRID = 16;
    let x = 80;
    let y = 80;
    if (this.selectedNodeId && layout[this.selectedNodeId]) {
      const base = layout[this.selectedNodeId]!;
      x = base.x + 200;
      y = base.y;
    } else {
      const positions = Object.values(layout);
      if (positions.length > 0) {
        x = Math.max(...positions.map((p) => p.x)) + 200;
        y = Math.min(...positions.map((p) => p.y));
      }
    }
    layout[trimmed] = {
      x: Math.round(x / GRID) * GRID,
      y: Math.round(y / GRID) * GRID,
    };

    this.selectedNodeId = trimmed;
    this.selectedActionIndex = null;
    this.actionOverlayOpen = true;
    this.mutate(
      (c) => addIntermediateNode(c, trimmed, trimmed),
      { nodeLayout: layout },
    );
    this.view.setStatus(null);
  }

  private async save(): Promise<void> {
    if (!this.record) return;
    this.view.setStatus(null);
    const name = this.view.getGraphName() || this.record.name;
    const config = pruneUnwiredPins(this.record.config as GraphConfigJson);
    const payload: FsmGraphLibraryRecord = {
      ...this.record,
      name,
      color: this.view.getGraphColor(),
      config: config as FsmGraphLibraryRecord["config"],
      ...(this.record.nodeLayout ? { nodeLayout: this.record.nodeLayout } : {}),
    };
    try {
      await requireBridge().validateFsmGraph(payload.config);
      const saved = await requireBridge().saveFsmGraph(payload);
      if (this.destroyed) return;
      this.record = saved;
      this.view.setGraphName(saved.name);
      this.view.setGraphColor(saved.color, DEFAULT_CUSTOM_GRAPH_COLOR);
      this.view.setStatus("Saved.", "info");
      this.render();
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Validation or save failed.";
      this.view.setStatus(message, "error");
    }
  }

  private exportJson(): void {
    if (!this.record) return;
    const config = pruneUnwiredPins(this.record.config as GraphConfigJson);
    const blob = new Blob([JSON.stringify(config, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${this.view.getGraphName() || "graph"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
