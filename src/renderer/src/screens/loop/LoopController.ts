import type { LoopRecordView } from "./loopTypes.js";
import { daemonToDisplay } from "./daemonDisplay.js";
import type {
  DaemonDisplay,
  LoopProviderOption,
  LoopWorkspaceOption,
  LoopView as LoopScreenView,
} from "./LoopView.js";

export type LoopControllerOptions = {
  onSessionSelect: (sessionId: string) => void;
};

function requireBridge(): NonNullable<Window["jellybot"]> {
  const bridge = window.jellybot;
  if (!bridge) {
    throw new Error("jellybot bridge is unavailable");
  }
  return bridge;
}

const DAEMON_SETTLE_DELAYS = [2000, 4000, 8000] as const;

export class LoopController {
  private loops: LoopRecordView[] = [];
  private workspaces: LoopWorkspaceOption[] = [];
  private workspaceNames = new Map<string, string>();
  private providers: LoopProviderOption[] = [];
  private providerLabels = new Map<string, string>();
  private defaults = { workspaceId: "", providerId: "" };
  private expandedIds = new Set<string>();
  private runsByLoopId = new Map<string, LoopRunRecord[]>();
  private runsLoading = new Set<string>();
  private editingLoopId: string | null = null;
  private daemonDisplay: DaemonDisplay | null = null;
  private daemonBusy = false;
  private daemonSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(
    private readonly view: LoopScreenView,
    private readonly options: LoopControllerOptions,
  ) {
    view.onNewLoop(() => this.openEditorFor(null));
    view.onEditLoop((loopId) => {
      const loop = this.loops.find((candidate) => candidate.id === loopId);
      if (loop) this.openEditorFor(loop);
    });
    view.onDeleteLoop((loopId) => {
      void this.deleteLoop(loopId);
    });
    view.onToggleEnabled((loopId, enabled) => {
      void this.setEnabled(loopId, enabled);
    });
    view.onToggleRuns((loopId) => {
      void this.toggleRuns(loopId);
    });
    view.onSelectRunSession((sessionId) => {
      this.options.onSessionSelect(sessionId);
    });
    view.onDaemonAction((action) => {
      void this.runDaemonAction(action);
    });
    view.onDaemonRefresh(() => {
      void this.refreshDaemonStatus();
    });
    view.onEditorSubmit(() => {
      void this.submitEditor();
    });
    view.onEditorCancel(() => {
      this.editingLoopId = null;
      this.view.closeEditor();
      this.render();
    });
  }

  mount(): HTMLElement {
    void this.initialLoad();
    return this.view.root;
  }

  destroy(): void {
    this.destroyed = true;
    this.cancelDaemonSettlePoll();
    this.view.root.remove();
  }


  private async initialLoad(): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge) {
      this.view.renderDaemon(
        {
          tone: "missing",
          label: "Unavailable",
          detail: "jellybot bridge is unavailable",
          action: null,
          actionLabel: "",
        },
        false,
      );
      return;
    }

    this.view.renderDaemon(null, true);
    const [snapshotResult, workspacesResult, loopsResult, daemonResult] =
      await Promise.allSettled([
        bridge.getSettingsSnapshot(),
        bridge.listWorkspaces(),
        bridge.loopsList(),
        bridge.loopsDaemonStatus(),
      ]);

    if (this.destroyed) return;

    if (snapshotResult.status === "fulfilled") {
      this.providers = snapshotResult.value.settings.providers.map(
        (provider) => ({
          id: provider.id,
          name: provider.name,
          modelId: provider.modelId,
        }),
      );
      this.defaults.providerId =
        snapshotResult.value.settings.activeProviderId ||
        this.providers[0]?.id ||
        "";
      this.defaults.workspaceId =
        snapshotResult.value.settings.activeWorkspaceId || "";
    }
    if (workspacesResult.status === "fulfilled") {
      this.workspaces = workspacesResult.value.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
      }));
      if (!this.defaults.workspaceId) {
        this.defaults.workspaceId = this.workspaces[0]?.id ?? "";
      }
    }
    if (loopsResult.status === "fulfilled") {
      this.loops = loopsResult.value;
    }
    if (daemonResult.status === "fulfilled") {
      this.daemonDisplay = daemonToDisplay(daemonResult.value);
    } else if (this.daemonDisplay === null) {
      this.daemonDisplay = {
        tone: "stopped",
        label: "Unknown",
        detail:
          daemonResult.status === "rejected"
            ? `Status check failed: ${String(daemonResult.reason)}`
            : "",
        action: "ensure",
        actionLabel: "Start",
      };
    }

    this.render();

    await this.autoEnsureDaemon();
  }


  private async refreshDaemonStatus(): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge || this.daemonBusy) return;
    this.daemonBusy = true;
    this.view.renderDaemon(this.daemonDisplay, true);
    try {
      this.daemonDisplay = daemonToDisplay(await bridge.loopsDaemonStatus());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.daemonDisplay = {
        tone: "stopped",
        label: "Unknown",
        detail: `Status check failed: ${message}`,
        action: "ensure",
        actionLabel: "Start",
      };
    } finally {
      this.daemonBusy = false;
      if (!this.destroyed) {
        this.view.renderDaemon(this.daemonDisplay, false);
      }
    }
  }

  private async runDaemonAction(
    action: "ensure" | "stop",
    silent = false,
  ): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge || this.daemonBusy) return;
    this.daemonBusy = true;
    this.view.renderDaemon(this.daemonDisplay, true);
    try {
      const status =
        action === "ensure"
          ? await bridge.loopsInstallDaemon()
          : await bridge.loopsStopDaemon();
      this.daemonDisplay = daemonToDisplay(status);
      this.scheduleDaemonSettlePoll(action === "ensure" ? "running" : "stopped");
      if (action === "ensure") {
        try {
          this.loops = await bridge.loopsList();
        } catch {
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.daemonDisplay = {
        tone: "stopped",
        label: "Error",
        detail: `${action === "ensure" ? "Start" : "Stop"} failed: ${message}`,
        action: "ensure",
        actionLabel: "Start",
      };
      if (!silent) {
        await this.alert(message);
      }
    } finally {
      this.daemonBusy = false;
      if (!this.destroyed) {
        this.render();
      }
    }
  }

  private async autoEnsureDaemon(): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge || this.daemonBusy) return;
    this.daemonBusy = true;
    this.view.renderDaemon(this.daemonDisplay, true);
    try {
      this.daemonDisplay = daemonToDisplay(await bridge.loopsEnsureDaemon());
      if (this.daemonDisplay.tone !== "running" && this.daemonDisplay.tone !== "stale") {
        this.scheduleDaemonSettlePoll("running");
      }
      try {
        this.loops = await bridge.loopsList();
      } catch {
      }
    } catch {
    } finally {
      this.daemonBusy = false;
      if (!this.destroyed) {
        this.render();
      }
    }
  }

  private cancelDaemonSettlePoll(): void {
    if (this.daemonSettleTimer !== null) {
      clearTimeout(this.daemonSettleTimer);
      this.daemonSettleTimer = null;
    }
  }

  private scheduleDaemonSettlePoll(target: "running" | "stopped"): void {
    this.cancelDaemonSettlePoll();
    const tick = (index: number): void => {
      if (this.destroyed || index >= DAEMON_SETTLE_DELAYS.length) return;
      this.daemonSettleTimer = setTimeout(() => {
        this.daemonSettleTimer = null;
        if (this.destroyed) return;
        const bridge = window.jellybot;
        if (bridge && !this.daemonBusy) {
          bridge
            .loopsDaemonStatus()
            .then((status) => {
              if (this.destroyed || this.daemonSettleTimer !== null) return;
              this.daemonDisplay = daemonToDisplay(status);
              this.render();
              const running =
                this.daemonDisplay.tone === "running" ||
                this.daemonDisplay.tone === "stale";
              if (target === "running" ? running : !running) return;
              tick(index + 1);
            })
            .catch(() => {
              if (!this.destroyed) tick(index + 1);
            });
        } else {
          tick(index + 1);
        }
      }, DAEMON_SETTLE_DELAYS[index]);
    };
    tick(0);
  }


  private openEditorFor(loop: LoopRecordView | null): void {
    this.editingLoopId = loop ? loop.id : null;
    this.view.openEditor(loop, this.defaults, {
      workspaces: this.workspaces,
      providers: this.providers,
    });
    this.render();
  }

  private async submitEditor(): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge) return;
    const result = this.view.collectInput();
    if (!result.ok) {
      this.view.setEditorError(result.error);
      return;
    }
    this.view.setEditorError(null);
    try {
      const saved =
        this.editingLoopId != null
          ? await bridge.loopsUpdate(this.editingLoopId, result.payload)
          : await bridge.loopsCreate(result.payload);
      this.upsertLoop(saved);
      this.editingLoopId = null;
      this.view.closeEditor();
      this.render();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.setEditorError(message);
      await this.alert(message);
    }
  }


  private upsertLoop(loop: LoopRecordView): void {
    const index = this.loops.findIndex((candidate) => candidate.id === loop.id);
    if (index >= 0) {
      this.loops.splice(index, 1, loop);
    } else {
      this.loops.push(loop);
    }
  }

  private async setEnabled(loopId: string, enabled: boolean): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge) return;
    try {
      this.upsertLoop(await bridge.loopsSetEnabled(loopId, enabled));
    } catch (err) {
      await this.alert(err instanceof Error ? err.message : String(err));
    }
    this.render();
  }

  private async deleteLoop(loopId: string): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge) return;
    const loop = this.loops.find((candidate) => candidate.id === loopId);
    const name = loop?.name ?? "this loop";
    const confirmed = bridge.confirmDialog
      ? await bridge.confirmDialog({
          title: "Delete loop",
          message: `Delete "${name}"?`,
          detail:
            "The loop stops scheduling immediately and its definition is removed. Past runs and tasks stay. This cannot be undone.",
        })
      : window.confirm(`Delete "${name}"? This cannot be undone.`);
    if (!confirmed) return;
    try {
      const deleted = await bridge.loopsDelete(loopId);
      if (!deleted) return;
      this.loops = this.loops.filter((candidate) => candidate.id !== loopId);
      this.expandedIds.delete(loopId);
      this.runsByLoopId.delete(loopId);
      this.runsLoading.delete(loopId);
      if (this.editingLoopId === loopId) {
        this.editingLoopId = null;
        this.view.closeEditor();
      }
    } catch (err) {
      await this.alert(err instanceof Error ? err.message : String(err));
    }
    this.render();
  }

  private async toggleRuns(loopId: string): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge) return;
    if (this.expandedIds.has(loopId)) {
      this.expandedIds.delete(loopId);
      this.render();
      return;
    }
    this.expandedIds.add(loopId);
    this.runsLoading.add(loopId);
    this.render();
    try {
      this.runsByLoopId.set(loopId, await bridge.loopsListRuns(loopId, 10));
    } catch (err) {
      console.error("[loops] failed to list runs", loopId, err);
      this.runsByLoopId.set(loopId, []);
    } finally {
      this.runsLoading.delete(loopId);
      if (!this.destroyed) this.render();
    }
  }


  private render(): void {
    this.workspaceNames = new Map(
      this.workspaces.map((workspace) => [workspace.id, workspace.name]),
    );
    this.providerLabels = new Map(
      this.providers.map((provider) => [
        provider.id,
        `${provider.name} · ${provider.modelId}`,
      ]),
    );
    this.view.renderLoops({
      loops: this.loops,
      workspaceNames: this.workspaceNames,
      providerLabels: this.providerLabels,
      expandedIds: this.expandedIds,
      runsByLoopId: this.runsByLoopId,
      runsLoading: this.runsLoading,
    });
    this.view.renderDaemon(this.daemonDisplay, this.daemonBusy);
  }

  private async alert(message: string): Promise<void> {
    const bridge = window.jellybot;
    if (bridge?.alertDialog) {
      await bridge.alertDialog({ message, type: "error", title: "Loops" });
    } else {
      window.alert(message);
    }
  }
}
