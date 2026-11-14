import { renderMarkdownText } from "../conversation/renderMarkdownText.js";
import { ArrowDown, ArrowRight, ArrowUp, ArrowUpRight, ChevronRight, Download, PanelRightClose, Square, Target, X } from "lucide";
import { createLucideIcon } from "../../ui/icons.js";
import { ComposerSendButtonView } from "../../ui/taskComposer/ComposerSendButtonView.js";
import type { PromptQueueHandlers, PromptQueueItem } from "../conversation/PromptQueueView.js";
import { CocoPromptQueueView } from "./CocoPromptQueueView.js";
import type { ContextUsage } from "../../ui/contextUsage.js";
import type { CocoCommand, CocoSnapshot, CocoWork, CocoHistoryPage, CocoRule } from "../../../../coco/types.js";
import { isActiveWork, isTerminalWork } from "../../../../coco/status.js";
import type { CocoScheduledRun } from "../../../../coco/upcomingSchedule.js";
import { OVERVIEW_ORDER, type OverviewCardId } from "../../../../coco/overviewOrder.js";
import { decisionPromptFor } from "../../../../coco/decisionPrompt.js";
import { createCocoIcon } from "../../ui/cocoIcon.js";
import chatIcon from "../../assets/coco/chat.svg?url";
import overviewIcon from "../../assets/coco/overview.svg?url";
import workIcon from "../../assets/coco/work.svg?url";
import attentionIcon from "../../assets/coco/attention.svg?url";
import rulesIcon from "../../assets/coco/rules.svg?url";
import reportsIcon from "../../assets/coco/reports.svg?url";
import { button, el } from "./dom.js";
import { ruleEditor, describeCadence } from "./CocoRuleEditor.js";
import { showCocoActivationDialog } from "./CocoActivationDialog.js";
import { CocoBudgetView } from "./CocoBudgetView.js";
import { CocoChatResizeController } from "./CocoChatResizeController.js";
import { CocoBackgroundTasksView } from "./CocoBackgroundTasksView.js";
import { CocoRecentRunsView } from "./CocoRecentRunsView.js";
import { CocoWorkResultView } from "./CocoWorkResultView.js";
import { cocoRuntimeLabel } from "./runtimeLabel.js";
import "./coco.css";

type Page = "overview" | "work" | "attention" | "rules" | "reports";
export type CocoMainData = { snapshot: CocoSnapshot; historyPages: Map<string, CocoHistoryPage>; scheduled: CocoScheduledRun[]; reportNew: boolean };
export type CocoSendState = { running: boolean; stop: boolean; label: string; disabled: boolean; title: string };
export type CocoViewHandlers = {
  command(command: CocoCommand): Promise<void>;
  act(command: CocoCommand): void;
  submit(): void;
  sendClicked(): void;
  draftChanged(text: string): void;
  chatToggled(open: boolean): void;
  workFocused(workId: string): void;
  removeReference(workId: string): void;
  loadHistory(ruleId: string, cursor: NonNullable<CocoHistoryPage["nextCursor"]>): void;
  deleteRule(rule: CocoRule): void;
  enable(): Promise<void>;
  retry(): void;
  sessionSelect(sessionId: string): void;
  reportsViewed(): void;
  openSettings?: () => void;
};

const statusLabel = (status: CocoWork["status"]): string => ({ draft: "Draft", queued: "Queued", executing: "Executing", recovering: "Recovering", verifying: "Verifying", waiting: "Waiting", to_decide: "To decide", completed: "Verified", cancelled: "Cancelled" })[status];
const image = (src: string, size = 17): HTMLImageElement => { const img = el("img"); img.src = src; img.alt = ""; img.width = size; img.height = size; img.draggable = false; return img; };

export class CocoView {
  readonly frame = el("div", "coco-frame");
  private root = el("div", "coco-workspace is-chat-open");
  private nav = el("nav", "coco-nav");
  private main = el("main", "coco-main");
  private mainPane = el("div", "coco-main-pane");
  private topFade = el("div", "coco-top-fade");
  private scrollBottom = el("button", "coco-scroll-bottom-btn");
  private scrollBottomWanted = false;
  private scrollFrame = 0;
  private scrollObserver: ResizeObserver | undefined;
  private mainHeading: HTMLElement | undefined;
  private card = el("aside", "coco-chat");
  private chatResize: CocoChatResizeController | undefined;
  private backgroundTasks = new CocoBackgroundTasksView();
  private recentRuns = new CocoRecentRunsView(work => this.showWork(work), () => this.scheduleScrollChrome());
  private workResults = new CocoWorkResultView({
    load: async workId => {
      if (!window.jellybot?.cocoWorkResults) throw new Error("Update the app to load saved run results.");
      return window.jellybot.cocoWorkResults(workId);
    },
    notice: text => this.setNotice(text),
    layoutChanged: () => this.scheduleScrollChrome(),
    openFile: async path => {
      if (!window.jellybot?.openFileReader) throw new Error("The file reader is unavailable.");
      return window.jellybot.openFileReader(path);
    },
  });
  private messages = el("div", "coco-messages");
  private composer = el("textarea", "coco-composer");
  private promptQueue = new CocoPromptQueueView();
  private reference = el("div", "coco-reference");
  private prompts = el("div", "coco-chat-prompts");
  private promptKey = "";
  private sendControl = new ComposerSendButtonView();
  private sendIcon = createLucideIcon(ArrowUp, { size: 16 });
  private stopIcon = createLucideIcon(Square, { size: 12 });
  private messageBodies = new Map<string, HTMLElement>();
  private activity = el("div", "coco-chat-activity");
  private notice = el("div", "coco-error");
  private chatButton = button("Chat", () => this.toggleChat());
  private snapshot: CocoSnapshot | undefined;
  private historyPages = new Map<string, CocoHistoryPage>();
  private scheduled: CocoScheduledRun[] = [];
  private overviewCards = el("div", "coco-overview-cards");
  private cardShells = new Map<OverviewCardId, HTMLElement>();
  private reportNew = false;
  private page: Page = "overview";
  private selected: string | undefined;
  private native = false;
  private decisionDrafts = new Map<string, string>();
  private expandedHistory = new Set<string>();
  private expandedReports = new Set<string>();
  private animation: Animation | undefined;
  private flight: HTMLElement | undefined;
  private motionTimer: ReturnType<typeof setTimeout> | undefined;
  private editorOpen = false;
  private lastMain = "";
  private budgetView: CocoBudgetView | undefined;
  private lastMessages = "";
  private lastReference = "";
  private disabledView: HTMLElement | undefined;
  private activationNotice = el("p", "coco-error");
  private closeActivation: (() => void) | undefined;
  constructor(private handlers: CocoViewHandlers, private open: boolean, draft: string) {
    this.root.classList.toggle("is-chat-open", open);
    this.card.inert = !open;
    this.composer.value = draft;
    this.composer.oninput = () => handlers.draftChanged(this.composer.value);
    this.sendControl.button.onclick = () => handlers.sendClicked();
    this.nav.setAttribute("aria-label", "CoCo navigation");
    this.nav.append(el("div", "coco-group-label", "Conversation"));
    this.chatButton.prepend(image(chatIcon)); this.chatButton.className = "coco-nav-item"; this.chatButton.setAttribute("aria-expanded", String(open));
    this.nav.append(this.chatButton, el("div", "coco-group-label", "Work"));
    for (const [id, title, icon] of [["overview", "Overview", overviewIcon], ["work", "In progress", workIcon], ["attention", "To decide", attentionIcon], ["rules", "Rules", rulesIcon], ["reports", "Reports", reportsIcon]] as const) {
      if (id === "rules") this.nav.append(el("div", "coco-group-label", "Automation"));
      const item = button(title, () => this.goTo(id)); item.className = "coco-nav-item"; item.dataset.page = id; item.prepend(image(icon)); this.nav.append(item);
    }
    const collapse = button("", () => this.toggleChat()); collapse.classList.add("coco-chat-collapse"); collapse.append(createLucideIcon(PanelRightClose)); collapse.title = "Collapse chat"; collapse.setAttribute("aria-label", "Collapse CoCo chat");
    this.messages.setAttribute("role", "log"); this.messages.setAttribute("aria-live", "polite");
    const compose = el("div", "coco-compose"); this.composer.placeholder = "Give CoCo a goal, ask a question, or adjust the plan…"; this.composer.rows = 3; this.composer.setAttribute("aria-label", "Message CoCo");
    this.composer.onkeydown = event => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); if (!event.repeat) handlers.submit();
    };
    this.composer.title = "Enter to send · Shift+Enter for a new line";
    const tools = el("div", "coco-compose-tools"); tools.append(this.sendControl.root);
    compose.append(this.composer, tools, this.notice); this.notice.setAttribute("role", "alert");
    const footer = el("div", "coco-chat-footer"); footer.append(this.promptQueue.root, compose);
    this.card.setAttribute("aria-label", "CoCo chat"); this.activity.setAttribute("role", "status"); this.activity.setAttribute("aria-live", "polite"); this.card.append(collapse, this.reference, this.messages, this.prompts, this.activity, footer);
    this.topFade.setAttribute("aria-hidden", "true");
    this.scrollBottom.type = "button"; this.scrollBottom.hidden = true; this.scrollBottom.setAttribute("aria-label", "Scroll to bottom"); this.scrollBottom.title = "Scroll to bottom";
    this.scrollBottom.append(createLucideIcon(ArrowDown, { size: 14 }));
    this.scrollBottom.onclick = () => this.main.scrollTo({ top: this.main.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    this.scrollBottom.addEventListener("transitionend", event => { if (event.propertyName === "opacity" && !this.scrollBottomWanted) this.scrollBottom.hidden = true; });
    this.main.addEventListener("scroll", () => this.scheduleScrollChrome(), { passive: true });
    this.main.addEventListener("toggle", () => this.scheduleScrollChrome(), true);
    this.overviewCards.addEventListener("transitionend", () => this.scheduleScrollChrome());
    this.scrollObserver = new ResizeObserver(() => this.scheduleScrollChrome()); this.scrollObserver.observe(this.main);
    this.mainPane.append(this.main);
    this.root.append(this.nav, this.mainPane, this.card, this.topFade, this.scrollBottom);
    this.chatResize = new CocoChatResizeController(this.root, this.card); this.chatResize.mount();
    this.frame.replaceChildren(el("p", "coco-muted", "Loading CoCo…"));
  }
  destroy(): void { this.scrollObserver?.disconnect(); cancelAnimationFrame(this.scrollFrame); this.promptQueue.destroy(); this.backgroundTasks.destroy(); this.workResults.destroy(); this.chatResize?.destroy(); this.closeActivation?.(); this.animation?.cancel(); if (this.motionTimer) clearTimeout(this.motionTimer); this.flight?.remove(); }

  get composerValue(): string { return this.composer.value; }
  set composerValue(text: string) { this.composer.value = text; }
  get isChatOpen(): boolean { return this.open; }
  setNotice(text: string): void { this.notice.textContent = text; }
  setActivationNotice(text: string): void { this.activationNotice.textContent = text; }
  setContextUsage(usage: ContextUsage): void { this.sendControl.setContextUsage(usage); }
  setPromptQueue(items: PromptQueueItem[], handlers: PromptQueueHandlers): void { this.promptQueue.setHandlers(handlers); this.promptQueue.setItems(items); }
  showLoadError(message: string): void { this.frame.replaceChildren(el("p", "coco-error", message), button("Retry", () => this.handlers.retry())); }
  setSendState(state: CocoSendState): void {
    const btn = this.sendControl.button;
    this.sendControl.setRunning(state.running); this.sendControl.setStop(state.stop);
    this.promptQueue.setSessionIdle(!state.running);
    btn.replaceChildren(state.stop ? this.stopIcon : this.sendIcon);
    btn.setAttribute("aria-label", state.label);
    btn.disabled = state.disabled;
    btn.title = state.title;
  }
  /** Mounts the native transcript (or falls back to the snapshot message list when `node` is undefined). */
  setTranscript(node: HTMLElement | undefined, tasksHost?: HTMLElement): void {
    this.native = !!node;
    if (node) { this.messages.classList.add("is-native"); this.messages.replaceChildren(node); tasksHost?.append(this.backgroundTasks.root); this.prompts.replaceChildren(); this.promptKey = ""; }
    else { this.messages.classList.remove("is-native"); this.lastMessages = ""; }
  }
  showDisabled(): void {
    this.chatResize?.cancelDrag();
    this.backgroundTasks.update([]);
    this.animation?.cancel(); this.flight?.remove(); this.flight = undefined;
    if (!this.disabledView) this.disabledView = this.createDisabledView();
    if (this.frame.firstElementChild !== this.disabledView) this.frame.replaceChildren(this.disabledView);
  }
  showEnabled(): void { if (this.frame.firstElementChild !== this.root) { this.frame.replaceChildren(this.root); this.scheduleScrollChrome(); } }
  openActivation(): void {
    if (this.closeActivation) return;
    this.closeActivation = showCocoActivationDialog({
      owner: this.frame,
      onEnable: () => this.handlers.enable(),
      onReviewSettings: this.handlers.openSettings,
      onClose: () => {
        this.closeActivation = undefined;
        if (this.frame.firstElementChild === this.disabledView) this.disabledView?.querySelector<HTMLButtonElement>("[data-coco-enable]")?.focus();
      },
    });
  }
  private createDisabledView(): HTMLElement {
    const screen = el("section", "coco-disabled-screen");
    const welcome = el("div", "coco-disabled-welcome");
    welcome.append(createCocoIcon(64, "global"), el("h2", "", "CoCo is turned off"), el("p", "coco-muted", "Enable CoCo to share goals, move work forward, and follow up using your enabled rules."));
    const actions = el("div"), enable = button("Enable CoCo", () => this.openActivation(), true); enable.dataset.cocoEnable = "true";
    actions.append(enable); welcome.append(actions);
    if (this.handlers.openSettings) { const review = button("Review settings", this.handlers.openSettings); review.classList.add("coco-activation-link"); welcome.append(review); }
    this.activationNotice.setAttribute("role", "alert"); welcome.append(this.activationNotice); screen.append(welcome); return screen;
  }

  renderChat(snapshot: CocoSnapshot, chat: { activity: string; reference: CocoWork | undefined }): void {
    this.snapshot = snapshot;
    this.renderPrompts();
    this.activity.textContent = chat.activity;
    const recent = snapshot.messages.filter(m => m.at >= Date.now() - 3600000);
    // Key on messages only — work-status churn must not remount the transcript.
    const key = JSON.stringify(recent.map(m => [m.id, m.role, m.status, m.text, m.goalId]));
    if (!this.native && key !== this.lastMessages) {
      const atBottom = this.messages.scrollTop + this.messages.clientHeight >= this.messages.scrollHeight - 60;
      this.lastMessages = key; this.messages.replaceChildren();
      const ids = new Set(recent.map(m => m.id));
      for (const id of this.messageBodies.keys()) if (!ids.has(id)) this.messageBodies.delete(id);
      if (!recent.length) { this.messages.append(el("h3", "", "What should we work on?"), el("p", "coco-muted", "Share a goal. CoCo will create an actionable plan, move work forward, and verify the results.")); }
      for (const [index, message] of recent.entries()) {
        if (!message.text && message.role === "assistant") continue;
        const node = el("div", `coco-message ${message.role} conversation-msg conversation-msg-${message.role}${message.status === "error" ? " is-error" : ""}`);
        let body = this.messageBodies.get(message.id);
        if (!body) { body = el("div", "coco-prose conversation-msg-body"); this.messageBodies.set(message.id, body); }
        if (message.role === "assistant") renderMarkdownText(message.text, body, { streaming: message.status === "streaming" });
        else body.textContent = message.text;
        node.append(body);
        const lastForGoal = !recent.slice(index + 1).some(m => m.goalId && m.goalId === message.goalId);
        const related = snapshot.work.filter(w => lastForGoal && message.goalId && (w.goalId === message.goalId || w.goalIds?.includes(message.goalId)));
        if (related.length) {
          const plan = el("div", "coco-chat-plan");
          related.forEach(work => plan.append(button(`${statusLabel(work.status)} · ${work.title}`, () => this.showWork(work))));
          if (related.some(w => w.status === "draft")) plan.append(button("Start plan", () => this.handlers.act({ type: "goal", id: message.goalId!, action: "start" }), true));
          body.append(plan);
        }
        this.messages.append(node); }
      if (atBottom) this.messages.scrollTop = this.messages.scrollHeight;
    }
    const taskScrollport = this.backgroundTasks.root.parentElement;
    const following = !!taskScrollport && taskScrollport.scrollTop + taskScrollport.clientHeight >= taskScrollport.scrollHeight - 60;
    const tasksChanged = this.backgroundTasks.update(snapshot.backgroundTasks ?? []);
    if (!this.native && this.backgroundTasks.root.parentElement !== this.messages) this.messages.append(this.backgroundTasks.root);
    // Only pin to bottom when a check card appears/disappears — never on progress text ticks.
    if (following && tasksChanged) taskScrollport.scrollTop = taskScrollport.scrollHeight;
    const work = chat.reference;
    const project = work && snapshot.workspaces.find(workspace => workspace.id === work.workspaceId)?.name;
    const referenceKey = work ? JSON.stringify([work.id, work.title, work.status, project]) : "";
    if (referenceKey === this.lastReference) return;
    this.lastReference = referenceKey;
    this.reference.replaceChildren();
    if (work) {
      const heading = el("div", "coco-reference-heading"), remove = button("", () => this.handlers.removeReference(work.id));
      remove.append(createLucideIcon(X, { size: 14 })); remove.setAttribute("aria-label", "Remove task context"); remove.title = "Remove task context";
      heading.append(el("span", "", "Discussing"), remove);
      this.reference.append(heading, el("strong", "", work.title), el("small", "", [project, statusLabel(work.status)].filter(Boolean).join(" · ")));
    }
  }
  private renderPrompts(): void {
    const chat = this.snapshot?.chat, key = JSON.stringify([chat?.question, chat?.approval]);
    if (key === this.promptKey) return;
    this.promptKey = key; this.prompts.replaceChildren();
    const act = this.handlers.act;
    if (chat?.question) {
      const question = chat.question, card = el("div", "coco-chat-prompt");
      card.append(el("strong", "", question.question));
      if (question.onBehalfOf) card.append(el("small", "coco-muted", `On behalf of “${question.onBehalfOf}”`));
      if (question.allowMultiple) {
        const selected = new Set<string>();
        const submit = button("Continue", () => act({type:"chatControl",action:"answer",requestId:question.requestId,selected:[...selected].join(", "),selections:[...selected],custom:false}), true); submit.disabled = true;
        for (const option of question.options) { const label = el("label"), box = el("input"); box.type = "checkbox"; box.onchange = () => { if(box.checked)selected.add(option);else selected.delete(option);submit.disabled=!selected.size; }; label.append(box, document.createTextNode(option)); card.append(label); }
        card.append(submit);
      } else for (const option of question.options) card.append(button(option, () => act({type:"chatControl",action:"answer",requestId:question.requestId,selected:option,custom:false})));
      if(question.allowCustom || !question.options.length) card.append(el("small","coco-muted","You can also reply in the message box below."));
      this.prompts.append(card);
    }
    if (chat?.approval) {
      const approval = chat.approval, card = el("div", "coco-chat-prompt");
      card.append(el("strong", "", `Confirm ${approval.toolName}`));
      if (approval.onBehalfOf) card.append(el("small", "coco-muted", `On behalf of “${approval.onBehalfOf}”`));
      card.append(el("p", "coco-muted", approval.risk?.reason ?? "Review this exact tool invocation before continuing."), el("pre", "coco-prose", JSON.stringify(approval.arguments,null,2)), button("Approve once", () => act({type:"chatControl",action:"approval",requestId:approval.requestId,approved:true}),true), button("Decline", () => act({type:"chatControl",action:"approval",requestId:approval.requestId,approved:false})));
      this.prompts.append(card);
    }
  }

  private goTo(page: Page): void { this.selected = undefined; this.page = page; this.editorOpen = false; this.renderMain(undefined, true); this.main.scrollTop = 0; this.syncScrollChrome(); if (page === "reports") this.handlers.reportsViewed(); }
  private showWork(work: CocoWork): void {
    this.selected = work.id; this.editorOpen = false;
    this.renderMain(undefined, true); this.main.scrollTop = 0;
    this.handlers.workFocused(work.id);
  }
  private focusComposer(): void { if (!this.open) this.toggleChat(); this.composer.focus(); }
  private row(work: CocoWork): HTMLElement {
    const row = el("button", "coco-work-row"); row.type = "button"; row.onclick = () => this.showWork(work);
    const copy = el("div"); copy.append(el("strong", "", work.title), el("small", "coco-muted", this.snapshot?.workspaces.find(w => w.id === work.workspaceId)?.name ?? "Unavailable project"));
    const badge = el("span", `coco-status ${work.status}`, statusLabel(work.status)); row.append(copy, badge); return row;
  }
  private scheduledRow(run: CocoScheduledRun): HTMLElement {
    const row = el("button", "coco-work-row is-scheduled"); row.type = "button"; row.onclick = () => this.goTo("rules");
    const copy = el("div"), more = run.runsInWindow > 1 ? ` · ${run.runsInWindow} runs in next 12h` : "";
    copy.append(el("strong", "", run.name), el("small", "coco-muted", `${run.mode === "fixed" ? "Scheduled task" : "Inspection"} · ${describeCadence(run.cadence)}${more}`));
    const when = new Date(run.at), clock = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const time = run.due ? "Due now" : when.toDateString() === new Date().toDateString() ? clock : `Tomorrow ${clock}`;
    row.append(copy, el("span", "coco-status scheduled", time)); return row;
  }
  /** Lead with current progress, or with upcoming work when nothing is running. */
  private flowSection(s: CocoSnapshot, scheduled: CocoScheduledRun[]): HTMLElement | undefined {
    const active = s.work.filter(w => isActiveWork(w.status)), next = s.work.filter(w => ["draft", "queued", "waiting"].includes(w.status));
    const upcoming = next.length + scheduled.length;
    if (!active.length && !upcoming) return undefined;
    const section = el("section", `coco-section coco-flow${active.length ? " has-active" : ""}`), head = el("div", "coco-flow-head");
    const count = (n: number): string => `${n} item${n === 1 ? "" : "s"}`;
    head.append(el("h3", "", active.length ? "Moving forward" : "Up next"), el("small", "", active.length ? `${active.length} in progress` : count(upcoming)));
    section.append(head);
    if (active.length) {
      const group = el("div", "coco-flow-group"), list = el("div", "coco-flow-list");
      list.append(...active.map(w => this.row(w))); group.append(list); section.append(group);
    }
    if (upcoming) {
      const group = el("div", "coco-flow-group"), list = el("div", "coco-flow-list");
      if (active.length) {
        const nextHead = el("div", "coco-flow-group-head");
        nextHead.append(el("h4", "", "Up next"), el("small", "", count(upcoming))); group.append(nextHead);
      }
      list.append(...next.map(w => this.row(w)), ...scheduled.map(run => this.scheduledRow(run)));
      group.append(list); section.append(group);
    }
    return section;
  }
  /** Mount cards in fixed order inside persistent shells; empty cards collapse and fade out instead of disappearing. */
  private renderOverviewCards(cards: Record<OverviewCardId, () => HTMLElement | undefined>, animate: boolean): void {
    if (this.overviewCards.parentElement !== this.main) this.main.append(this.overviewCards);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) animate = false;
    let previous: HTMLElement | null = null;
    for (const id of OVERVIEW_ORDER) {
      const card = cards[id](); let shell = this.cardShells.get(id);
      if (!card && (!shell || !animate)) { shell?.remove(); this.cardShells.delete(id); continue; }
      if (!shell) {
        shell = el("div", "coco-card-shell is-hidden"); this.cardShells.set(id, shell);
        const leaving = shell;
        shell.addEventListener("transitionend", event => {
          if (event.target === leaving && event.propertyName === "grid-template-rows" && leaving.classList.contains("is-hidden")) { leaving.remove(); if (this.cardShells.get(id) === leaving) this.cardShells.delete(id); }
        });
      }
      // Moving an attached node resets its transition, so only insert when it is out of place.
      const expected: ChildNode | null = previous ? previous.nextSibling : this.overviewCards.firstChild;
      if (shell !== expected) this.overviewCards.insertBefore(shell, expected);
      previous = shell;
      if (card) {
        if (shell.firstElementChild !== card) shell.replaceChildren(card);
        if (shell.classList.contains("is-hidden")) {
          if (animate) void shell.offsetHeight;
          shell.classList.remove("is-hidden"); shell.inert = false; shell.removeAttribute("aria-hidden");
        }
      } else if (!shell.classList.contains("is-hidden")) {
        shell.classList.add("is-hidden"); shell.inert = true; shell.setAttribute("aria-hidden", "true");
      }
    }
  }
  private listSection(title: string, work: CocoWork[], empty = "Nothing here yet", extra: HTMLElement[] = []): HTMLElement {
    const section = el("section", "coco-section"); section.append(el("h3", "", title)); if (!work.length && !extra.length) section.append(el("p", "coco-muted", empty)); work.forEach(w => section.append(this.row(w))); section.append(...extra); return section;
  }
  private list(title: string, work: CocoWork[], empty?: string, extra?: HTMLElement[]): void { this.main.append(this.listSection(title, work, empty, extra)); }
  renderMain(data?: CocoMainData, force = false): void {
    this.scheduleScrollChrome();
    if (data) { this.snapshot = data.snapshot; this.historyPages = data.historyPages; this.scheduled = data.scheduled; this.reportNew = data.reportNew; }
    const s = this.snapshot, historyPages = this.historyPages, scheduled = this.scheduled; if (!s || this.editorOpen) return;
    const act = this.handlers.act;
    this.budgetView?.update(s.budget, s.settings);
    const runtimeLabel = cocoRuntimeLabel(s);
    const key = this.selected ? JSON.stringify([this.selected, s.work.find(w => w.id === this.selected), s.verifications.filter(v => v.workId === this.selected), s.attempts.filter(a => a.workId === this.selected), s.settings.timezone]) : JSON.stringify([this.page, this.selected, s.work, s.pendingPlans, s.rules, s.reports, s.verifications, s.attempts, s.ruleRuns, s.reportJob, s.runningRuleIds, s.state, s.error, s.resumeAt, scheduled, this.reportNew, runtimeLabel]);
    if (!force && key === this.lastMain) return; this.lastMain = key;
    if (this.mainHeading) this.scrollObserver?.unobserve(this.mainHeading);
    this.mainHeading = undefined;
    this.nav.querySelectorAll<HTMLElement>("[data-page]").forEach(n => { n.classList.toggle("active", n.dataset.page === this.page && !this.selected); n.setAttribute("aria-current", n.dataset.page === this.page && !this.selected ? "page" : "false"); });
    // Keep the overview card list attached so card shells can animate in/out across renders.
    const keepCards = this.page === "overview" && !this.selected && this.overviewCards.parentElement === this.main;
    if (keepCards) { for (const n of [...this.main.children]) if (n !== this.overviewCards) n.remove(); }
    else { this.main.replaceChildren(); this.overviewCards.replaceChildren(); this.cardShells.clear(); }
    this.budgetView = undefined;
    if (this.selected) { const work = s.work.find(w => w.id === this.selected); if (work) { this.detail(work); return; } this.selected = undefined; }
    const titles: Record<Page,string> = { overview: "Overview", work: "In progress", attention: "To decide", rules: "Automation rules", reports: "Work reports" };
    const header = el("header", "coco-main-head"); header.append(el("h1", "", titles[this.page])); this.main.prepend(header);
    this.mainHeading = header; this.scrollObserver?.observe(header);
    if (this.page === "overview") {
      const banner = el("div", `coco-runtime ${s.state}`);
      const runtimeHead = el("div", "coco-runtime-heading");
      runtimeHead.append(createCocoIcon(32, "work"), el("strong", "", runtimeLabel));
      banner.append(runtimeHead);
      banner.append(el("p", "coco-muted", s.error ?? (s.resumeAt ? `Budget resets ${new Date(s.resumeAt).toLocaleString()}` : "One collaborator. A clear plan. Verified outcomes.")));
      this.budgetView = new CocoBudgetView(s.budget, s.settings, () => act({ type: "budget", action: "reset" })); banner.append(this.budgetView.root);
      const goal = button("Give CoCo a goal", () => this.focusComposer(), true); goal.prepend(createLucideIcon(Target)); this.budgetView.actions.append(goal); header.after(banner);
      const cards: Record<OverviewCardId, () => HTMLElement | undefined> = {
        decide: () => { const work = s.work.filter(w => w.status === "to_decide"); return work.length ? this.listSection("To decide", work) : undefined; },
        planning: () => {
          if(!s.pendingPlans?.length) return undefined;
          const planning=el("section","coco-section");planning.append(el("h3","","Planning"));
          for(const request of s.pendingPlans){const row=el("div","coco-planning-row");row.append(el("span","",request.title),el("small","coco-muted",request.status==="running"?"Planning in the background":"Waiting for planning"),button("Cancel",()=>act({type:"goal",id:request.requestId,action:"cancel"})));planning.append(row);}
          return planning;
        },
        flow: () => this.flowSection(s, scheduled),
        report: () => {
          const recent = s.reports[0]; if (!recent) return undefined;
          const timezone = s.settings.timezone;
          const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric" }).formatToParts(recent.at);
          const report = button("", () => this.goTo("reports")); report.className = "coco-section coco-latest-report";
          const fullDate = new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "long" }).format(recent.at);
          report.setAttribute("aria-label", `Read daily work report for ${fullDate}${this.reportNew ? ", unread" : ""}`);
          const date = el("time", "coco-latest-report-date"); date.dateTime = new Date(recent.at).toISOString(); date.setAttribute("aria-label", fullDate);
          date.append(el("span", "coco-latest-report-month", parts.find(part => part.type === "month")!.value.toUpperCase()), el("span", "coco-latest-report-day", parts.find(part => part.type === "day")!.value));
          const copy = el("span", "coco-latest-report-copy"), kicker = el("span", "coco-latest-report-kicker", "Latest report");
          if (this.reportNew) { const corner = el("span", "coco-latest-report-corner"); corner.setAttribute("aria-hidden", "true"); report.append(corner); }
          copy.append(kicker, el("span", "coco-latest-report-title", "Daily work report"));
          const arrow = createLucideIcon(ArrowRight, { size: 16 }); arrow.classList.add("coco-latest-report-arrow"); arrow.setAttribute("aria-hidden", "true");
          report.append(date, copy, arrow); return report;
        },
        runs: () => s.rules.length || s.ruleRuns?.length ? this.recentRuns.render(s) : undefined,
      };
      this.renderOverviewCards(cards, keepCards);
    } else if (this.page === "work") { this.list("Active & queued", s.work.filter(w => !isTerminalWork(w.status) && w.status !== "to_decide")); this.list("Completed", s.work.filter(w => w.status === "completed")); }
    else if (this.page === "attention") this.list("Waiting for your decision", s.work.filter(w => w.status === "to_decide"));
    else if (this.page === "rules") {
      const ruleActions = el("div", "coco-actions coco-rules-actions");
      this.main.append(ruleActions);
      ruleActions.append(button("Create rule", () => this.editRule()), button("Use inspection template", () => this.editRule(undefined, { id: crypto.randomUUID(), name: "Work progress inspection", objective: "Inspect recent project and task progress. Identify actionable failures and unfinished work, avoid duplicating existing work, and advance it within the selected projects.", mode: "inspection", scope: { all: false, workspaceIds: s.workspaces.slice(0,1).map(w => w.id), excludedWorkspaceIds: [] }, confirmed: false, enabled: true, fullPermissions: true, providerId: "", cadence: { kind: "minute", n: 15 }, acceptance: [], nextRunAt: 0, createdAt: Date.now() })));
      if (!s.rules.length) this.main.append(el("p", "coco-muted", "CoCo can create rules to follow your goals. You can also add one here."));
      const projectName = (id: string): string => (s.workspaceOptions ?? s.workspaces).find(p => p.id === id)?.name ?? "Unavailable project";
      for (const rule of s.rules) { const card = el("section", "coco-section"); card.append(el("h3", "", rule.name), el("p", "", rule.objective), el("small", "coco-muted", `${rule.mode === "fixed" ? describeCadence(rule.cadence) : `Inspect · ${describeCadence(rule.cadence)}`} · ${!rule.confirmed ? "Draft" : rule.enabled ? "Enabled" : "Paused"}`)); const actions = el("div", "coco-actions");
        // Delete follows the standard Larry Agent action-button paint (action-danger) on the CoCo geometry class; the other rule actions keep the CoCo look.
        const remove = button("Delete", () => this.handlers.deleteRule(rule)); remove.classList.add("action-danger");
        // A queued or running inspection (manual or scheduled) locks Run now until it finishes.
        const ruleRunning = s.runningRuleIds?.includes(rule.id) ?? false;
        const runNow = button(ruleRunning ? "Running…" : "Run now", () => act({ type: "rule", action: "run", id: rule.id }));
        runNow.disabled = ruleRunning; runNow.title = ruleRunning ? "This rule is running now" : "";
        actions.append(button("Edit", () => this.editRule(rule.id)), button(rule.confirmed ? rule.enabled ? "Pause" : "Enable" : "Enable", () => act({ type: "rule", action: rule.confirmed ? "toggle" : "confirm", id: rule.id })), runNow, remove); const projects = rule.scope.all ? "All current and future projects" : rule.scope.workspaceIds.map(projectName).join(", ");
        card.append(el("p", "coco-muted", `Scope: ${projects}. Access: Larry Agent Full permissions. Global exclusions and existing tool approvals apply.`));
        if (rule.scope.excludedWorkspaceIds.length) card.append(el("p", "coco-muted", `Rule exclusions: ${rule.scope.excludedWorkspaceIds.map(projectName).join(", ")}`));
        if (rule.origin === "coco") card.append(el("small", "coco-muted", "Created by CoCo to follow a goal"));
        card.append(actions);
        const historyPage = historyPages.get(rule.id) ?? { runs: s.legacyRuns.filter(run => run.ruleId === rule.id), nextCursor: s.legacyCursors?.[rule.id] };
        const history = historyPage.runs;
        if (history.length) {
          const records = el("details", "coco-rule-history"); records.open = this.expandedHistory.has(rule.id); records.ontoggle = () => { if (records.open) this.expandedHistory.add(rule.id); else this.expandedHistory.delete(rule.id); }; records.append(el("summary", "", "Historical Loops runs"));
          for (const run of history) { const row = el("p", "coco-muted coco-history-row", `${new Date(run.startedAt).toLocaleString()} · ${run.status} (historical, not CoCo verification)`); if (run.sessionId) row.append(button("Open task", () => this.handlers.sessionSelect(run.sessionId!))); records.append(row); }
          const cursor = historyPage.nextCursor;
          if (cursor) records.append(button("Load older runs", () => { this.expandedHistory.add(rule.id); this.handlers.loadHistory(rule.id, cursor); }));
          card.append(records);
        }
        this.main.append(card); }
    } else {
      // Presence in the snapshot = queued or running; the click flips it via the returned snapshot.
      const generating = s.reportJob !== undefined;
      const generate = button(generating ? "Generating report…" : "Generate report", () => act({ type: "report" }));
      generate.disabled = generating; generate.title = generating ? "The daily report is being generated" : "";
      this.main.append(generate);
      const workById = new Map(s.work.map(work => [work.id, work]));
      for (const report of s.reports) {
        const card = el("section", "coco-section coco-report");
        const heading = el("header", "coco-report-heading"), copy = el("div", "coco-report-heading-copy");
        const date = el("time", "coco-muted", new Date(report.at).toLocaleString()); date.dateTime = new Date(report.at).toISOString();
        copy.append(el("h3", "", report.title), date);
        const download = button("Export Markdown", () => { const url = URL.createObjectURL(new Blob([report.markdown], { type: "text/markdown" })); const link = el("a"); link.href = url; link.download = `coco-report-${report.at}.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
        download.classList.add("coco-report-export"); download.prepend(createLucideIcon(Download, { size: 14 }));
        heading.append(copy, download);
        const body = el("div", "coco-prose coco-report-body");
        renderMarkdownText(report.markdown, body);
        card.append(heading, body);
        const works = [...new Set(report.workIds)].flatMap(id => { const work = workById.get(id); return work ? [work] : []; });
        if (works.length) {
          const related = el("details", "coco-report-related"); related.open = this.expandedReports.has(report.id);
          related.ontoggle = () => {
            // Ignore queued events from rows replaced by a newer snapshot.
            if (!this.main.contains(related)) return;
            if (related.open) this.expandedReports.add(report.id); else this.expandedReports.delete(report.id);
          };
          const summary = el("summary"), chevron = createLucideIcon(ChevronRight, { size: 13 }); chevron.classList.add("coco-report-chevron");
          summary.append(chevron, el("span", "", "Related work"), el("span", "coco-report-count", String(works.length)));
          const list = el("ul", "coco-report-work-list");
          for (const work of works) {
            const item = el("li"), row = button("", () => this.showWork(work)); row.className = "coco-report-work-row";
            row.append(el("span", "coco-report-work-title", work.title), el("span", `coco-report-work-status ${work.status}`, statusLabel(work.status)), createLucideIcon(ArrowUpRight, { size: 13 }));
            item.append(row); list.append(item);
          }
          related.append(summary, list); card.append(related);
        }
        this.main.append(card);
      }
      if (!s.reports.length) this.main.append(el("p", "coco-muted", "Your consolidated daily reports will appear here."));
    }
  }
  private scheduleScrollChrome(): void {
    if (this.scrollFrame) return;
    this.scrollFrame = requestAnimationFrame(() => { this.scrollFrame = 0; this.syncScrollChrome(); });
  }
  /** Same thresholds as the conversation transcript: fade once content leaves the top; jump button with a 64px/32px buffer. */
  private syncScrollChrome(): void {
    const main = this.main, remaining = main.scrollHeight - main.scrollTop - main.clientHeight;
    const anchor = this.mainHeading?.nextElementSibling;
    if (anchor && this.root.clientHeight > 0) {
      // Align to the first panel's resting position, independent of work-page scrolling.
      const top = Math.max(0, anchor.getBoundingClientRect().top + main.scrollTop - this.root.getBoundingClientRect().top);
      const inset = `${Math.round(top * 100) / 100}px`;
      if (this.root.style.getPropertyValue("--coco-chat-top") !== inset) this.root.style.setProperty("--coco-chat-top", inset);
    }
    this.topFade.classList.toggle("is-on", main.scrollTop > 1);
    const show = this.scrollBottomWanted ? remaining > 32 : remaining > 64;
    if (show === this.scrollBottomWanted) return;
    this.scrollBottomWanted = show;
    if (show) { this.scrollBottom.hidden = false; void this.scrollBottom.offsetWidth; this.scrollBottom.classList.add("is-visible"); }
    else { this.scrollBottom.classList.remove("is-visible"); if (matchMedia("(prefers-reduced-motion: reduce)").matches) this.scrollBottom.hidden = true; }
  }
  private editRule(id?: string, template?: CocoRule): void {
    if (!this.snapshot) return; this.editorOpen = true;
    const close = (): void => { this.editorOpen = false; this.renderMain(undefined, true); };
    this.scheduleScrollChrome();
    this.main.replaceChildren(ruleEditor(this.snapshot, template ?? this.snapshot.rules.find(r => r.id === id), async rule => { await this.handlers.command({ type: "rule", action: "save", rule }); close(); }, close));
    this.main.scrollTop = 0;
  }
  private detail(work: CocoWork): void {
    const act = this.handlers.act;
    const heading = el("header", "coco-work-detail-head"); heading.append(el("h1", "", work.title), el("span", `coco-status ${work.status}`, statusLabel(work.status)));
    const timezone = this.snapshot!.settings.timezone;
    const at = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const project = this.snapshot!.workspaces.find(project => project.id === work.workspaceId)?.name ?? "Unavailable project";
    this.main.append(heading, el("p", "coco-muted coco-work-detail-meta", `${project} · ${at.format(work.createdAt)} · ${timezone}`), el("p", "coco-prose coco-work-detail-objective", work.objective));
    if (work.summary) this.main.append(el("p", "coco-muted coco-work-detail-summary", work.summary));
    const approval = this.snapshot?.toolApprovals?.find(a => a.workId === work.id && a.revision === work.revision && a.status === "pending");
    const actions = el("div", "coco-actions coco-work-detail-actions");
    if (!approval && ["draft", "waiting", "to_decide"].includes(work.status)) actions.append(button(work.status === "draft" ? "Start work" : "Resume", () => act({ type: "work", id: work.id, action: "resume" }), true));
    if (work.status === "queued" || isActiveWork(work.status)) actions.append(button("Pause", () => act({ type: "work", id: work.id, action: "pause" })));
    if (!isTerminalWork(work.status)) { actions.append(button("Prioritize", () => act({ type: "work", id: work.id, action: "priority", priority: 100 })), button("Cancel work", () => act({ type: "work", id: work.id, action: "cancel" }))); }
    const sessionId = work.sessionId ?? work.observeSessionId;
    if (sessionId) actions.append(button("Open execution task", () => this.handlers.sessionSelect(sessionId)));
    this.main.append(actions);
    if (work.status === "to_decide" && approval) {
      const card = el("section", "coco-detail-section"), actions = el("div", "coco-actions coco-decision-actions");
      const name = this.snapshot?.mcpOptions?.find(t => t.toolName === approval.toolName);
      actions.append(button("Approve once & continue", () => act({ type: "toolApproval", id: approval.id, action: "approve" }), true), button("Decline invocation", () => act({ type: "toolApproval", id: approval.id, action: "deny" })));
      card.append(el("h3", "", "Approve tool invocation"), el("p", "coco-prose", name ? `${name.serverName} · ${name.name}` : approval.toolName), el("p", "coco-prose", approval.reason), el("pre", "coco-prose", JSON.stringify(approval.arguments, null, 2)), actions); this.main.append(card);
    } else if (work.status === "to_decide" && work.decision) {
      const prompt = decisionPromptFor(work.decision, work.decisionPrompt);
      const card = el("section", "coco-detail-section");
      card.append(el("h3", "", "Your decision"), el("p", "coco-prose", prompt.question));
      const choose = (answer: string): void => {
        const text = answer.trim();
        if (/^cancel this work$/i.test(text)) { act({ type: "work", id: work.id, action: "cancel" }); return; }
        if (/^pause this work$/i.test(text)) { act({ type: "work", id: work.id, action: "pause" }); return; }
        act({ type: "work", id: work.id, action: "resume", answer: text });
      };
      const choices = el("div", "coco-actions coco-decision-actions");
      if (prompt.allowMultiple) {
        const selected = new Set<string>();
        const submit = button("Save decision & continue", () => choose([...selected].join(", ")), true); submit.disabled = true;
        for (const option of prompt.options) {
          const label = el("label", "coco-decision-option"), box = el("input");
          box.type = "checkbox";
          box.onchange = () => { if (box.checked) selected.add(option); else selected.delete(option); submit.disabled = !selected.size; };
          label.append(box, document.createTextNode(option));
          choices.append(label);
        }
        choices.append(submit);
      } else {
        for (const option of prompt.options) choices.append(button(option, () => choose(option), option === prompt.options[0]));
      }
      card.append(choices);
      if (prompt.allowCustom !== false) {
        const custom = el("div", "coco-decision-custom");
        const answer = el("textarea"); answer.rows = 3; answer.value = this.decisionDrafts.get(work.id) ?? ""; answer.placeholder = "Or type a custom decision…";
        answer.oninput = () => { this.decisionDrafts.set(work.id, answer.value); };
        answer.setAttribute("aria-label", "Custom decision");
        const customActions = el("div", "coco-actions coco-decision-actions");
        customActions.append(button("Save custom decision & continue", () => choose(answer.value), !prompt.options.length));
        custom.append(el("small", "coco-muted", "Or write your own decision"), answer, customActions);
        card.append(custom);
      }
      this.main.append(card);
    }
    this.workResults.render(work, this.snapshot!); this.main.append(this.workResults.root);
  }
  private toggleChat(): void {
    this.chatResize?.cancelDrag();
    this.animation?.cancel(); if (this.motionTimer) clearTimeout(this.motionTimer); this.motionTimer = undefined; this.flight?.remove(); this.flight = undefined;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const opening = !this.open, source = this.card.getBoundingClientRect(), target = this.chatButton.getBoundingClientRect();
    this.open = opening; this.handlers.chatToggled(opening); this.root.classList.toggle("is-chat-open", opening); this.card.inert = !opening; this.chatButton.setAttribute("aria-expanded", String(opening));
    if (reduced) { this.card.style.visibility = ""; if (!opening) this.chatButton.focus(); return; }
    const destination = opening ? this.card.getBoundingClientRect() : source;
    const clone = this.card.cloneNode(true) as HTMLElement; clone.classList.add("coco-chat-flight"); clone.inert = true; clone.setAttribute("aria-hidden", "true");
    Object.assign(clone.style, { left: `${destination.left}px`, top: `${destination.top}px`, width: `${destination.width}px`, height: `${destination.height}px` });
    document.body.append(clone); this.flight = clone; this.card.style.visibility = "hidden";
    const transform = `translate(${target.left + target.width/2 - destination.left - destination.width/2}px, ${target.top + target.height/2 - destination.top - destination.height/2}px) scale(${Math.max(.03,target.width/destination.width)}, ${Math.max(.03,target.height/destination.height)})`;
    const full = { transform: "translate(0,0) scale(1)", opacity: 1, borderRadius: "10px" }, small = { transform, opacity: .12, borderRadius: "30px" };
    this.animation = clone.animate(opening ? [small, full] : [full, small], { duration: 520, easing: "cubic-bezier(.22,1,.36,1)", fill: "both" });
    const cleanup = (): void => { clone.remove(); if (this.flight === clone) { if (this.animation) { this.animation.onfinish = null; this.animation.oncancel = null; this.animation.cancel(); } this.card.style.visibility = ""; this.flight = undefined; this.animation = undefined; if (this.motionTimer) clearTimeout(this.motionTimer); this.motionTimer = undefined; } };
    const finish = (): void => { cleanup(); if (!opening) { this.chatButton.focus(); this.chatButton.animate([{ background: "var(--bg-elevated)" }, { background: "var(--hover)" }, { background: "var(--bg-elevated)" }], { duration: 360 }); } };
    this.animation.onfinish = finish;
    this.animation.oncancel = cleanup;
    // Hidden windows can suspend animation frames; never leave the real card inert behind a clone.
    this.motionTimer = setTimeout(finish, 750);
  }
}
