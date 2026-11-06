/**
 * CocoController — device-scoped CoCo snapshot state machine for the relay
 * web console (mirror of the Mac client's CocoView data flow, poll-based).
 *
 * Update strategy (decision #6): a 3s poll while the CoCo view is mounted,
 * plus an immediate refresh after every accepted command so controls feel
 * local. The queue rides the same cadence while the chat panel is open
 * (listPromptQueue on snapshot.chat.sessionId — same prompt queue the
 * desktop renderer uses, never a CoCo-specific one).
 */

import type { CocoCommand, CocoSnapshot, DeviceAction } from "./types.js";

/** Single source for the poll cadence (see plan decision #6). */
export const COCO_POLL_MS = 3000;

/** Client parity (renderer CocoController REPORT_SEEN_KEY): last report the user opened. */
const REPORTS_SEEN_KEY = "coco.reportsSeenAt";
const readReportsSeenAt = (): number => {
  try {
    return Number(globalThis.localStorage?.getItem(REPORTS_SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
};

export type CocoPage = "overview" | "to-decide" | "rules" | "reports";

export type CocoStatus = "loading" | "ready" | "error";

export type CocoChange = "snapshot" | "queue" | "ui";

/** Device-side queued prompt row (listPromptQueue result item). */
export type CocoQueueItem = {
  id: string;
  sessionId: string;
  userText: string;
  attachments: Array<{ name: string }>;
  createdAt: number;
  mode?: string;
};

export type CocoRequestFn = <T>(
  deviceId: string,
  action: DeviceAction,
  payload?: unknown,
  timeoutMs?: number,
) => Promise<T>;

export type CocoControllerOptions = {
  deviceId: string;
  request: CocoRequestFn;
  /** Poll cadence override (tests inject fast ticks). */
  pollMs?: number;
  /** document.hidden source (overridable in tests). */
  isHidden?: () => boolean;
};

export type CocoCommandResult = { ok: boolean; error?: string };

export class CocoController {
  private snapshot: CocoSnapshot | null = null;
  private status: CocoStatus = "loading";
  private error: string | null = null;
  private page: CocoPage = "overview";
  private reportsSeenAt = readReportsSeenAt();
  private chatOpen = true;
  private queue: CocoQueueItem[] = [];
  private queueSessionId: string | null = null;
  private commandPending = false;
  private lastCommandError: string | null = null;
  private listeners = new Set<(change: CocoChange) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private refreshing: Promise<void> | null = null;
  private readonly pollMs: number;
  private readonly isHidden: () => boolean;

  constructor(private readonly options: CocoControllerOptions) {
    this.pollMs = options.pollMs ?? COCO_POLL_MS;
    this.isHidden = options.isHidden ?? (() => typeof document === "undefined" ? false : document.hidden);
  }

  // ── lifecycle ────────────────────────────────────────────────

  /** Mount: initial load + poll loop. Idempotent. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.refresh();
    this.schedule();
  }

  /** Unmount: cancel the poll loop (the Mac client keeps its own engine). */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  subscribe(listener: (change: CocoChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── reads ────────────────────────────────────────────────────

  getSnapshot(): CocoSnapshot | null {
    return this.snapshot;
  }

  getStatus(): CocoStatus {
    return this.status;
  }

  getError(): string | null {
    return this.error;
  }

  getPage(): CocoPage {
    return this.page;
  }

  /** Timestamp of the newest report the user has opened (client parity). */
  getReportsSeenAt(): number {
    return this.reportsSeenAt;
  }

  isChatOpen(): boolean {
    return this.chatOpen;
  }

  getQueue(): CocoQueueItem[] {
    return [...this.queue];
  }

  getQueueSessionId(): string | null {
    return this.queueSessionId;
  }

  isCommandPending(): boolean {
    return this.commandPending;
  }

  getLastCommandError(): string | null {
    return this.lastCommandError;
  }

  /** True when the engine is mid-turn (Working banner / Stop button). */
  isWorking(): boolean {
    const state = this.snapshot?.state;
    return state === "working" || state === "stopping";
  }

  // ── ui state ─────────────────────────────────────────────────

  setPage(page: CocoPage): void {
    // Opening Reports clears the "new report" corner, exactly like the client's
    // goTo("reports") → reportsViewed() handshake.
    if (page === "reports") this.markReportsViewed();
    if (this.page === page) return;
    this.page = page;
    this.notify("ui");
  }

  /** Remember the newest report as seen (memory + localStorage, best effort). */
  markReportsViewed(): void {
    const latest = this.snapshot?.reports?.[0]?.at ?? 0;
    if (latest <= this.reportsSeenAt) return;
    this.reportsSeenAt = latest;
    try {
      globalThis.localStorage?.setItem(REPORTS_SEEN_KEY, String(latest));
    } catch {
      /* storage unavailable: keep it in memory for this session */
    }
    this.notify("ui");
  }

  toggleChat(open?: boolean): void {
    const next = open ?? !this.chatOpen;
    if (this.chatOpen === next) return;
    this.chatOpen = next;
    this.notify("ui");
  }

  // ── data ─────────────────────────────────────────────────────

  /** Fetch the snapshot (and the queue when the chat panel is open).
   *  Overlapping calls collapse into one round trip. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    try {
      const snapshot = await this.options.request<CocoSnapshot>(
        this.options.deviceId,
        "cocoSnapshot",
        {},
      );
      this.snapshot = snapshot;
      this.status = "ready";
      this.error = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Keep the last good snapshot for transient failures; only a total
      // failure (nothing to show) escalates to the error state.
      if (!this.snapshot) {
        this.status = "error";
        this.error = /unknown action/i.test(message)
          ? "This device doesn't support CoCo yet."
          : message;
      }
      this.notify("snapshot");
      return;
    }
    this.notify("snapshot");
    // true (default) on purpose: the queue arrives AFTER the snapshot notify,
    // so its own notification is what puts the zebra rows into the first
    // paint — without it they'd only appear on the next poll tick.
    if (this.chatOpen) await this.refreshQueue();
  }

  /** Fetch the chat prompt queue (no-op without a chat session). */
  async refreshQueue(notify = true): Promise<void> {
    const sessionId = this.snapshot?.chat?.sessionId ?? null;
    if (!sessionId) {
      if (this.queue.length > 0 || this.queueSessionId !== null) {
        this.queue = [];
        this.queueSessionId = null;
        this.notify("queue");
      }
      return;
    }
    try {
      const items = await this.options.request<CocoQueueItem[]>(
        this.options.deviceId,
        "listPromptQueue",
        { sessionId },
      );
      this.queueSessionId = sessionId;
      this.queue = Array.isArray(items) ? items : [];
      if (notify) this.notify("queue");
    } catch {
      /* queue refresh is best-effort; the snapshot stays authoritative */
    }
  }

  // ── commands (each accepted command triggers an immediate refresh) ──

  async command(command: CocoCommand): Promise<CocoCommandResult> {
    if (this.commandPending) return { ok: false, error: "A command is still running." };
    this.commandPending = true;
    this.lastCommandError = null;
    this.notify("ui");
    try {
      await this.options.request(this.options.deviceId, "cocoCommand", { command });
    } catch (err) {
      this.commandPending = false;
      const message = err instanceof Error ? err.message : String(err);
      this.lastCommandError = message;
      this.notify("ui");
      return { ok: false, error: message };
    }
    this.commandPending = false;
    // Decision #6: refresh right after the command lands.
    await this.refresh();
    this.notify("ui");
    return { ok: true };
  }

  /** Chat composer: direct send while idle, queue while the engine works. */
  async sendChat(text: string): Promise<CocoCommandResult> {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "Message is empty." };
    if (this.isWorking()) return this.enqueue(trimmed);
    return this.command({ type: "chat", text: trimmed });
  }

  async enqueue(text: string): Promise<CocoCommandResult> {
    const sessionId = this.snapshot?.chat?.sessionId;
    if (!sessionId) return { ok: false, error: "Chat session is not ready yet." };
    try {
      await this.options.request(this.options.deviceId, "enqueuePrompt", {
        sessionId,
        userText: text,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
    await this.refreshQueue(true);
    return { ok: true };
  }

  async promotePrompt(promptId: string): Promise<CocoCommandResult> {
    return this.queueMutation("promoteQueuedPrompt", promptId);
  }

  async removePrompt(promptId: string): Promise<CocoCommandResult> {
    return this.queueMutation("removeQueuedPrompt", promptId);
  }

  private async queueMutation(
    action: "promoteQueuedPrompt" | "removeQueuedPrompt",
    promptId: string,
  ): Promise<CocoCommandResult> {
    const sessionId = this.snapshot?.chat?.sessionId;
    if (!sessionId) return { ok: false, error: "Chat session is not ready yet." };
    try {
      await this.options.request(this.options.deviceId, action, { sessionId, promptId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
    // promote may start a turn — pull the snapshot too, not just the queue.
    await Promise.all([this.refresh(), this.refreshQueue(true)]);
    return { ok: true };
  }

  // ── polling ──────────────────────────────────────────────────

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.pollMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    // Background tab: skip the round trips but keep the cadence alive.
    if (!this.isHidden()) {
      try {
        await this.refresh();
      } catch {
        /* refresh handles its own errors */
      }
    }
    this.schedule();
  }

  private notify(change: CocoChange): void {
    for (const listener of this.listeners) listener(change);
  }
}
