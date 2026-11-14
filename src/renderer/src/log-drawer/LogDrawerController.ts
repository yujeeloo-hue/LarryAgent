import { LogBuffer } from "../../../logging/logBuffer.js";
import { installConsoleCapture } from "../../../logging/installConsoleCapture.js";
import type { LogEntry } from "../../../logging/types.js";
import {
  LOG_LEVELS,
  type LogDrawerView,
  type LogLevelName,
  type LogSourceFilter,
} from "./LogDrawerView.js";

const METRICS_POLL_MS = 1000;
const RENDERER_BUFFER_CAP = 500;

/**
 * Log drawer logic: console capture, main-process log subscription,
 * filters, save-to-file, and process metrics polling while open.
 */
export class LogDrawerController {
  private readonly buffer = new LogBuffer(RENDERER_BUFFER_CAP);
  private open = false;
  private unsubMainLog: (() => void) | undefined;
  private disposeConsoleCapture: (() => void) | undefined;
  private metricsTimer: ReturnType<typeof setInterval> | undefined;
  private seenIds = new Set<string>();
  private readonly enabledLevels = new Set<LogLevelName>(LOG_LEVELS);
  private sourceFilter: LogSourceFilter = "all";
  private keyword = "";
  private saving = false;
  private fullRequestLog = false;

  constructor(private readonly view: LogDrawerView) {}

  mount(): HTMLElement {
    this.view.clearButton.addEventListener("click", () => {
      this.clear();
    });
    this.view.saveButton.addEventListener("click", () => {
      void this.saveToFile();
    });
    this.view.openFolderButton.addEventListener("click", () => {
      void this.openLogsFolder();
    });
    for (const level of LOG_LEVELS) {
      this.view.levelButtons[level].addEventListener("click", () => {
        this.toggleLevel(level);
      });
    }
    this.view.sourceDropdown.addEventListener("change", () => {
      this.sourceFilter = this.view.getSourceFilter();
      this.refreshList();
    });
    this.view.keywordInput.addEventListener("input", () => {
      this.keyword = this.view.getKeyword().trim().toLowerCase();
      this.refreshList();
    });
    this.view.fullRequestButton.addEventListener("click", () => {
      void this.toggleFullRequestLog();
    });

    this.disposeConsoleCapture = installConsoleCapture(
      this.buffer,
      "renderer",
      (entry) => {
        this.ingest(entry);
      },
    );

    const bridge = window.jellybot;
    if (bridge?.onDiagnosticLog) {
      this.unsubMainLog = bridge.onDiagnosticLog((entry) => {
        this.ingest(entry as LogEntry);
      });
    }

    if (bridge?.getRecentLogs) {
      void bridge.getRecentLogs().then((entries) => {
        for (const entry of entries) {
          this.ingest(entry as LogEntry);
        }
        if (this.open) {
          this.refreshList();
        }
      });
    }

    if (bridge?.getFullRequestLog) {
      void bridge.getFullRequestLog().then((enabled) => {
        this.fullRequestLog = enabled === true;
        this.view.setFullRequestEnabled(this.fullRequestLog);
      });
    }

    return this.view.root;
  }

  private async toggleFullRequestLog(): Promise<void> {
    const next = !this.fullRequestLog;
    const bridge = window.jellybot;
    if (!bridge?.setFullRequestLog) {
      this.fullRequestLog = next;
      this.view.setFullRequestEnabled(next);
      return;
    }
    try {
      const enabled = await bridge.setFullRequestLog(next);
      this.fullRequestLog = enabled === true;
      this.view.setFullRequestEnabled(this.fullRequestLog);
    } catch (err) {
      console.error("[log-drawer] setFullRequestLog failed", err);
    }
  }

  destroy(): void {
    this.stopMetricsPoll();
    this.unsubMainLog?.();
    this.unsubMainLog = undefined;
    this.disposeConsoleCapture?.();
    this.disposeConsoleCapture = undefined;
    this.view.root.remove();
  }

  isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    if (open) {
      this.refreshList();
      this.startMetricsPoll();
      void this.pollMetrics();
    } else {
      this.stopMetricsPoll();
    }
  }

  private toggleLevel(level: LogLevelName): void {
    if (this.enabledLevels.has(level)) {
      this.enabledLevels.delete(level);
    } else {
      this.enabledLevels.add(level);
    }
    this.view.setLevelEnabled(level, this.enabledLevels.has(level));
    this.refreshList();
  }

  private clear(): void {
    this.buffer.clear();
    this.seenIds.clear();
    this.view.clearEntries();
  }

  private filteredEntries(): LogEntry[] {
    return this.buffer
      .snapshot()
      .slice()
      .sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))
      .filter((entry) => this.matchesFilter(entry));
  }

  private matchesFilter(entry: LogEntry): boolean {
    if (!this.enabledLevels.has(entry.level as LogLevelName)) {
      return false;
    }
    if (this.sourceFilter !== "all" && entry.source !== this.sourceFilter) {
      return false;
    }
    if (this.keyword) {
      const haystack =
        `${entry.message} ${entry.level} ${entry.source}`.toLowerCase();
      if (!haystack.includes(this.keyword)) {
        return false;
      }
    }
    return true;
  }

  private ingest(entry: LogEntry): void {
    if (this.seenIds.has(entry.id)) return;
    this.seenIds.add(entry.id);
    // Renderer capture already appended via installConsoleCapture.
    if (entry.source === "main") {
      this.buffer.append(entry);
    }
    if (this.open && this.matchesFilter(entry)) {
      this.view.appendEntry(entry);
    }
  }

  private refreshList(): void {
    const entries = this.filteredEntries();
    for (const entry of this.buffer.snapshot()) {
      this.seenIds.add(entry.id);
    }
    this.view.setEntries(entries);
  }

  private formatLogLine(entry: LogEntry): string {
    const iso = new Date(entry.ts).toISOString();
    const level = entry.level.toUpperCase().padEnd(5, " ");
    return `${iso} ${level} [${entry.source}] ${entry.message}`;
  }

  private async saveToFile(): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge?.saveLogsToFile || this.saving) return;

    const content = this.filteredEntries()
      .map((entry) => this.formatLogLine(entry))
      .join("\n");
    const body = content.length > 0 ? `${content}\n` : "";

    this.saving = true;
    this.view.setSaveBusy(true);
    try {
      const result = await bridge.saveLogsToFile(body);
      if (!result.ok && !result.canceled) {
        console.error("[log-drawer] save failed", result.error);
      }
    } catch (err) {
      console.error("[log-drawer] save failed", err);
    } finally {
      this.saving = false;
      this.view.setSaveBusy(false);
    }
  }

  private async openLogsFolder(): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge?.openLogsFolder) return;
    try {
      const result = await bridge.openLogsFolder();
      if (!result.ok) {
        console.error("[log-drawer] open folder failed", result.error);
      }
    } catch (err) {
      console.error("[log-drawer] open folder failed", err);
    }
  }

  private startMetricsPoll(): void {
    this.stopMetricsPoll();
    this.metricsTimer = setInterval(() => {
      void this.pollMetrics();
    }, METRICS_POLL_MS);
  }

  private stopMetricsPoll(): void {
    if (this.metricsTimer !== undefined) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = undefined;
    }
  }

  private async pollMetrics(): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge?.getProcessMetrics) return;
    try {
      const metrics = await bridge.getProcessMetrics();
      if (!this.open) return;
      this.view.setMetrics(metrics);
    } catch (err) {
      console.error("[log-drawer] metrics poll failed", err);
    }
  }
}
