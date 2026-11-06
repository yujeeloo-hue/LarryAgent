import {
  ToolStatsPaneView,
  type ToolStatsInvocationRow,
} from "./ToolStatsPaneView.js";

/** Loads tool summary + per-tool invocation history from main via IPC. */
export class ToolStatsPaneController {
  private selectedName = "";
  private refreshing = false;
  private sessionId: string | null = null;

  constructor(private readonly view: ToolStatsPaneView) {}

  mount(): HTMLElement {
    this.view.refreshButton.addEventListener("click", () => {
      void this.refresh();
    });
    this.view.resetButton.addEventListener("click", () => {
      void this.reset();
    });
    this.view.onToolSelect((name) => {
      this.selectedName = name;
      void this.loadInvocations(name);
    });
    this.view.onFilterChange((scope) => {
      this.selectedName = "";
      this.view.setTools([], "");
      this.view.setInvocations("", []);
      this.view.setResetDisabled(scope === "session");
      void this.refresh();
    });
    return this.view.root;
  }

  destroy(): void {
    this.view.root.remove();
  }

  /** Focused conversation — drives the Current session scope. */
  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    const bridge = window.jellybot;
    if (!bridge?.getToolStatsSummary || !bridge.listToolStatsInvocations) {
      this.view.setTools([], "");
      this.view.setInvocations("", []);
      return;
    }
    const scope = this.view.getScope();
    const sessionId = scope === "session" ? this.sessionId : null;
    // Surface the recording switch: an empty table otherwise reads as
    // "nothing was called" when recording is simply turned off.
    let recording = true;
    if (bridge.getToolStatsEnabled) {
      try {
        recording = await bridge.getToolStatsEnabled();
      } catch (err) {
        console.error("[tool-stats] enabled probe failed", err);
      }
    }
    this.view.setRecordingDisabled(!recording);
    const disabledHint = recording
      ? undefined
      : "Recording is disabled — no new tool calls are being recorded.";
    if (scope === "session" && !sessionId) {
      this.selectedName = "";
      this.view.setTools(
        [],
        "",
        disabledHint ?? "Open a conversation to see its tool calls.",
      );
      this.view.setInvocations("", []);
      return;
    }
    this.refreshing = true;
    this.view.setRefreshBusy(true);
    try {
      const summary = await bridge.getToolStatsSummary(
        sessionId ? { sessionId } : undefined,
      );
      const names = summary.map((row) => row.name);
      if (this.selectedName && !names.includes(this.selectedName)) {
        this.selectedName = "";
      }
      if (!this.selectedName && names.length > 0) {
        this.selectedName = names[0] ?? "";
      }
      this.view.setTools(
        summary,
        this.selectedName,
        disabledHint ??
          (scope === "session"
            ? "No tool calls recorded for this conversation."
            : undefined),
      );
      await this.loadInvocations(this.selectedName);
    } catch (err) {
      console.error("[tool-stats] refresh failed", err);
    } finally {
      this.refreshing = false;
      this.view.setRefreshBusy(false);
    }
  }

  /** Clear every recorded invocation after an explicit confirm. */
  async reset(): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge?.resetToolStats) return;
    const ok = window.confirm(
      "Reset all tool stats? Every recorded invocation will be deleted. This cannot be undone.",
    );
    if (!ok) return;
    this.view.setResetBusy(true);
    try {
      const removed = await bridge.resetToolStats();
      console.info(`[tool-stats] reset removed ${removed} rows`);
      this.selectedName = "";
      this.view.setTools([], "");
      this.view.setInvocations("", []);
      await this.refresh();
    } catch (err) {
      console.error("[tool-stats] reset failed", err);
    } finally {
      this.view.setResetBusy(false);
    }
  }

  private async loadInvocations(name: string): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge?.listToolStatsInvocations || !name) {
      this.view.setInvocations(name, []);
      return;
    }
    const sessionId =
      this.view.getScope() === "session" ? this.sessionId : null;
    try {
      const rows = await bridge.listToolStatsInvocations({
        name,
        ...(sessionId ? { sessionId } : {}),
        limit: 200,
        offset: 0,
      });
      const mapped: ToolStatsInvocationRow[] = rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        reason: row.reason,
        sessionId: row.sessionId,
        startedAt: row.startedAt,
        durationMs: row.durationMs,
        ...(row.returnCode != null ? { returnCode: row.returnCode } : {}),
        ...(row.sceneJson != null ? { sceneJson: row.sceneJson } : {}),
      }));
      this.view.setInvocations(name, mapped);
    } catch (err) {
      console.error("[tool-stats] load invocations failed", err);
      this.view.setInvocations(name, []);
    }
  }
}
