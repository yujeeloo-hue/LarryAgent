import type { GraphListRow, GraphsView } from "./GraphsView.js";

function requireBridge(): NonNullable<Window["jellybot"]> {
  if (!window.jellybot) {
    throw new Error("JellyBot bridge is not available");
  }
  return window.jellybot;
}

export type GraphsControllerOptions = {
  onOpenGraph: (graphId: string) => void;
};

/** Graph library list — create / open / delete custom FSM graphs. */
export class GraphsController {
  private destroyed = false;

  constructor(
    private readonly view: GraphsView,
    private readonly options: GraphsControllerOptions,
  ) {
    this.view.setOnCreate(() => {
      void this.onCreate();
    });
    this.view.setOnFork((mode) => {
      void this.onFork(mode);
    });
    this.view.setOnOpen((id) => {
      this.options.onOpenGraph(id);
    });
    this.view.setOnDelete((id) => {
      void this.onDelete(id);
    });
    this.view.setOnToggleEnabled((id, enabled) => {
      void this.onSetEnabled(id, enabled);
    });
  }

  mount(): HTMLElement {
    void this.reload();
    return this.view.root;
  }

  destroy(): void {
    this.destroyed = true;
    this.view.setOnCreate(null);
    this.view.setOnFork(null);
    this.view.setOnOpen(null);
    this.view.setOnDelete(null);
    this.view.setOnToggleEnabled(null);
    this.view.root.remove();
  }

  private async reload(): Promise<void> {
    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      const [graphs, templates] = await Promise.all([
        requireBridge().listFsmGraphs(),
        requireBridge().fsmBuiltinTemplates(),
      ]);
      if (this.destroyed) return;
      this.view.setTemplates(templates);
      this.view.setGraphs(graphs.map(toRow));
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to load graphs.";
      this.view.setStatus(message, "error");
      this.view.setGraphs([]);
    } finally {
      if (!this.destroyed) this.view.setBusy(false);
    }
  }

  private async onFork(
    mode: "react" | "react_v2" | "ask" | "plan_execute" | "subagent",
  ): Promise<void> {
    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      const record = await requireBridge().forkBuiltinFsmGraph(mode);
      if (this.destroyed) return;
      this.options.onOpenGraph(record.id);
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to fork graph.";
      this.view.setStatus(message, "error");
    } finally {
      if (!this.destroyed) this.view.setBusy(false);
    }
  }

  private async onCreate(): Promise<void> {
    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      const record = await requireBridge().createFsmGraph("Untitled graph");
      if (this.destroyed) return;
      this.options.onOpenGraph(record.id);
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to create graph.";
      this.view.setStatus(message, "error");
    } finally {
      if (!this.destroyed) this.view.setBusy(false);
    }
  }

  private async onSetEnabled(id: string, enabled: boolean): Promise<void> {
    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      await requireBridge().setFsmGraphEnabled(id, enabled);
      if (this.destroyed) return;
      await this.reload();
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to update graph.";
      this.view.setStatus(message, "error");
    } finally {
      if (!this.destroyed) this.view.setBusy(false);
    }
  }

  private async onDelete(id: string): Promise<void> {
    if (
      !window.confirm(
        "Delete this graph? Tasks using it will switch back to Auto. This cannot be undone.",
      )
    ) {
      return;
    }
    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      await requireBridge().deleteFsmGraph(id);
      if (this.destroyed) return;
      await this.reload();
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to delete graph.";
      this.view.setStatus(message, "error");
    } finally {
      if (!this.destroyed) this.view.setBusy(false);
    }
  }
}

function toRow(entry: FsmGraphLibraryEntry): GraphListRow {
  return {
    id: entry.id,
    name: entry.name,
    updatedAt: entry.updatedAt,
    origin: entry.origin,
    enabled: entry.enabled,
    ...(entry.color ? { color: entry.color } : {}),
  };
}
