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
import type { GraphIssue } from "../../../../agent/fsm/authoring/diagnostics.js";

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

function catalogDetails(entry: FsmActionCatalogEntry | undefined): string | null {
  return schemaDetails(entry?.paramsSchema as Record<string, unknown> | undefined);
}

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

export class GraphEditorController {
  private destroyed = false;
  private record: FsmGraphLibraryRecord | null = null;
  private selectedNodeId: string | null = null;
  private selectedWire: SelectedWire | null = null;
  private selectedActionIndex: number | null = null;
  private actionOverlayOpen = false;
  private actionCatalog: FsmActionCatalogEntry[] = [];
  private firstPaint = true;
  private saving = false;
  private validationRequest = 0;
  private validationTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly paramsForm = new ParamsFormView();
  private lastAutoLayout: NodeLayoutMap | undefined;

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
      onValidate: () => void this.validateGraph(),
      onLocateIssue: issue => this.locateIssue(issue),
      onCommit: () => void this.save(true),
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
    if (this.validationTimer) clearTimeout(this.validationTimer);
    this.paramsForm.destroy();
    this.view.destroy();
  }

  private async load(): Promise<void> {
    this.view.clearFeedback();
    try {
      const [record, catalog] = await Promise.all([
        requireBridge().getFsmGraph(this.options.graphId),
        requireBridge().fsmActionCatalog(),
      ]);
      if (this.destroyed) return;
      if (!record) {
        this.view.showFeedback({ tone: "error", title: "Graph not found", description: "This graph may have been deleted.", action: { label: "Retry", run: () => void this.load() } });
        return;
      }
      this.record = {
        ...record,
        config: structuredClone(record.config),
      };
      this.view.setDraftMode(!!record.draftContextId);
      this.view.setCommitEnabled(record.validation?.valid === true);
      this.actionCatalog = catalog;
      this.view.setGraphName(record.name);
      this.view.setGraphColor(record.color, DEFAULT_CUSTOM_GRAPH_COLOR);
      this.selectedNodeId = null;
      this.selectedWire = null;
      this.selectedActionIndex = null;
      this.actionOverlayOpen = false;
      this.render();
      this.view.focusShell();
      void this.refreshValidation();
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to load graph.";
      this.view.showFeedback({ tone: "error", title: "Couldn’t load the graph", description: message, action: { label: "Retry", run: () => void this.load() } });
    }
  }

  private render(options?: { resetCamera?: boolean }): void {
    if (!this.record) return;
    const config = this.record.config as GraphConfigJson;
    const resetCamera = options?.resetCamera ?? this.firstPaint;
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
            this.scheduleValidation();
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
    const nextConfig = mutator(this.record.config as GraphConfigJson);
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
    this.scheduleValidation();
  }

  private scheduleValidation(): void {
    this.validationRequest++;
    this.view.setValidating(false);
    this.view.setCommitEnabled(false);
    this.view.clearFeedback("validation");
    if (this.validationTimer) clearTimeout(this.validationTimer);
    this.validationTimer = setTimeout(() => void this.refreshValidation(), 200);
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
      this.view.showFeedback({ tone: "error", title: "Node ID is reserved", description: `Choose a node ID other than "${trimmed}".` });
      return;
    }
    const config = this.record.config as GraphConfigJson;
    if (config.nodes.some((n) => n.id === trimmed)) {
      this.view.showFeedback({ tone: "error", title: "Node already exists", description: `Choose a unique node ID. "${trimmed}" is already in this graph.` });
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
    this.view.clearFeedback();
  }

  private locateIssue(issue: GraphIssue): boolean {
    if (!this.record) return false;
    const config = this.record.config;
    const edgeIndex = issue.path.match(/^edges\[(\d+)\]/)?.[1];
    const edge = issue.edgeId ? config.edges.find(candidate => candidate.id === issue.edgeId) : edgeIndex !== undefined ? config.edges[Number(edgeIndex)] : undefined;
    if (edge) {
      this.selectWire(edge.from, edge.to);
      this.view.revealNode(edge.from);
      return true;
    }
    const nodeIndex = issue.path.match(/^nodes\[(\d+)\]/)?.[1];
    const node = config.nodes.find(candidate => candidate.id === issue.nodeId) ?? (nodeIndex !== undefined ? config.nodes[Number(nodeIndex)] : undefined);
    if (!node) return false;
    this.selectedNodeId = node.id;
    this.selectedWire = null;
    const actionIndex = issue.path.match(/\.actions\[(\d+)\]/)?.[1];
    const stableIndex = issue.actionId ? (node.actions ?? []).findIndex(action => (action as { id?: string }).id === issue.actionId) : -1;
    const index = stableIndex >= 0 ? stableIndex : actionIndex !== undefined ? Number(actionIndex) : -1;
    this.selectedActionIndex = index >= 0 && index < (node.actions?.length ?? 0) ? index : null;
    this.actionOverlayOpen = true;
    this.render();
    this.view.revealNode(node.id);
    return true;
  }

  private async validateGraph(): Promise<void> {
    if (this.validationTimer) clearTimeout(this.validationTimer);
    this.validationTimer = null;
    await this.refreshValidation(true);
  }

  private async refreshValidation(notify = false): Promise<void> {
    if (!this.record) return;
    const config = this.record.config;
    const request = ++this.validationRequest;
    if (notify) {
      this.view.setValidating(true);
      this.view.showFeedback({ tone: "loading", title: "Validating graph…", description: "Checking nodes, connections and action dependencies.", source: "validation" });
    }
    try {
      const validation = await requireBridge().analyzeFsmGraph(config);
      if (this.destroyed || request !== this.validationRequest || this.record.config !== config) return;
      this.view.setCommitEnabled(validation.valid);
      if (notify) this.view.showValidation(validation, issue => {
        const node = this.record?.config.nodes.find(candidate => candidate.id === issue.nodeId);
        if (!node) return issue.nodeId ?? issue.edgeId ?? issue.path;
        const index = issue.path.match(/\.actions\[(\d+)\]/)?.[1];
        const action = index !== undefined ? node.actions?.[Number(index)] : undefined;
        return action ? `${node.name || node.id} · ${actionLabel(action.type, this.actionCatalog)}` : node.name || node.id;
      });
    } catch (error) {
      if (this.destroyed || request !== this.validationRequest) return;
      this.view.setCommitEnabled(false);
      if (notify) this.view.showFeedback({ tone: "error", title: "Couldn’t validate the graph", description: error instanceof Error ? error.message : "Try validating again.", source: "validation", action: { label: "Retry", run: () => void this.validateGraph() } });
    } finally {
      if (!this.destroyed && request === this.validationRequest) this.view.setValidating(false);
    }
  }

  private async save(commit = false): Promise<void> {
    if (!this.record || this.saving) return;
    this.saving = true;
    this.validationRequest++;
    this.view.setValidating(false);
    this.view.clearFeedback();
    const submittedConfig = this.record.config;
    const submittedLayout = this.record.nodeLayout;
    const name = this.view.getGraphName() || this.record.name;
    const color = this.view.getGraphColor();
    const payload: FsmGraphLibraryRecord = {
      ...this.record,
      name,
      color,
      config: structuredClone(submittedConfig),
    };
    try {
      const saved = await (commit ? requireBridge().commitFsmGraphDraft(payload) : requireBridge().saveFsmGraph(payload));
      if (this.destroyed) return;
      const current = this.record;
      const newerConfig = current.config !== submittedConfig;
      const newerLayout = current.nodeLayout !== submittedLayout;
      const newerName = this.view.getGraphName() !== name;
      const newerColor = this.view.getGraphColor() !== color;
      this.record = { ...saved, config: newerConfig ? current.config : saved.config };
      if (newerLayout) {
        const { nodeLayout: _savedLayout, ...rest } = this.record;
        this.record = { ...rest, ...(current.nodeLayout ? { nodeLayout: current.nodeLayout } : {}) };
      }
      if (!newerName) this.view.setGraphName(saved.name);
      if (!newerColor) this.view.setGraphColor(saved.color, DEFAULT_CUSTOM_GRAPH_COLOR);
      this.view.setCommitEnabled(!newerConfig && saved.validation?.valid === true);
      const hasNewerEdits = newerConfig || newerLayout || newerName || newerColor;
      this.view.showFeedback({
        tone: hasNewerEdits ? "info" : "success",
        title: commit ? "Draft committed" : saved.draftContextId ? "Draft saved" : "Graph saved",
        description: hasNewerEdits ? "Newer edits are still unsaved." : commit ? "Enable the saved graph in Graphs when ready." : saved.validation?.valid === false ? "Your progress is saved. Fix the errors before enabling." : "All changes are saved.",
        source: "save",
      });
      this.render();
      if (newerConfig) this.scheduleValidation();
    } catch (error) {
      if (this.destroyed) return;
      this.view.showFeedback({ tone: "error", title: commit ? "Couldn’t commit the draft" : "Couldn’t save the graph", description: error instanceof Error ? error.message : "Your edits are still here. Try again.", source: "save", action: { label: "Retry", run: () => void this.save(commit) } });
      void this.refreshValidation();
    } finally {
      this.saving = false;
    }
  }

  private exportJson(): void {
    if (!this.record) return;
    try {
      const config = pruneUnwiredPins(this.record.config as GraphConfigJson);
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${this.view.getGraphName() || "graph"}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.view.showFeedback({ tone: "success", title: "Graph exported", source: "editor" });
    } catch (error) {
      this.view.showFeedback({ tone: "error", title: "Couldn’t export the graph", description: error instanceof Error ? error.message : "Try exporting again.", action: { label: "Retry", run: () => this.exportJson() } });
    }
  }
}
