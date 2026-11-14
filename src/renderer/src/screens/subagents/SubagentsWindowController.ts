import { Bot, CircleCheck, CircleSlash, CircleX, LoaderCircle } from "lucide";
import { createLucideIcon } from "../../ui/icons.js";
import { buildMessageRenderContext } from "../conversation/buildMessageRenderContext.js";
import { createMessageViewAsync } from "../conversation/message/MessageView.js";
import { projectTranscriptMessages } from "../conversation/turnDisplay.js";
import { renderMarkdownText } from "../conversation/renderMarkdownText.js";
import "./subagents-window.css";

/**
 * Subagents window — singleton BrowserWindow content (subagentsMain.ts).
 *
 * One tab per subagent run for the bound session; the active tab's pane
 * re-renders the run's raw Message[] through the main conversation pipeline
 * (createMessageViewAsync + buildMessageRenderContext), so cards and rows are
 * pixel-identical to the main transcript. `agent:stream` broadcasts (all
 * windows receive them) act as the dirty signal: lifecycle events update the
 * tab instantly, live deltas paint a streaming tail between checkpoints,
 * and a throttled transcript re-pull picks up committed rounds.
 */

const TRANSCRIPT_REFRESH_LIVE_MS = 800;
const TRANSCRIPT_REFRESH_LIFECYCLE_MS = 400;
const TERMINAL_FLUSH_MS = 1200;
const STICKY_THRESHOLD_PX = 48;
/** Completed tabs compact to icon + label this long after completion. */
export const COMPACT_AFTER_MS = 10_000;

type RunStatus = SubagentRunSummary["status"];

function isTerminalStatus(status: RunStatus): boolean {
  return status === "completed" || status === "error" || status === "cancelled";
}

function asRunStatus(value: unknown): RunStatus | null {
  if (
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "error" ||
    value === "cancelled"
  ) {
    return value;
  }
  return null;
}

/** Index-signature stream field access (StreamEvent is a loose record). */
function streamString(event: StreamEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === "string" ? value : undefined;
}

type LiveTail = { delta: string; reasoning: string };

export class SubagentsWindowController {
  private readonly root: HTMLElement;
  private readonly chrome: HTMLElement;
  private readonly sessionPill: HTMLElement;
  private readonly chromeMeta: HTMLElement;
  private readonly runningChip: HTMLElement;
  private readonly runningChipLabel: HTMLElement;
  private readonly runsLabel: HTMLElement;
  private readonly tabStrip: HTMLElement;
  private readonly tabsShell: HTMLElement;
  private readonly fadeLeft: HTMLElement;
  private readonly fadeRight: HTMLElement;
  private readonly pane: HTMLElement;
  private readonly paneInner: HTMLElement;
  private readonly emptyState: HTMLElement;

  private sessionId = "";
  private runs: SubagentRunSummary[] = [];
  private activeRunId: string | null = null;
  /**
   * Auto-follow the newest live run only until the user picks a tab
   * themselves — a manual selection must survive the throttled refreshes
   * (applyRuns used to yank it back to whatever was still running).
   */
  private followLive = true;
  private disposed = false;
  private unsubscribeStream: (() => void) | null = null;

  /** Committed messages per run (cache for instant tab switches). */
  private readonly messagesByRun = new Map<string, SessionMessage[]>();
  /** Streaming tails per run — cleared once the transcript covers them. */
  private readonly tailByRun = new Map<string, LiveTail>();
  private readonly scrollTopByRun = new Map<string, number>();
  /** Run id → epoch ms when its tab may collapse to icon + label. */
  private readonly compactAtByRun = new Map<string, number>();

  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshInFlight = false;
  private refreshQueued = false;
  private renderGeneration = 0;
  private unbindWindowResize: (() => void) | null = null;
  private readonly onWindowResize = (): void => this.updateFades();

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "subagents-panel";

    this.chrome = document.createElement("div");
    this.chrome.className = "subagents-chrome";

    const title = document.createElement("span");
    title.className = "subagents-title";
    title.textContent = "Subagents";
    this.sessionPill = document.createElement("span");
    this.sessionPill.className = "subagents-session-pill";
    this.sessionPill.hidden = true;

    this.chromeMeta = document.createElement("div");
    this.chromeMeta.className = "subagents-chrome-meta";
    this.runningChip = document.createElement("span");
    this.runningChip.className = "subagents-chip is-running";
    const chipDot = document.createElement("span");
    chipDot.className = "subagents-chip-dot";
    this.runningChipLabel = document.createElement("span");
    this.runningChip.append(chipDot, this.runningChipLabel);
    this.runningChip.hidden = true;
    this.runsLabel = document.createElement("span");
    this.runsLabel.textContent = "";
    this.chromeMeta.append(this.runningChip, this.runsLabel);

    this.chrome.append(title, this.sessionPill, this.chromeMeta);

    this.tabsShell = document.createElement("div");
    this.tabsShell.className = "subagents-tabs-shell";

    this.tabStrip = document.createElement("div");
    this.tabStrip.className = "subagents-tabs";
    this.tabStrip.setAttribute("role", "tablist");

    // Edge fades are the overflow affordance (the scrollbar is hidden);
    // visibility is data-driven — each side's fade switches off once the
    // strip is scrolled flush to that end.
    this.fadeLeft = document.createElement("div");
    this.fadeLeft.className = "subagents-tabs-fade subagents-tabs-fade-left";
    this.fadeLeft.setAttribute("aria-hidden", "true");
    this.fadeRight = document.createElement("div");
    this.fadeRight.className = "subagents-tabs-fade subagents-tabs-fade-right";
    this.fadeRight.setAttribute("aria-hidden", "true");

    this.tabsShell.append(this.tabStrip, this.fadeLeft, this.fadeRight);

    this.pane = document.createElement("div");
    this.pane.className = "subagents-pane";
    this.paneInner = document.createElement("div");
    this.paneInner.className = "subagents-pane-inner";
    this.pane.append(this.paneInner);
    this.pane.hidden = true;

    this.pane.addEventListener(
      "scroll",
      () => {
        if (this.activeRunId !== null) {
          this.scrollTopByRun.set(this.activeRunId, this.pane.scrollTop);
        }
      },
      { passive: true },
    );

    this.emptyState = document.createElement("div");
    this.emptyState.className = "subagents-empty";
    const botIcon = createLucideIcon(Bot, { size: 30, strokeWidth: 1.6 });
    const emptyTitle = document.createElement("div");
    emptyTitle.textContent = "No subagent runs yet";
    const emptyHint = document.createElement("div");
    emptyHint.className = "subagents-empty-hint";
    emptyHint.textContent =
      "Runs dispatched from this conversation appear here with their full transcript. The window follows the conversation you opened it from.";
    this.emptyState.append(botIcon, emptyTitle, emptyHint);

    this.root.append(this.chrome, this.tabsShell, this.pane, this.emptyState);
  }

  mount(host: HTMLElement): void {
    host.append(this.root);
    const bridge = window.jellybot;
    if (bridge?.onAgentStream) {
      this.unsubscribeStream = bridge.onAgentStream((payload) => {
        this.handleStreamEvent(payload);
      });
    }
    // Single-row strip: vertical wheel scrolls it sideways; fades track
    // the scroll position (and window resizes).
    this.tabStrip.addEventListener(
      "wheel",
      (event) => {
        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
          this.tabStrip.scrollLeft += event.deltaY;
          event.preventDefault();
        }
      },
      { passive: false },
    );
    this.tabStrip.addEventListener(
      "scroll",
      () => this.updateFades(),
      { passive: true },
    );
    this.unbindWindowResize = () => window.removeEventListener("resize", this.onWindowResize);
    window.addEventListener("resize", this.onWindowResize);
  }

  /** Windows-only: brand + caption buttons take over the hidden title bar. */
  mountWindowsChrome(brand: HTMLElement, captionGroup: HTMLElement): void {
    this.chrome.prepend(brand);
    this.chromeMeta.append(captionGroup);
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.unbindWindowResize?.();
    this.unbindWindowResize = null;
    this.unsubscribeStream?.();
    this.unsubscribeStream = null;
    this.root.remove();
  }

  setSession(sessionId: string): void {
    const next = sessionId.trim();
    if (!next || next === this.sessionId) return;
    this.sessionId = next;
    this.runs = [];
    this.activeRunId = null;
    this.followLive = true;
    this.messagesByRun.clear();
    this.tailByRun.clear();
    this.scrollTopByRun.clear();
    this.compactAtByRun.clear();
    this.renderGeneration += 1;
    this.renderTabs();
    this.paneInner.replaceChildren();
    this.syncChrome();
    void this.loadSessionTitle();
    void this.refresh({ immediate: true });
  }

  private async loadSessionTitle(): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge?.getSession || !this.sessionId) return;
    try {
      const session = await bridge.getSession(this.sessionId);
      if (this.disposed || !session) return;
      const title = session.title?.trim();
      if (title) {
        this.sessionPill.textContent = title;
        this.sessionPill.hidden = false;
      }
    } catch {
      // Title pill is cosmetic — leave hidden on failure.
    }
  }

  // ── data ──────────────────────────────────────────────────────

  private async refresh(options?: { immediate?: boolean }): Promise<void> {
    if (this.disposed || !this.sessionId) return;
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return;
    }
    this.refreshInFlight = true;
    try {
      const bridge = window.jellybot;
      if (!bridge?.listSubagents || !bridge.getSubagentTranscript) return;
      const runs = await bridge.listSubagents(this.sessionId);
      if (this.disposed) return;
      // Runs are persistent history (they never get deleted) — an empty
      // list after we already have runs is a transient miss (live-manager /
      // DB merge timing), not a deletion. Keep the last known set so the
      // tab strip never flashes empty and collapses the header area.
      if (runs.length === 0 && this.runs.length > 0) return;
      this.applyRuns(runs);
      await this.refreshActiveTranscript();
    } catch (err) {
      console.error("[subagents] refresh failed", err);
    } finally {
      this.refreshInFlight = false;
      if (this.refreshQueued && !this.disposed) {
        this.refreshQueued = false;
        void this.refresh({ immediate: true });
      }
    }
  }

  private scheduleRefresh(delayMs: number): void {
    if (this.disposed || !this.sessionId) return;
    if (this.refreshTimer !== null) {
      // Trailing edge keeps the soonest deadline.
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh({ immediate: true });
    }, delayMs);
  }

  private applyRuns(runs: SubagentRunSummary[]): void {
    this.runs = [...runs].sort((a, b) => a.createdAt - b.createdAt);
    this.seedCompactSchedule(this.runs);

    // First open / no selection: follow the newest live run, else newest.
    let revealAfterRender = false;
    if (this.activeRunId === null || !this.runs.some((r) => r.id === this.activeRunId)) {
      const live = [...this.runs]
        .reverse()
        .find((r) => !isTerminalStatus(r.status));
      const next = live ?? this.runs[this.runs.length - 1];
      this.activeRunId = next ? next.id : null;
      revealAfterRender = true;
    } else {
      const active = this.runs.find((r) => r.id === this.activeRunId);
      // Follow the action ONLY while auto-following: switch to a newer live
      // run while ours is terminal. A manual selection always sticks.
      if (this.followLive && active && isTerminalStatus(active.status)) {
        const live = [...this.runs]
          .reverse()
          .find((r) => !isTerminalStatus(r.status));
        if (live && live.createdAt > active.createdAt) {
          this.setActiveRun(live.id);
        }
      }
    }
    this.renderTabs();
    this.syncChrome();
    // Reveal LAST: an earlier reveal would be cancelled by the rebuild
    // above (replaceChildren clamps scrollLeft to 0 for a frame).
    if (revealAfterRender) this.revealActiveTab();
  }

  private async refreshActiveTranscript(): Promise<void> {
    const runId = this.activeRunId;
    if (!runId) return;
    const bridge = window.jellybot;
    if (!bridge?.getSubagentTranscript) return;
    let transcript: SubagentTranscript | null = null;
    try {
      transcript = await bridge.getSubagentTranscript(this.sessionId, runId);
    } catch (err) {
      console.error("[subagents] transcript load failed", err);
      return;
    }
    if (this.disposed || !transcript) return;
    this.messagesByRun.set(runId, transcript.messages);
    const run = this.runs.find((r) => r.id === runId);
    if (run) {
      const patched: SubagentRunSummary = {
        ...run,
        status: transcript.run.status,
        progressText: transcript.run.progressText,
      };
      this.runs = this.runs.map((r) => (r.id === runId ? patched : r));
      this.renderTabs();
      this.syncChrome();
    }
    this.pruneTail(runId, transcript.messages);
    if (this.activeRunId === runId) {
      await this.renderTranscript(runId);
    }
  }

  /** Drop the live tail once committed messages cover its length. */
  private pruneTail(runId: string, messages: SessionMessage[]): void {
    const tail = this.tailByRun.get(runId);
    if (!tail) return;
    let committedLen = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]!;
      if (message.role !== "assistant") {
        if (message.role === "user") break;
        continue;
      }
      for (const part of message.parts) {
        if (part.type === "text" && typeof part.text === "string") {
          committedLen += part.text.length;
        }
      }
    }
    if (committedLen >= tail.delta.length + tail.reasoning.length) {
      this.tailByRun.delete(runId);
    }
  }

  // ── stream events ────────────────────────────────────────────

  private handleStreamEvent(payload: AgentStreamPayload): void {
    if (!this.sessionId || payload.sessionId !== this.sessionId) return;
    const event = payload.event;
    if (!event || typeof event !== "object") return;
    const type = (event as { type?: unknown }).type;

    if (type === "subagent") {
      const id = streamString(event, "id");
      if (!id) return;
      const status = asRunStatus(event.status);
      const known = this.runs.find((r) => r.id === id);
      if (known && status) {
        const progressText = streamString(event, "progressText");
        this.runs = this.runs.map((r) =>
          r.id === id
            ? {
                ...r,
                status,
                progressText: progressText ?? r.progressText,
              }
            : r,
        );
        this.renderTabs();
        this.syncChrome();
      }
      if (status && isTerminalStatus(status)) {
        // Completed tabs collapse to icon + label 10s later.
        if (status === "completed" && !this.compactAtByRun.has(id)) {
          const due = Date.now() + COMPACT_AFTER_MS;
          this.compactAtByRun.set(id, due);
          this.scheduleCompactToggle(id, COMPACT_AFTER_MS);
        }
        // Final persist flushes the last checkpoint — re-pull after a beat.
        setTimeout(() => {
          if (!this.disposed) void this.refresh({ immediate: true });
        }, TERMINAL_FLUSH_MS);
      }
      this.scheduleRefresh(TRANSCRIPT_REFRESH_LIFECYCLE_MS);
      return;
    }

    if (type === "subagent_live") {
      const id = streamString(event, "id");
      if (!id) return;
      const kind = event.kind;
      const text = streamString(event, "text") ?? "";
      if (kind === "delta" || kind === "reasoning") {
        const tail =
          this.tailByRun.get(id) ?? { delta: "", reasoning: "" };
        const next: LiveTail =
          kind === "delta"
            ? { ...tail, delta: tail.delta + text }
            : { ...tail, reasoning: tail.reasoning + text };
        this.tailByRun.set(id, next);
        if (this.activeRunId === id) this.renderTail(id);
      }
      this.scheduleRefresh(TRANSCRIPT_REFRESH_LIVE_MS);
    }
  }

  // ── compact tabs (completed runs collapse to icon + label) ────

  /**
   * Derive each completed run's compact deadline from its updatedAt (≈
   * completion time) — runs finished >10s ago (window reopened later) are
   * due immediately; fresher ones get a timer. Live completions hook in
   * from handleStreamEvent.
   */
  private seedCompactSchedule(runs: SubagentRunSummary[]): void {
    const now = Date.now();
    for (const run of runs) {
      if (run.status !== "completed") continue;
      if (this.compactAtByRun.has(run.id)) continue;
      const due = run.updatedAt + COMPACT_AFTER_MS;
      this.compactAtByRun.set(run.id, due);
      if (due > now) this.scheduleCompactToggle(run.id, due - now);
    }
  }

  private scheduleCompactToggle(runId: string, delayMs: number): void {
    setTimeout(() => {
      if (this.disposed || !this.isRunCompactNow(runId)) return;
      for (const el of Array.from(this.tabStrip.children)) {
        if (el instanceof HTMLElement && el.dataset.runId === runId) {
          el.classList.add("is-compact");
        }
      }
    }, delayMs);
  }

  /** Tab is (or should render as) compact: completed and past deadline. */
  private isRunCompactNow(runId: string): boolean {
    const run = this.runs.find((r) => r.id === runId);
    if (!run || run.status !== "completed") return false;
    const due = this.compactAtByRun.get(run.id);
    return due != null && Date.now() >= due;
  }

  // ── rendering ────────────────────────────────────────────────

  private syncChrome(): void {
    const live = this.runs.filter((r) => !isTerminalStatus(r.status)).length;
    this.runningChipLabel.textContent = `${live} running`;
    this.runningChip.hidden = live === 0;
    this.runsLabel.textContent = this.runs.length > 0 ? `${this.runs.length} runs` : "";
    this.tabsShell.hidden = this.runs.length === 0;
    this.pane.hidden = this.runs.length === 0;
    this.emptyState.hidden = this.runs.length > 0;
  }

  private renderTabs(): void {
    // replaceChildren collapses scrollWidth to 0 for a frame, which clamps
    // scrollLeft back to 0 — preserve the reading position across rebuilds.
    const savedScroll = this.tabStrip.scrollLeft;
    this.tabStrip.replaceChildren();
    for (const run of this.runs) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "subagents-tab";
      tab.dataset.status = run.status;
      tab.dataset.runId = run.id;
      if (this.isRunCompactNow(run.id)) tab.classList.add("is-compact");
      tab.setAttribute("role", "tab");
      tab.setAttribute(
        "aria-selected",
        run.id === this.activeRunId ? "true" : "false",
      );
      tab.classList.toggle("is-active", run.id === this.activeRunId);
      tab.title = run.name || "Subagent";

      const spinner = document.createElement("span");
      spinner.className = "subagents-tab-spinner";
      spinner.setAttribute("aria-hidden", "true");
      spinner.append(createLucideIcon(LoaderCircle, { size: 12 }));

      // Terminal mark replaces the spinner in the same leading slot:
      // completed → green circle-check, error → red circle-x,
      // cancelled → dim circle-slash. Single node per tab.
      const terminalIcon = document.createElement("span");
      terminalIcon.className = "subagents-tab-terminal";
      terminalIcon.setAttribute("aria-hidden", "true");
      terminalIcon.dataset.status = run.status;
      const terminalGlyph = isTerminalStatus(run.status)
        ? run.status === "completed"
          ? CircleCheck
          : run.status === "error"
            ? CircleX
            : CircleSlash
        : null;
      if (terminalGlyph) {
        terminalIcon.append(createLucideIcon(terminalGlyph, { size: 12 }));
      }

      const label = document.createElement("span");
      label.className = "subagents-tab-label";
      label.textContent = run.name || "Subagent";

      const roleBadge = document.createElement("span");
      roleBadge.className = "subagents-tab-role";
      roleBadge.dataset.role = run.role || "general";
      roleBadge.textContent = run.role || "general";

      tab.append(spinner, terminalIcon, label, roleBadge);
      tab.addEventListener("click", () =>
        this.setActiveRun(run.id, { manual: true }),
      );
      this.tabStrip.append(tab);
    }
    this.tabStrip.scrollLeft = savedScroll;
    this.updateFades();
  }

  /** Edge-fade visibility: on while content is hidden past that side. */
  private updateFades(): void {
    const el = this.tabStrip;
    const max = el.scrollWidth - el.clientWidth;
    this.fadeLeft.classList.toggle("is-on", el.scrollLeft > 2);
    this.fadeRight.classList.toggle("is-on", el.scrollLeft < max - 2);
  }

  /** Scroll the active tab into view if it sits outside the viewport.
   * Instant on purpose: smooth scrolls get cancelled by the next
   * renderTabs rebuild (replaceChildren resets scrollLeft mid-flight). */
  private revealActiveTab(): void {
    const runId = this.activeRunId;
    if (!runId) return;
    for (const el of Array.from(this.tabStrip.children)) {
      if (!(el instanceof HTMLElement) || el.dataset.runId !== runId) continue;
      const left = el.offsetLeft;
      const right = left + el.offsetWidth;
      let target: number | null = null;
      if (left < this.tabStrip.scrollLeft + 12) {
        target = left - 12;
      } else if (right > this.tabStrip.scrollLeft + this.tabStrip.clientWidth - 12) {
        target = right - this.tabStrip.clientWidth + 12;
      }
      if (target !== null) {
        this.tabStrip.scrollTo({ left: Math.max(0, target), behavior: "instant" });
      }
      this.updateFades();
      return;
    }
  }

  private setActiveRun(runId: string, options?: { manual?: boolean }): void {
    if (options?.manual) this.followLive = false;
    if (this.activeRunId === runId) return;
    this.activeRunId = runId;
    this.renderTabs();
    this.revealActiveTab();
    this.pane.scrollTop = this.scrollTopByRun.get(runId) ?? this.pane.scrollHeight;
    void this.refreshActiveTranscript();
  }

  private async renderTranscript(runId: string): Promise<void> {
    const generation = ++this.renderGeneration;
    const messages = this.messagesByRun.get(runId) ?? [];
    const wasSticky = this.isNearBottom();

    const bridge = window.jellybot;
    const ctx = buildMessageRenderContext(messages, {
      sessionId: this.sessionId,
      revealLabel:
        bridge?.platform === "darwin" ? "Reveal in Finder" : "Show in Folder",
      onOpenFile: (path) => {
        void bridge?.openPath(path).catch((err: unknown) => {
          console.error("[subagents] openPath failed", err);
        });
      },
      onRevealFile: (path) => {
        void bridge?.showItemInFolder(path).catch((err: unknown) => {
          console.error("[subagents] showItemInFolder failed", err);
        });
      },
      ...(bridge?.saveFileAs
        ? {
            onSaveFile: (path: string) => {
              void bridge.saveFileAs?.(path).catch((err: unknown) => {
                console.error("[subagents] saveFileAs failed", err);
              });
            },
          }
        : {}),
    });

    // A subagent transcript is exactly one turn — mirror the conversation's
    // .conversation-turn (gap 18px) wrapper so spacing matches the main view.
    const turn = document.createElement("div");
    turn.className = "conversation-turn";
    for (const message of projectTranscriptMessages(messages)) {
      const row = await createMessageViewAsync(message, ctx);
      if (row) turn.append(row);
    }

    this.appendTail(turn, runId);

    if (this.disposed || generation !== this.renderGeneration) return;
    if (this.activeRunId !== runId) return;
    this.paneInner.replaceChildren(turn);
    this.pane.scrollTop = wasSticky
      ? this.pane.scrollHeight
      : (this.scrollTopByRun.get(runId) ?? 0);
  }

  /** Tail repaint only (streaming deltas between checkpoints). */
  private renderTail(runId: string): void {
    const turn = this.paneInner.firstElementChild;
    if (!(turn instanceof HTMLElement)) {
      void this.renderTranscript(runId);
      return;
    }
    const existing = turn.querySelector(".subagents-tail-host");
    if (existing) existing.remove();
    this.appendTail(turn, runId);
    if (this.isNearBottom()) {
      this.pane.scrollTop = this.pane.scrollHeight;
    }
  }

  private appendTail(turn: HTMLElement, runId: string): void {
    const tail = this.tailByRun.get(runId);
    const running = this.runs.find((r) => r.id === runId);
    const isRunning = running ? !isTerminalStatus(running.status) : false;
    if (!tail || (!tail.delta && !tail.reasoning) || !isRunning) return;

    const host = document.createElement("div");
    host.className = "subagents-tail-host";

    if (tail.reasoning) {
      const block = document.createElement("div");
      block.className = "subagents-tail-reasoning";
      block.textContent = tail.reasoning;
      host.append(block);
    }
    if (tail.delta) {
      const block = document.createElement("div");
      block.className = "subagents-tail message-part-text";
      try {
        renderMarkdownText(tail.delta, block, { streaming: true });
      } catch {
        block.textContent = tail.delta;
      }
      const caret = document.createElement("span");
      caret.className = "subagents-tail-caret";
      caret.setAttribute("aria-hidden", "true");
      block.append(caret);
      host.append(block);
    }
    turn.append(host);
  }

  private isNearBottom(): boolean {
    return (
      this.pane.scrollHeight - this.pane.scrollTop - this.pane.clientHeight <=
      STICKY_THRESHOLD_PX
    );
  }
}
