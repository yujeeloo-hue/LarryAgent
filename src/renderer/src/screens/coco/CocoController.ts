import { ConversationController } from "../conversation/ConversationController.js";
import { ConversationView } from "../conversation/ConversationView.js";
import "../conversation/conversation.css";
import type { CocoCommand, CocoSnapshot, CocoHistoryPage, CocoRule } from "../../../../coco/types.js";
import { isCocoUnavailable } from "../../../../coco/status.js";
import { upcomingScheduledRuns } from "../../../../coco/upcomingSchedule.js";
import { isNewReport } from "../../../../coco/overviewOrder.js";
import { cocoState } from "../../state/cocoState.js";
import { showConfirm } from "../../ui/messageDialogs.js";
import { CocoView } from "./CocoView.js";

const cocoViewMemory = { chatOpen: true };
const NOT_READY = "CoCo is not ready yet. Your draft is kept here.";
const REPORTS_SEEN_KEY = "coco.reportsSeenAt";
const CHAT_RECENT_WINDOW_MS = 60 * 60 * 1000;
const COMPOSER = { placeholder: "Give CoCo a goal, ask a question, or adjust the plan…", queuePlaceholder: "Queue a message for after this CoCo reply…" };
const readReportsSeenAt = (): number => { try { return Number(localStorage.getItem(REPORTS_SEEN_KEY)) || 0; } catch { return 0; } };

const activityText = (s: CocoSnapshot): string =>
  isCocoUnavailable(s.state) ? NOT_READY
  : s.chat?.approval?.onBehalfOf ? "CoCo is waiting for tool confirmation."
  : s.chat?.question?.onBehalfOf ? "CoCo is waiting for your answer."
  : "";

const STRUCTURAL_STREAM = new Set(["status", "done", "error", "transcript_changed", "new_task_boundary", "progress"]);

export class CocoController {
  private view: CocoView | undefined;
  private transcript: ConversationController | undefined;
  private transcriptView: ConversationView | undefined;
  private transcriptSessionId = "";
  private textOnlyKey = "";
  private chatJobId = "";
  private streamUnsubscribe: (() => void) | undefined;
  private streamRefresh: ReturnType<typeof setTimeout> | undefined;
  private unsubscribeSnapshot: (() => void) | undefined;
  private snapshot: CocoSnapshot | undefined;
  private referenceId: string | undefined;
  private historyPages = new Map<string, CocoHistoryPage>();
  private destroyed = false;
  private visitRequested = false;
  private wakeRequested = false;
  private reportsSeenAt = readReportsSeenAt();
  constructor(private options: { onSessionSelect: (sessionId: string) => void; onOpenSettings?: () => void }) {}
  mount(): HTMLElement {
    const view = this.view = new CocoView({
      command: command => this.command(command),
      act: command => this.act(command),
      focusComposer: () => this.transcriptView?.focusInput(),
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
    }, cocoViewMemory.chatOpen);
    this.streamUnsubscribe = window.jellybot?.onAgentStream?.(payload => {
      const eventType = (payload.event as { type?: string } | undefined)?.type;
      if (!eventType || !STRUCTURAL_STREAM.has(eventType) || this.streamRefresh) return;
      const chatId = this.snapshot?.chat?.sessionId;
      const isChat = payload.sessionId === chatId;
      const isBackground = this.snapshot?.backgroundTasks?.some(task => task.sessionId === payload.sessionId);
      if (!isChat && !isBackground) return;
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
    this.destroyed = true;
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
    try { localStorage.setItem(REPORTS_SEEN_KEY, String(latest)); } catch {  }
    if (!this.destroyed) this.renderMain(true);
  }
  private deleteRule(rule: CocoRule): void {
    void showConfirm(`Delete “${rule.name}”?`, { title: "Delete rule", confirmLabel: "Delete", destructive: true }).then(ok => { if (ok) this.act({ type: "rule", action: "delete", id: rule.id }); });
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
    if (!this.transcript) return;
    this.transcript.destroy(); this.transcript = undefined; this.transcriptView = undefined; this.transcriptSessionId = "";
    this.view?.setTranscript(undefined);
  }
  private syncTranscript(snapshot: CocoSnapshot): void {
    const nativeId = snapshot.chat?.sessionId;
    if (!nativeId) { this.dropTranscript(); return; }
    const textOnlyKey = `${(snapshot.chat?.textOnlyMessageIds ?? []).join(",")}|${(snapshot.chat?.turnStartMessageIds ?? []).join(",")}`;
    const chatJobId = snapshot.chatJob?.id ?? "";
    if (nativeId === this.transcriptSessionId) {
      const jobEnded = !!this.chatJobId && chatJobId !== this.chatJobId;
      this.chatJobId = chatJobId;
      if (textOnlyKey !== this.textOnlyKey || jobEnded) { this.textOnlyKey = textOnlyKey; this.transcript?.refreshDisplay(); }
      return;
    }
    if (!window.jellybot?.getSessionTail) return;
    this.textOnlyKey = textOnlyKey; this.chatJobId = chatJobId;
    this.transcript?.destroy();
    this.transcriptSessionId = nativeId;
    const transcriptView = this.transcriptView = new ConversationView();
    this.transcript = new ConversationController(transcriptView, nativeId, {
      compactComposer: COMPOSER,
      promptExtras: () => this.referenceId ? { cocoWorkId: this.referenceId } : {},
      textOnlyMessageIds: () => new Set(this.snapshot?.chat?.textOnlyMessageIds ?? []),
      turnStartMessageIds: () => new Set(this.snapshot?.chat?.turnStartMessageIds ?? []),
      quietCurrentTurn: () => this.snapshot?.chatJob?.kind === "greet",
      recentWindowMs: CHAT_RECENT_WINDOW_MS,
    });
    this.view?.setTranscript(this.transcript.mount(), transcriptView.messagesEl);
  }
  private renderChat(): void {
    const snapshot = this.snapshot; if (!snapshot || !this.view) return;
    this.view.renderChat(snapshot, { activity: activityText(snapshot), reference: snapshot.work.find(w => w.id === this.referenceId) });
  }
}
