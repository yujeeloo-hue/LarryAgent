import { TimelinePaneView } from "./TimelinePaneView.js";

const PUSH_REFRESH_THROTTLE_MS = 200;
/** Self-heal: re-pull while anything is in flight, even if a push was lost. */
const INFLIGHT_RESYNC_MS = 2_000;

/**
 * Detail → Timeline tab: pulls the in-memory LLM round-trip recording for
 * the focused session (live only — nothing is replayed from disk) and keeps
 * the waterfall current via `llmTimeline:updated` pushes while visible.
 */
export class TimelinePaneController {
  private readonly view: TimelinePaneView;
  private sessionId: string | null = null;
  private refreshing = false;
  private refreshSeq = 0;
  private lastSnapshot: LlmTimelineSnapshot | null = null;
  private unsubscribeUpdate: (() => void) | null = null;
  private pushTimer: number | null = null;
  private rafId: number | null = null;
  private safetyTimer: number | null = null;
  private pendingRerun = false;
  /** True while an imported file is shown — live pushes must not overwrite it. */
  private imported = false;

  constructor(view: TimelinePaneView) {
    this.view = view;
  }

  mount(): HTMLElement {
    this.view.refreshButton.addEventListener("click", () => {
      // Refresh doubles as "return to live" while viewing an import.
      this.imported = false;
      this.view.setImportedLabel(null);
      void this.refresh();
    });
    this.view.exportButton.addEventListener("click", () => {
      this.exportJson();
    });
    this.view.importButton.addEventListener("click", () => {
      this.pickAndImport();
    });

    const bridge = window.jellybot;
    if (bridge?.onLlmTimelineUpdated) {
      this.unsubscribeUpdate = bridge.onLlmTimelineUpdated((payload) => {
        if (payload.sessionId !== this.sessionId) return;
        if (!this.isVisible()) return;
        this.schedulePushRefresh();
      });
    }

    this.safetyTimer = window.setInterval(() => {
      if (!this.isVisible() || !this.lastSnapshot || this.refreshing) return;
      if (this.view.hasInFlight()) void this.refresh();
    }, INFLIGHT_RESYNC_MS);

    return this.view.root;
  }

  /** Cycle the Detail drawer between its two timeline heights. */
  onPanelHeightToggle(handler: () => void): void {
    this.view.panelHeightButton.addEventListener("click", handler);
  }

  /** A bar was clicked open — grow the drawer when it is too short. */
  onBarSelect(handler: () => void): void {
    this.view.onBarSelect(handler);
  }

  destroy(): void {
    this.unsubscribeUpdate?.();
    this.unsubscribeUpdate = null;
    if (this.pushTimer !== null) {
      window.clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.safetyTimer !== null) {
      window.clearInterval(this.safetyTimer);
      this.safetyTimer = null;
    }
    this.view.root.remove();
  }

  setSessionId(sessionId: string | null): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    // Invalidate any in-flight pull for the previous session.
    this.refreshSeq += 1;
    this.lastSnapshot = null;
    // Switching conversations leaves the imported view behind.
    this.imported = false;
    this.view.setImportedLabel(null);
    void this.refresh();
  }

  // ——— JSON export / import ————————————————————————————————————————

  /** Download the current view as a JSON file (records + metadata). */
  private exportJson(): void {
    const snapshot = this.view.getSnapshot();
    if (snapshot.records.length === 0) return;
    const payload = {
      kind: "jellybot.timeline",
      version: 1,
      exportedAt: new Date().toISOString(),
      sessionId: this.sessionId,
      truncatedCount: snapshot.truncatedCount,
      records: snapshot.records,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .slice(0, 19);
    const link = document.createElement("a");
    link.href = url;
    link.download = `timeline-${stamp}.json`;
    link.click();
    // Revoke on the next tick so the download has started.
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  /** Pick a JSON file and render it in place of the live session. */
  private pickAndImport(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      void file
        .text()
        .then((text) => {
          const parsed = parseTimelineExport(text);
          if (!parsed) {
            this.view.setEmpty(
              "Import failed: not a JellyBot timeline export.",
            );
            return;
          }
          this.imported = true;
          this.view.setImportedLabel(file.name);
          this.view.setEmpty(
            parsed.records.length === 0 ? "Imported file has no records." : null,
          );
          this.view.render(parsed);
        })
        .catch((err) => {
          console.error("[timeline-pane] import failed", err);
          this.view.setEmpty("Import failed: could not read the file.");
        });
    });
    input.click();
  }

  async refresh(): Promise<void> {
    // Viewing an imported file: never pull over it (Refresh clears the flag).
    if (this.imported) return;
    if (this.refreshing) {
      // Trailing edge: a push landing mid-await (e.g. the final finish
      // event) must never be dropped, or a stale in-flight record keeps
      // stretching the axis forever.
      this.pendingRerun = true;
      return;
    }
    const seq = ++this.refreshSeq;
    const sessionId = this.sessionId;
    const bridge = window.jellybot;
    if (!sessionId) {
      this.view.setEmpty("Open a conversation to see its LLM timeline.");
      this.view.render({ records: [], truncatedCount: 0 });
      return;
    }
    if (!bridge?.llmTimelineList) {
      this.view.setEmpty("LLM timeline unavailable.");
      this.view.render({ records: [], truncatedCount: 0 });
      return;
    }
    this.refreshing = true;
    this.view.setRefreshBusy(true);
    try {
      const snapshot = await bridge.llmTimelineList(sessionId);
      if (seq !== this.refreshSeq) return;
      this.lastSnapshot = snapshot;
      this.view.setEmpty(
        snapshot.records.length === 0
          ? "No LLM calls recorded for this run yet (live recording only — cleared on restart)."
          : null,
      );
      this.view.render(snapshot);
      this.startInFlightLoop();
    } catch (err) {
      console.error("[timeline-pane] refresh failed", err);
      this.view.setEmpty("Failed to load LLM timeline.");
    } finally {
      this.refreshing = false;
      this.view.setRefreshBusy(false);
      if (this.pendingRerun) {
        this.pendingRerun = false;
        void this.refresh();
      }
    }
  }

  private schedulePushRefresh(): void {
    if (this.pushTimer !== null) return;
    this.pushTimer = window.setTimeout(() => {
      this.pushTimer = null;
      void this.refresh();
    }, PUSH_REFRESH_THROTTLE_MS);
  }

  /**
   * RAF-driven growth for in-flight bars (smooth at display refresh rate,
   * instead of 500ms jumps). The loop parks itself when nothing is in
   * flight or the pane is hidden; any later refresh re-arms it.
   */
  private startInFlightLoop(): void {
    if (this.rafId !== null) return;
    const loop = (): void => {
      this.rafId = null;
      if (!this.isVisible() || !this.view.hasInFlight()) return;
      this.view.tick();
      this.rafId = window.requestAnimationFrame(loop);
    };
    this.rafId = window.requestAnimationFrame(loop);
  }

  /** Hidden panes (`hidden` attr / drawer closed) must not churn. */
  private isVisible(): boolean {
    return this.view.root.offsetParent !== null;
  }
}

/**
 * Validate a timeline export file. Returns a snapshot, or null when the
 * payload is not a recognisable JellyBot timeline export.
 */
export function parseTimelineExport(text: string): {
  records: LlmTimelineRecord[];
  truncatedCount: number;
} | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  const rawRecords = Array.isArray(obj.records) ? obj.records : null;
  if (!rawRecords) return null;
  const records: LlmTimelineRecord[] = [];
  for (const entry of rawRecords) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    // Minimum shape the waterfall relies on.
    if (
      typeof rec.id !== "string" ||
      typeof rec.kind !== "string" ||
      typeof rec.startedAt !== "number"
    ) {
      continue;
    }
    if (rec.kind !== "llm" && rec.kind !== "tool" && rec.kind !== "user") {
      continue;
    }
    records.push(entry as LlmTimelineRecord);
  }
  if (records.length === 0 && rawRecords.length > 0) return null;
  records.sort((a, b) => a.startedAt - b.startedAt);
  const truncatedCount =
    typeof obj.truncatedCount === "number" && obj.truncatedCount >= 0
      ? obj.truncatedCount
      : 0;
  return { records, truncatedCount };
}
