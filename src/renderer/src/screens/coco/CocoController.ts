import { ConversationController } from "../conversation/ConversationController.js";
import { ConversationView } from "../conversation/ConversationView.js";
import "../conversation/conversation.css";
import type { CocoCommand, CocoSnapshot, CocoHistoryPage, CocoRule } from "../../../../coco/types.js";
import { isCocoUnavailable } from "../../../../coco/status.js";
import { upcomingScheduledRuns } from "../../../../coco/upcomingSchedule.js";
import { isNewReport } from "../../../../coco/overviewOrder.js";
import { cocoState } from "../../state/cocoState.js";
import { CocoView, type CocoSendState } from "./CocoView.js";
import { CocoPromptQueueController } from "./CocoPromptQueueController.js";
import { resolveComposerSubmitAction } from "../conversation/promptQueueGesture.js";

const cocoViewMemory = { draft: "", chatOpen: true };
const NOT_READY = "CoCo is not ready yet. Your draft is kept here.";
const REPORTS_SEEN_KEY = "coco.reportsSeenAt";
const readReportsSeenAt = (): number => { try { return Number(localStorage.getItem(REPORTS_SEEN_KEY)) || 0; } catch { return 0; } };

const activityText = (s: CocoSnapshot): string =>
  isCocoUnavailable(s.state) ? NOT_READY
  : s.chat?.approval ? "CoCo is waiting for tool confirmation."
  : s.chat?.question ? "CoCo is waiting for your answer."
  : s.messages.at(-1)?.role === "user" && !s.chatJob ? "Your message will follow the current CoCo reply." : "";

/** Snapshot refresh is for chrome (send face, prompts, task cards) — not for token streaming. */
const STRUCTURAL_STREAM = new Set(["status", "done", "error", "transcript_changed", "progress"]);

/** CoCo screen logic: snapshot subscription, commands, chat transcript and reference state. */
export class CocoController {
  private view: CocoView | undefined;
  private promptQueue = new CocoPromptQueueController(() => window.jellybot, () => {
    if (this.destroyed) return;
    this.view?.setPromptQueue(this.promptQueue.viewItems, this.promptQueue.handlers);
    this.updateSendState();
  }, text => this.view?.setNotice(text));
  private pendingQueueText = "";
  private transcript: ConversationController | undefined;
  private transcriptSessionId = "";
  private textOnlyKey = "";
  private streamUnsubscribe: (() => void) | undefined;
  private streamRefresh: ReturnType<typeof setTimeout> | undefined;
  private unsubscribeSnapshot: (() => void) | undefined;
  private snapshot: CocoSnapshot | undefined;
  private referenceId: string | undefined;
  private historyPages = new Map<string, CocoHistoryPage>();
  private destroyed = false;
  private busy = false;
  private visitRequested = false;
  private wakeRequested = false;
  private reportsSeenAt = readReportsSeenAt();
  constructor(private options: { onSessionSelect: (sessionId: string) => void; onOpenSettings?: () => void }) {}
  mount(): HTMLElement {
    const view = this.view = new CocoView({
      command: command => this.command(command),
      act: command => this.act(command),
      submit: () => { void this.submit(); },
      sendClicked: () => { void this.submit(); },
      draftChanged: text => { cocoViewMemory.draft = text; this.updateSendState(); },
      chatToggled: open => { cocoViewMemory.chatOpen = open; },
      workFocused: id => { this.referenceId = id; this.renderChat(); },
      removeReference: () => { this.referenceId = undefined; this.renderChat(); },
      loadHistory: (ruleId, cursor) => { void this.loadHistory(ruleId, cursor); },
      deleteRule: rule => this.deleteRule(rule),
      enable: () => this.command({ type: "activation", action: "enable" }),
      retry: () => { void this.refresh(); },
      sessionSelect: id => this.options.onSessionSelect(id),
      reportsViewed: () => this.markReportsViewed(),
      ...(this.options.onOpenSettings ? { openSettings: this.options.onOpenSettings } : {}),
    }, cocoViewMemory.chatOpen, cocoViewMemory.draft);
    this.streamUnsubscribe = window.jellybot?.onAgentStream?.(payload => {
      this.promptQueue.onStream(payload);
      const eventType = (payload.event as { type?: string } | undefined)?.type;
      if (!eventType || !STRUCTURAL_STREAM.has(eventType) || this.streamRefresh) return;
      const chatId = this.snapshot?.chat?.sessionId;
      const isChat = payload.sessionId === chatId;
      const isBackground = this.snapshot?.backgroundTasks?.some(task => task.sessionId === payload.sessionId);
      if (!isChat && !isBackground) return;
      // Progress ticks only update background task cards; debounce longer so the
      // conversation panel is not snapshotted on every model token of a check.
      const delay = eventType === "progress" && isBackground && !isChat ? 800 : 120;
      this.streamRefresh = setTimeout(() => { this.streamRefresh = undefined; void this.refresh(); }, delay);
    });
    this.unsubscribeSnapshot = cocoState.subscribe(snapshot => {
      if (this.destroyed) return;
      this.snapshot = snapshot; this.renderSnapshot();
    });
    void this.refresh();
    return view.frame;
  }
  destroy(): void {
    if (this.view) cocoViewMemory.draft = this.view.composerValue;
    this.destroyed = true;
    this.promptQueue.destroy();
    this.transcript?.destroy(); this.view?.destroy();
    this.unsubscribeSnapshot?.(); this.streamUnsubscribe?.(); if (this.streamRefresh) clearTimeout(this.streamRefresh);
  }
  private async refresh(): Promise<void> {
    if (this.destroyed) return;
    try { await cocoState.refresh(); }
    catch (error) { this.view?.setNotice(String(error)); if (!this.snapshot) this.view?.showLoadError(String(error)); }
  }
  private async command(command: CocoCommand): Promise<void> {
    if (!window.jellybot) return;
    try { const snapshot = await window.jellybot.cocoCommand(command); cocoState.publish(snapshot); if (this.destroyed) return; this.renderSnapshot(true); this.view?.setNotice(""); }
    catch (error) { this.view?.setNotice(String(error)); throw error; }
  }
  private act(command: CocoCommand): void { void this.command(command).catch(() => {}); }
  private async loadHistory(ruleId: string, cursor: NonNullable<CocoHistoryPage["nextCursor"]>): Promise<void> {
    try {
      const page = await window.jellybot!.cocoHistory(ruleId, cursor);
      const runs = this.historyPages.get(ruleId)?.runs ?? this.snapshot?.legacyRuns.filter(run => run.ruleId === ruleId) ?? [];
      this.historyPages.set(ruleId, { runs: [...runs, ...page.runs], nextCursor: page.nextCursor });
      if (!this.destroyed) this.renderMain(true);
    } catch (error) { this.view?.setNotice(String(error)); }
  }
  private renderMain(force: boolean): void {
    const snapshot = this.snapshot; if (!snapshot) return;
    const now = Date.now(), scheduled = upcomingScheduledRuns(snapshot.rules, now), latestReport = snapshot.reports[0];
    const reportNew = !!latestReport && isNewReport(latestReport.at, this.reportsSeenAt, now);
    this.view?.renderMain({ snapshot, historyPages: this.historyPages, scheduled, reportNew }, force);
  }
  private markReportsViewed(): void {
    const latest = this.snapshot?.reports[0]?.at ?? 0; if (latest <= this.reportsSeenAt) return;
    this.reportsSeenAt = latest;
    try { localStorage.setItem(REPORTS_SEEN_KEY, String(latest)); } catch { /* storage unavailable: keep in memory */ }
    if (!this.destroyed) this.renderMain(true);
  }
  private deleteRule(rule: CocoRule): void {
    void window.jellybot?.confirmDialog({ message: `Delete “${rule.name}”?` }).then(ok => { if (ok) this.act({ type: "rule", action: "delete", id: rule.id }); });
  }
  private renderSnapshot(force = false): void {
    const snapshot = this.snapshot, view = this.view; if (!snapshot || !view || this.destroyed) return;
    if (!snapshot.settings.enabled) {
      this.dropTranscript();
      view.showDisabled();
    } else {
      view.showEnabled();
      this.renderMain(force);
      this.syncTranscript(snapshot); this.renderChat();
      if (!this.wakeRequested && !isCocoUnavailable(snapshot.state)) {
        this.wakeRequested = true;
        queueMicrotask(() => { if (!this.destroyed) void this.command({ type: "wake" }).catch(() => { this.wakeRequested = false; }); });
      }
    }
    if (!snapshot.activationSeen && !this.visitRequested) {
      this.visitRequested = true;
      // Mount completes before opening a modal, including when the store has a cached snapshot.
      queueMicrotask(() => {
        if (this.destroyed) return;
        void this.command({ type: "activation", action: "visit" }).then(() => {
          this.view?.setActivationNotice("");
          if (!this.destroyed && !this.snapshot?.settings.enabled) this.view?.openActivation();
        }).catch(error => { this.visitRequested = false; if (!this.destroyed) this.view?.setActivationNotice(String(error)); });
      });
    }
  }
  private dropTranscript(): void {
    this.promptQueue.setSession("");
    if (!this.transcript) return;
    this.transcript.destroy(); this.transcript = undefined; this.transcriptSessionId = "";
    this.view?.setTranscript(undefined);
  }
  private syncTranscript(snapshot: CocoSnapshot): void {
    const nativeId = snapshot.chat?.sessionId;
    this.promptQueue.setSession(nativeId ?? "");
    if (!nativeId) { this.dropTranscript(); return; }
    const textOnlyKey = `${(snapshot.chat?.textOnlyMessageIds ?? []).join(",")}|${(snapshot.chat?.turnStartMessageIds ?? []).join(",")}`;
    if (nativeId === this.transcriptSessionId) {
      if (textOnlyKey !== this.textOnlyKey) { this.textOnlyKey = textOnlyKey; this.transcript?.refreshDisplay(); }
      return;
    }
    if (!window.jellybot?.getSessionTail) return;
    this.textOnlyKey = textOnlyKey;
    this.transcript?.destroy();
    this.transcriptSessionId = nativeId;
    const transcriptView = new ConversationView();
    this.transcript = new ConversationController(transcriptView, nativeId, {
      transcriptOnly: true, historyWindowMs: 3600000, externalPrompts: true,
      textOnlyMessageIds: () => new Set(this.snapshot?.chat?.textOnlyMessageIds ?? []),
      turnStartMessageIds: () => new Set(this.snapshot?.chat?.turnStartMessageIds ?? []),
      quietCurrentTurn: () => this.snapshot?.chatJob?.kind === "greet",
      onPromptRestore: text => { const view = this.view; if (view && !view.composerValue.trim()) { view.composerValue = text; cocoViewMemory.draft = text; this.updateSendState(); } },
      onContextUsage: usage => this.view?.setContextUsage(usage),
      onRetryTurnError: async payload => {
        if (this.snapshot?.chatJob) return false;
        if (payload.errorMessageId) { const result = await window.jellybot!.removeTurnError(nativeId, payload.errorMessageId); if (!result.ok) return false; }
        await this.command({ type: "chat", text: payload.continuation === "retry" ? "Continue from the interrupted response and existing tool results. Do not repeat completed operations." : payload.text ?? "Continue the conversation", ...(payload.continuation === "retry" ? { continuation: "retry" as const } : {}) });
        return true;
      },
    });
    this.view?.setTranscript(this.transcript.mount(), transcriptView.messagesEl);
  }
  private renderChat(): void {
    const snapshot = this.snapshot; if (!snapshot || !this.view) return;
    this.updateSendState();
    this.view.renderChat(snapshot, { activity: activityText(snapshot), reference: snapshot.work.find(w => w.id === this.referenceId) });
  }
  private unavailable(): boolean { return !this.snapshot || !this.snapshot.settings.enabled || isCocoUnavailable(this.snapshot.state); }
  private composerAction() {
    return resolveComposerSubmitAction({
      hasContent: !!this.view?.composerValue.trim(),
      running: !!this.snapshot?.chatJob || this.snapshot?.chat?.status === "running",
      queueHasDeferred: this.promptQueue.hasDeferred,
    });
  }
  private updateSendState(): void {
    if (!this.view) return;
    const unavailable = this.unavailable(), running = !!this.snapshot?.chatJob || this.snapshot?.chat?.status === "running", action = this.composerAction(), stop = action === "stop";
    const label = action === "promote-head" ? "Insert the next queued prompt" : stop ? "Stop" : action === "enqueue" ? "Queue for after this turn" : "Send to CoCo";
    const state: CocoSendState = { running, stop, label, disabled: this.busy || (!stop && (unavailable || action === "noop")), title: !stop && unavailable ? NOT_READY : label };
    this.view.setSendState(state);
  }
  private async submit(): Promise<void> {
    const view = this.view; if (!view || this.destroyed) return;
    if (this.busy) {
      if (this.promptQueue.enqueuePending && (!view.composerValue.trim() || view.composerValue === this.pendingQueueText)) this.promptQueue.insertAfterEnqueue();
      return;
    }
    const action = this.composerAction();
    if (action === "stop") { this.act({ type: "chatControl", action: "stop" }); return; }
    if (this.unavailable()) { this.updateSendState(); return; }
    if (action === "noop") return;
    if (action === "promote-head") { await this.promptQueue.promoteHead(); return; }
    const text = view.composerValue;
    this.busy = true; this.updateSendState();
    try {
      // Answers still resume ask_user; real speech still preempts an automatic
      // remark. Ordinary interactive follow-ups share the native FIFO queue.
      const queue = action === "enqueue" && this.snapshot?.chat?.sessionId && !this.snapshot.chat.question && this.snapshot.chatJob?.kind === "chat";
      if (queue) {
        this.pendingQueueText = text;
        if (!await this.promptQueue.enqueue(text, this.referenceId)) return;
        this.view?.setNotice("");
      } else await this.command({ type: "chat", text, ...(this.referenceId ? { workId: this.referenceId } : {}) });
      if (view.composerValue === text) { view.composerValue = ""; cocoViewMemory.draft = ""; }
    } catch { /* Error is shown next to the preserved draft. */ }
    finally { this.busy = false; this.pendingQueueText = ""; this.updateSendState(); }
  }
}
