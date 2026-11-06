import { recentMessages } from "./recentHistory.js";
import { ArrowDown, ChevronDown, GitCommitHorizontal } from "lucide";
import { buildMessageRenderContext } from "./buildMessageRenderContext.js";
import { renderMarkdownText } from "./renderMarkdownText.js";
import {
  isConversationCardVisible,
  projectAssistantMessage,
  projectTurnMessages,
  pushToolHint,
  type ReasoningToolRecord,
} from "./turnDisplay.js";
import { SHELL_TOOL_NAME } from "../../state/shellToolName.js";
import { prepareStreamingMarkdown } from "../../markdown/prepareStreamingMarkdown.js";
import { TaskComposerView } from "../../ui/taskComposer/TaskComposerView.js";
import { ConversationGitBarView } from "./ConversationGitBarView.js";
import {
  PromptQueueView,
  type PromptQueueHandlers,
  type PromptQueueItem,
} from "./PromptQueueView.js";
import { createApprovalCard } from "./cards/ApprovalCardView.js";
import {
  centerPlanCardActiveStep,
  createPlanCard,
  getPlanCardActiveStepId,
  getPlanCardStepsScrollTop,
  setPlanCardStepsScrollTop,
} from "./cards/PlanCardView.js";
import {
  createPlanReviewBar,
  type PlanReviewBarApi,
} from "./cards/PlanReviewBarView.js";
import { animateFold, settleFold } from "./foldAnimation.js";
import { createTurnModifiedFilesView } from "./cards/TurnModifiedFilesView.js";
import { createTurnEndedViewFromMessages } from "./cards/TurnEndedView.js";
import {
  createTurnErrorCard,
  type RetryOutcome,
  type TurnErrorRetryPayload,
} from "./cards/TurnErrorCardView.js";
import {
  createReasoningBlock,
  estimateReasoningTokensFromText,
  finalizeReasoningBlock,
  markReasoningBlockContent,
  reasoningBlockToolHints,
  reasoningBlockToolRecords,
  resumeReasoningBlockStreaming,
  setReasoningBlockStatusText,
  setReasoningBlockStats,
  setReasoningBlockText,
  setReasoningBlockToolHints,
  upsertReasoningToolRecord,
} from "./cards/ReasoningBlockView.js";
import {
  FLOW_CLASS,
  LATEST_TURN_CLASS,
  STICKY_ITEM_CLASS,
  STICKY_SEGMENT_CLASS,
  STICKY_UNWRAP_SELECTOR,
  TURN_CLASS,
  buildStickySegments,
  extractPlanCardsToSiblings,
  hasUnwrappedPlan,
} from "./conversationSticky.js";
import { createMessageView, createMessageViewAsync } from "./message/MessageView.js";
import {
  applyUserPromptClamp,
  disposeUserPromptClamps,
} from "./message/userPromptClamp.js";
import {
  createAttachmentChip,
  type AttachmentChipInput,
} from "./cards/AttachmentChipView.js";
import { createToolInvocationCard } from "./cards/ToolInvocationCardView.js";
import { updateStreamingWritePreviewCard } from "./cards/streamingWritePreview.js";
import { ToolCardViewport } from "./ToolCardViewport.js";
import {
  VIRTUAL_TOOL_CARD_CLASS,
  getVirtualToolCardOpen,
  setVirtualToolCardOpen,
  transferVirtualToolCardState,
} from "./cards/virtualToolCard.js";
import { patchUploadLiveZone } from "./cards/uploadCardView.js";
import type { UploadLiveState } from "./cards/uploadCard.js";
import { sleepInfoFromArgs } from "./cards/sleepCardView.js";
import { createDisplayImageCard } from "./cards/DisplayImageCardView.js";
import { createToolOutcomeBadge, armLiveOutcomeFade } from "./cards/ToolOutcomeBadge.js";
import type { SubagentStatusKind } from "./cards/toolInvocationTypes.js";
import {
  createSubagentStatusIcon,
  isWriteFileTool,
  subagentStatusVisualKind,
  unwrapToolCallBridge,
} from "./cards/toolInvocationHelpers.js";
import { formatTokenCount } from "../../ui/contextUsage.js";
import {
  collectTurnFiles,
  collectUrlsFromMessages,
  splitMessagesIntoTurns,
} from "./turnModifiedFiles.js";
import { isWireOverlayTranscriptMessage } from "../../../../session/wireOverlay.js";
import { reclaimableUserMessageId } from "../../../../session/userPromptReclaim.js";
import { isAnimatedProgressText } from "./turnProgress.js";
import { playCardEnterAnimation, playCardHeightTransition } from "./enterAnimations.js";
import { createLucideIcon } from "../../ui/originalIcons.js";
import { computePromptAnchor } from "./promptAnchor.js";
import { ConversationAutoScroll } from "../../ui/ConversationAutoScroll.js";
import { ConversationScrollViewport } from "../../ui/ConversationScrollViewport.js";
import "./conversation.css";
import "./cards/content-cards.css";

type PendingOptimisticUser = {
  text: string;
  attachments: AttachmentChipInput[];
};

export type OptimisticAttachmentInput = {
  path: string;
  name?: string;
  kind: string;
  mimeType: string;
  sizeBytes?: number;
};

export type PendingApproval = {
  requestId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  /** Epoch ms when the auto-deny timer fires (drives the Deny countdown). */
  expiresAt: number;
  /** Shell Safe Mode risk context, when the ask came from the assessor. */
  risk?: {
    fatal: boolean;
    reason: string;
    trashRewrite: boolean;
  };
};

export type PendingUserAsk = {
  requestId: string;
  toolCallId: string;
  question: string;
  options: string[];
  optionDetails?: import("../../../../shared/askUser.js").UserAskOption[];
  allowCustom: boolean;
  allowMultiple: boolean;
};

/**
 * Progressive conversation window (tail load). The view renders only the
 * windowed turns and pages older ones in on demand (scroll to top).
 */
export type ConversationWindowState = {
  /** First message id of the window — cursor for the next older page. */
  firstMessageId: string | null;
  /** Visible messages exist above this window (offer "load earlier"). */
  hasMore: boolean;
  /** Turn starts remaining above the window (sentinel label). */
  remainingTurns: number;
};

export type RenderMessagesOptions = {
  historySince?: number | undefined;
  /**
   * First messages of turns that have no user prompt (CoCo automatic /
   * hand-over replies). Each starts its own turn instead of joining the
   * previous prompt's turn.
   */
  turnStartMessageIds?: ReadonlySet<string> | undefined;
  sessionId?: string;
  sessionStatus: SessionStatus;
  revealLabel: string;
  onOpenFile: (path: string) => void;
  onRevealFile: (path: string) => void;
  /** Save As (copy to user-chosen location) for generated / output files. */
  onSaveFile?: (path: string) => void;
  onOpenUrl: (url: string) => void;
  onLoadFilePreview: (
    path: string,
  ) => Promise<{ ok: true; content: string } | { ok: false; message: string }>;
  /** Open a Markdown file in the dedicated Markdown Reader window. */
  onOpenFileReader?: (path: string) => void;
  /** Verify paths named in reply text before listing them as mentioned files. */
  filterExistingFiles?: (paths: string[]) => Promise<string[]>;
  pendingAsks?: PendingUserAsk[];
  onUserAskAnswer?: (
    requestId: string,
    answer: { selected: string; selections?: string[]; custom: boolean; comment?: string },
  ) => void;
  onAbortToolCall?: (toolCallId: string) => void;
  /** Latest Session.plan from main (live overlay for the active plan card). */
  plan?: unknown;
  /**
   * Latest provider balance description for the most recently completed turn
   * (e.g. DeepSeek). Shown under `Completed · …` when present.
   */
  providerBalanceText?: string | null;
  /**
   * Click on the running turn's reclaimable prompt card: stop the turn.
   * Main's STOP-rollback then drops the pre-content prompt from the
   * transcript and hands it back to the composer (prompt_restored).
   */
  onReclaimUserPrompt?: () => void;
  /** Retry an errored turn: consume the error row, resend its prompt. */
  onRetryTurnError?: (payload: TurnErrorRetryPayload) => RetryOutcome;
  /** Progressive window state; omit for a full (legacy) transcript render. */
  window?: ConversationWindowState | null;
  /** Scroll-to-top or sentinel click → load older turns. */
  onLoadEarlier?: () => void;
};

/** Throttle streaming Markdown repaints (~20 fps) to limit parse/DOM churn. */
const STREAMING_MARKDOWN_MIN_MS = 50;
/**
 * Live Thinking body: slower floor than reply Markdown, and slows further as
 * the CoT buffer grows (huge reasoning streams were freezing the renderer).
 */
const STREAMING_REASONING_MIN_MS = 100;
const STREAMING_REASONING_MAX_MS = 280;
/** While streaming, only paint the newest tail into the DOM. */
const STREAMING_REASONING_TAIL_CHARS = 12_000;
/** Distance from top that triggers loading an older page. */
const LOAD_EARLIER_TRIGGER_PX = 240;
/** Scroll distance under which the top fade stays hidden (edge jitter). */
const TOP_FADE_EPSILON_PX = 2;
/** Sentinel class — excluded from turn wrapping in layoutTurns. */
const LOAD_EARLIER_CLASS = "conversation-load-earlier";
/**
 * Top-level rows that may legitimately sit directly above their turn's user
 * row mid-send: live streaming rows, ephemeral Thinking blocks, and
 * continuation rows hosting in-flight tool cards. Anything else above a
 * prompt is settled history — e.g. an assistant-only turn tail such as CoCo
 * wake greetings / plan-ready notices — and must stay ABOVE the prompt.
 */
const LIVE_TURN_ORPHAN_SELECTOR =
  "[data-streaming='1'], [data-ephemeral='1'], [data-message-continuation]";
/**
 * Invisible first row of a turn that has no user prompt (CoCo automatic /
 * hand-over replies). `layoutTurns` starts a turn container at it so the
 * reply does not land under the previous turn's `Completed` footer.
 */
const TURN_BOUNDARY_CLASS = "conversation-turn-boundary";

function createTurnBoundaryRow(): HTMLElement {
  const row = document.createElement("div");
  row.className = TURN_BOUNDARY_CLASS;
  row.hidden = true;
  row.setAttribute("aria-hidden", "true");
  return row;
}

function isTurnStartRow(el: Element): boolean {
  return (
    el.classList.contains(TURN_BOUNDARY_CLASS) ||
    (el.classList.contains("conversation-msg-user") &&
      (el as HTMLElement).dataset.turnContinuation !== "1")
  );
}
/** Ease factor per frame when chasing the bottom (higher = snappier). */
const SCROLL_BOTTOM_EASE = 0.22;
/** Snap when remaining distance is within this many pixels. */
const SCROLL_BOTTOM_SNAP_PX = 2;

/** Tolerance for "the user is still reading the newest lines" inside a card. */
const CARD_SCROLL_BOTTOM_PX = 8;

function isScrolledToBottom(el: HTMLElement): boolean {
  return (
    el.scrollHeight - el.scrollTop - el.clientHeight <= CARD_SCROLL_BOTTOM_PX
  );
}

/**
 * Whitespace-collapsed text of a user prompt row — same shape the pill's
 * text renderer expects (pillTextFromParts over transcript parts).
 */
function userPromptRowText(row: HTMLElement): string | null {
  const parts = row.querySelectorAll(".message-part-text");
  const raw =
    parts.length > 0
      ? Array.from(parts, (part) => part.textContent ?? "").join(" ")
      : (row.textContent ?? "");
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed || null;
}

export class ConversationView {
  readonly root: HTMLElement;
  readonly messagesEl: HTMLElement;
  /** Top edge fade — on while the transcript is scrolled below the top. */
  readonly topFadeEl: HTMLElement;
  private readonly messagesListEl: HTMLElement;
  /** Live build card host — sibling of the list, survives repaints. */
  private readonly buildStatusHost: HTMLElement;
  readonly approvalsEl: HTMLElement;
  readonly gitBar: ConversationGitBarView;
  readonly composer: TaskComposerView;
  readonly promptQueue: PromptQueueView;
  readonly textarea: HTMLTextAreaElement;
  private readonly planReviewHost: HTMLElement;
  private planReviewBusy = false;
  private planReviewError: string | null = null;
  /** Set by {@link expectTurnWithoutPrompt}; consumed by the first live row. */
  private pendingTurnBoundary = false;
  private planReviewExpanded = false;
  private planReviewMarkdown: string | null = null;
  private planReviewApi: PlanReviewBarApi | null = null;
  /** Panel still sliding out; kept so a repeat dismiss does not cut it short. */
  private planReviewExiting: HTMLElement | null = null;
  private planReviewLast: {
    summary?: string;
    docPath?: string;
  } = {};
  private onPlanApprove: (() => void) | null = null;
  private onPlanDiscard: (() => void) | null = null;
  readonly plusButton: HTMLButtonElement;
  readonly imagesButton: HTMLButtonElement;
  readonly attachmentsButton: HTMLButtonElement;
  readonly sendButton: HTMLButtonElement;
  private readonly footerEl: HTMLElement;
  private readonly footerActionsEl: HTMLElement;
  private readonly footerActionsLeftEl: HTMLElement;
  private readonly scrollBottomButton: HTMLButtonElement;
  private readonly scrollViewport: ConversationScrollViewport;
  private readonly toolCardViewport: ToolCardViewport;
  private readonly defaultPlaceholder =
    "Ask to build, fix, or explore… (⌥⌃ for voice)";
  /**
   * Composer hint while a turn is running. Typing no longer interrupts the
   * turn — it queues — so the placeholder has to say so.
   */
  private readonly queuePlaceholder = "Queue a message for after this turn…";

  private onApprovalRespond:
    | ((requestId: string, approved: boolean) => void)
    | null = null;

  private streamingTextBuffer = "";
  private streamingMessageId: string | null = null;
  /** False while short streamed text is held off-screen. */

  private streamingPaintTimer: ReturnType<typeof setTimeout> | null = null;
  private streamingRafId: number | null = null;
  private lastStreamingPaintAt = 0;
  private streamingPaintQueued = false;
  private reasoningTextBuffer = "";
  private reasoningMessageId: string | null = null;
  private reasoningStartedAt = 0;
  private reasoningPaintTimer: ReturnType<typeof setTimeout> | null = null;
  private reasoningRafId: number | null = null;
  private lastReasoningPaintAt = 0;
  private reasoningPaintQueued = false;
  /** RAF id for eased chase inside the streaming Thinking body. */
  private reasoningBodyScrollRafId: number | null = null;
  /** Live duration ticker while Thinking is streaming. */
  private reasoningMetaTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * In-flight user prompt (optimistic). Kept until the persisted user row is
   * reconciled / present in a full snapshot so streaming can re-seat the card.
   */
  private pendingOptimistic: PendingOptimisticUser | null = null;
  /**
   * Persisted user-message count when optimistic was mounted. Used so a full
   * refresh with only older turns does not treat "last turn has a user" as
   * proof that *this* send is already on screen.
   */
  private userCountBeforePending = 0;
  /**
   * Latest snapshot driving the prompt-card reclaim affordance
   * (messages + status).
   */
  private userPromptReclaimability: {
    messages: Array<{
      id?: string;
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    status: string;
  } | null = null;
  /** Reclaim (stop turn) handler from the last renderMessages options. */
  private onReclaimUserPrompt: (() => void) | null = null;
  private readonly autoScroll: ConversationAutoScroll;
  /** Desired visibility for the scroll-to-bottom control (enter/exit anim). */
  private scrollBottomWanted = false;
  /** Progressive window state from the last full render (null = full render). */
  private windowState: ConversationWindowState | null = null;
  /** Controller callback for paging in older turns. */
  private onLoadEarlier: (() => void) | null = null;
  /** Sentinel row ("Load earlier · N turns") at the top of the list. */
  private loadEarlierEl: HTMLElement | null = null;
  private loadEarlierBarEl: HTMLElement | null = null;
  private loadEarlierLabelEl: HTMLElement | null = null;
  private loadEarlierBusy = false;
  /** Options of the last committed full render (context for prepended pages). */
  private lastRenderOptions: RenderMessagesOptions | null = null;
  /**
   * Notified when the pill's prompt anchor moves — the user bubble the
   * current scroll position is "reading". `visible` = that bubble is on
   * screen (pill auto-folds to its 3-dot strip); otherwise `text` is the
   * nearest prompt above the viewport for the pill to echo (NOT always
   * the conversation's latest prompt). `messageId` identifies the anchor
   * row when it has one, so the controller can pull that message's
   * attachments for the file badge.
   */
  onPromptVisibilityChange:
    | ((visible: boolean, promptText: string | null, messageId: string | null) => void)
    | null = null;
  /** Last reported anchor state (dedupe for the callback). */
  private promptVisible = false;
  private promptAnchorText: string | null = null;
  private promptAnchorMessageId: string | null = null;

  constructor() {
    this.root = document.createElement("section");
    this.root.className = "conversation-screen";

    this.messagesEl = document.createElement("div");
    this.messagesEl.className = "conversation-messages";
    this.messagesEl.setAttribute("role", "log");
    this.messagesEl.setAttribute("aria-live", "polite");
    this.messagesEl.addEventListener(
      "scroll",
      () => {
        // Prompt visibility is a pure viewport fact — track it even during
        // programmatic eases so the
        // pill reflects where the transcript actually sits.
        this.checkPromptVisibility();
        // The top fade is the same kind of viewport fact.
        this.updateTopFade();
        this.updateScrollBottomButton();
        this.maybeTriggerLoadEarlier();
      },
      { passive: true },
    );

    this.messagesListEl = document.createElement("div");
    this.messagesListEl.className = "conversation-messages-list";
    // Whole-card click-to-reclaim (stop the turn) for the running turn's
    // still-rollback-eligible prompt card (delegated: rows are rebuilt on
    // every transcript repaint).
    this.messagesListEl.addEventListener("click", (event) => {
      this.handlePromptReclaimClick(event);
    });

    this.messagesEl.append(this.messagesListEl);

    // Live build-status card host — a sibling AFTER the message list so the
    // per-repaint messagesListEl.replaceChildren() never wipes it. Cleared
    // on conversation switch / destroy by the controller.
    this.buildStatusHost = document.createElement("div");
    this.buildStatusHost.className = "conversation-build-status-host";
    this.messagesEl.append(this.buildStatusHost);

    this.approvalsEl = document.createElement("div");
    this.approvalsEl.className = "conversation-approvals";
    this.approvalsEl.hidden = true;

    this.footerEl = document.createElement("div");
    this.footerEl.className = "conversation-footer";

    this.footerActionsEl = document.createElement("div");
    this.footerActionsEl.className = "conversation-footer-actions";

    this.footerActionsLeftEl = document.createElement("div");
    this.footerActionsLeftEl.className = "conversation-footer-actions-left";

    this.scrollBottomButton = document.createElement("button");
    this.scrollBottomButton.type = "button";
    this.scrollBottomButton.className = "conversation-scroll-bottom-btn";
    this.scrollBottomButton.setAttribute("aria-label", "Scroll to bottom");
    this.scrollBottomButton.hidden = true;
    this.scrollBottomButton.append(createLucideIcon(ArrowDown, { size: 14 }));
    this.scrollBottomButton.addEventListener("click", () => {
      this.pinToBottom();
    });
    this.scrollBottomButton.addEventListener("transitionend", (event) => {
      if (event.target !== this.scrollBottomButton) return;
      if (event.propertyName !== "opacity") return;
      if (this.scrollBottomWanted) return;
      this.scrollBottomButton.hidden = true;
    });

    this.gitBar = new ConversationGitBarView();

    this.promptQueue = new PromptQueueView();

    this.composer = new TaskComposerView({
      placeholder: this.defaultPlaceholder,
      ariaLabel: "Follow-up prompt",
      className: "task-composer-wide",
      rows: 1,
    });
    this.textarea = this.composer.textarea;
    this.plusButton = this.composer.plusButton;
    this.imagesButton = this.composer.imagesButton;
    this.attachmentsButton = this.composer.attachmentsButton;
    this.sendButton = this.composer.sendButton;

    this.footerActionsLeftEl.append(this.scrollBottomButton, this.gitBar.root);
    this.footerActionsEl.append(this.footerActionsLeftEl);

    this.planReviewHost = document.createElement("div");
    this.planReviewHost.className = "conversation-plan-review-host";
    this.planReviewHost.hidden = true;

    // Approvals ride inside the overlay footer stack (above the composer):
    // as a flow sibling of the scrollport they landed under the absolute
    // footer, hiding the Allow/Deny actions behind the composer.
    this.footerEl.append(
      this.footerActionsEl,
      this.planReviewHost,
      this.approvalsEl,
      this.promptQueue.root,
      this.composer.root,
    );
    this.topFadeEl = document.createElement("div");
    this.topFadeEl.className = "conversation-top-fade";
    this.topFadeEl.setAttribute("aria-hidden", "true");
    // Absolute over the scrollport's top edge (conversation-screen is the
    // positioning context); pointer-events none in CSS so it never blocks.
    this.root.append(this.topFadeEl, this.messagesEl, this.footerEl);
    this.autoScroll = new ConversationAutoScroll(
      this.messagesEl,
      [this.messagesListEl, this.buildStatusHost],
      () => {
        this.updateScrollBottomButton();
        this.checkPromptVisibility();
        this.updateTopFade();
      },
    );
    this.toolCardViewport = new ToolCardViewport(this.messagesEl, this.messagesListEl);
    this.scrollViewport = new ConversationScrollViewport(
      this.messagesEl,
      [this.messagesListEl, this.buildStatusHost],
      this.footerEl,
      () => {
        this.autoScroll.snapIfFollowing();
        this.updateScrollBottomButton();
      },
    );
    this.updateTopFade();
  }

  /** Use the same transcript, cards, scrolling and approvals inside a host's composer. */
  setTranscriptOnly(): void {
    this.root.classList.add("conversation-transcript-only");
    this.footerEl.replaceChildren(this.approvalsEl);
    this.root.style.setProperty("--conversation-composer-clearance", "12px");
  }

  setApprovalHandler(
    handler: ((requestId: string, approved: boolean) => void) | null,
  ): void {
    this.onApprovalRespond = handler;
  }

  /**
   * Turn status line — the old composer-right status row, relocated onto the
   * live Thinking block's title. The "next" block materializes early (turn
   * submit) and carries the progress text until its first reasoning delta
   * arrives, when the same row flips to "Thinking…". Hidden/empty removes a
   * row that never received content; a row with live CoT keeps the existing
   * Thinking lifecycle (collapse to Thought etc.) untouched.
   */
  setStatusLine(text: string, show: boolean): void {
    const trimmed = text.trim();
    if (!show || !trimmed) {
      this.removeEmptyStatusRow();
      return;
    }
    this.ensureCurrentTurnUserCard();
    const { block } = this.ensureTurnReasoningBlock({ pinToBottom: true });
    setReasoningBlockStatusText(block, trimmed, {
      animated: isAnimatedProgressText(trimmed),
    });
    this.scrollToBottomIfStuck();
  }

  /** True when the streaming block carries nothing but its status title. */
  private isEmptyStatusRow(block: HTMLElement): boolean {
    if (this.reasoningMessageId) return false; // live CoT owns this block
    if (reasoningBlockToolHints(block).length > 0) return false;
    if (reasoningBlockToolRecords(block).length > 0) return false;
    const body = block.querySelector<HTMLElement>(".conversation-reasoning-body");
    return !body?.textContent?.trim();
  }

  /** Drop a status row that never received CoT/tool hints (turn end / hide). */
  private removeEmptyStatusRow(): void {
    const block = this.findTurnReasoningBlock();
    if (!block || block.dataset.mode !== "streaming") return;
    if (!this.isEmptyStatusRow(block)) return;
    block.remove();
    this.resetReasoningStreamState();
  }

  /**
   * Top fade state machine: on whenever content sits above the scrollport's
   * top edge, off at scrollTop 0. Class toggle only — cheap enough to run
   * on every scroll event alongside prompt visibility.
   */
  private updateTopFade(): void {
    this.topFadeEl.classList.toggle(
      "is-on",
      this.messagesEl.scrollTop > TOP_FADE_EPSILON_PX,
    );
  }

  /** Show the jump-to-bottom control when the transcript is scrolled up. */
  private updateScrollBottomButton(): void {
    this.setScrollBottomButtonVisible(
      this.scrollViewport.shouldShowButton(this.autoScroll.following),
    );
  }

  private setScrollBottomButtonVisible(show: boolean): void {
    if (show === this.scrollBottomWanted) return;
    this.scrollBottomWanted = show;
    const btn = this.scrollBottomButton;
    if (show) {
      btn.hidden = false;
      // Reflow so the enter transition starts from the resting (hidden) styles.
      void btn.offsetWidth;
      btn.classList.add("is-visible");
      return;
    }
    btn.classList.remove("is-visible");
  }

  private checkPromptVisibility(): void {
    const anchor = this.computePromptAnchor();
    const visible = anchor.visible;
    const text = anchor.text;
    const messageId = anchor.messageId;
    if (
      visible === this.promptVisible &&
      text === this.promptAnchorText &&
      messageId === this.promptAnchorMessageId
    ) {
      return;
    }
    this.promptVisible = visible;
    this.promptAnchorText = text;
    this.promptAnchorMessageId = messageId;
    this.onPromptVisibilityChange?.(visible, text, messageId);
  }

  /**
   * Anchor = prompt of the turn the viewport is reading (pure math in
   * promptAnchor.ts): on-screen prompt → fold + that row as anchor; else
   * the nearest prompt ABOVE the viewport. Sticky-header clones excluded —
   * they mirror, not replace, the real rows.
   */
  private computePromptAnchor(): {
    visible: boolean;
    text: string | null;
    messageId: string | null;
  } {
    const rows = this.userPromptRows();
    if (rows.length === 0) {
      return { visible: false, text: null, messageId: null };
    }
    const vpRect = this.messagesEl.getBoundingClientRect();
    const metrics = rows.map((row) => {
      const rect = row.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    });
    const anchor = computePromptAnchor(metrics, {
      top: vpRect.top,
      bottom: vpRect.bottom,
    });
    if (!anchor) return { visible: false, text: null, messageId: null };
    return {
      visible: anchor.visible,
      text: userPromptRowText(rows[anchor.anchorIndex]!),
      messageId: rows[anchor.anchorIndex]!.dataset.messageId ?? null,
    };
  }

  private userPromptRows(): HTMLElement[] {
    const rows: HTMLElement[] = [];
    for (const el of this.messagesListEl.querySelectorAll<HTMLElement>(
      ".conversation-msg-user",
    )) {
      // Sticky mirrors (.conversation-user-sticky) duplicate the prompt at
      // a pinned position — visibility must key on the real row.
      if (el.closest(".conversation-user-sticky")) continue;
      rows.push(el);
    }
    return rows;
  }

  /** Follow new content only while the user stays pinned to the bottom. */
  private scrollToBottomIfStuck(): void {
    this.autoScroll.contentChanged();
  }

  /** Re-enable bottom follow from the explicit scroll-to-bottom control. */
  private pinToBottom(): void {
    this.autoScroll.follow();
  }

  /** toolCallIds of ask/bypass cards currently waiting for an answer. */
  private static askingCallIds(scope: ParentNode): Set<string> {
    const ids = new Set<string>();
    for (const card of scope.querySelectorAll<HTMLElement>(
      ".content-card-ask-user-tool.is-asking[data-tool-call-id]",
    )) {
      const id = card.dataset.toolCallId;
      if (id) ids.add(id);
    }
    return ids;
  }

  /**
   * An ask_user / bypass-permission card blocks the whole turn — when one
   * newly mounts, reveal it while following, preserving a reader's pause.
   */
  private revealNewAskCard(before: ReadonlySet<string>): boolean {
    for (const id of ConversationView.askingCallIds(this.messagesListEl)) {
      if (!before.has(id)) {
        this.scrollToBottomIfStuck();
        return true;
      }
    }
    return false;
  }

  setRunning(running: boolean): void {
    // Input stays editable while a turn runs: typed text goes to the queue.
    // The class also gates error-card Retry buttons (CSS disabled look).
    this.messagesListEl.classList.toggle("is-turn-running", running);
    this.composer.setTurnRunning(running);
    this.composer.setInputDisabled(false);
    this.composer.setPlaceholder(
      running ? this.queuePlaceholder : this.defaultPlaceholder,
    );
  }

  setStopMode(stop: boolean, options?: { steer?: boolean }): void {
    this.composer.setStopMode(stop, options);
  }

  setSendEnabled(enabled: boolean): void {
    this.composer.setSendEnabled(enabled);
  }

  setPromptQueue(
    items: PromptQueueItem[],
    handlers?: PromptQueueHandlers | null,
  ): void {
    if (handlers !== undefined) {
      this.promptQueue.setHandlers(handlers);
    }
    this.promptQueue.setItems(items);
  }

  /** No turn running → queue rows switch to the "ready to send" palette. */
  setPromptQueueIdle(idle: boolean): void {
    this.promptQueue.setSessionIdle(idle);
  }

  setPlanReviewHandlers(handlers: {
    onApprove: () => void;
    onDiscard: () => void;
  }): void {
    this.onPlanApprove = handlers.onApprove;
    this.onPlanDiscard = handlers.onDiscard;
  }

  setPlanReviewBusy(busy: boolean, error?: string | null): void {
    this.planReviewBusy = busy;
    if (error !== undefined) this.planReviewError = error;
    if (this.planReviewApi) {
      this.planReviewApi.setBusy(busy);
      if (error !== undefined) this.planReviewApi.setError(error);
      return;
    }
    // No live bar yet — next syncPlanReview will pick up busy/error.
  }

  /**
   * Show / hide the Approve | Discard bar when planDoc.approvalPending.
   * Detail expands the same panel with an inline markdown preview.
   */
  syncPlanReview(input: {
    active: boolean;
    summary?: string;
    docPath?: string;
    error?: string | null;
  }): void {
    if (!input.active) {
      this.dismissPlanReview();
      return;
    }
    if (input.error !== undefined) {
      this.planReviewError = input.error;
      // A live panel would otherwise keep the stale error until it rebuilds.
      this.planReviewApi?.setError(input.error);
    }
    const prev = this.planReviewLast;
    if (input.summary !== undefined || input.docPath !== undefined) {
      this.planReviewLast = {
        ...(input.summary ?? prev.summary
          ? { summary: input.summary ?? prev.summary }
          : {}),
        ...(input.docPath ?? prev.docPath
          ? { docPath: input.docPath ?? prev.docPath }
          : {}),
      };
      // Doc path changed → drop cached markdown.
      if (input.docPath !== undefined && input.docPath !== prev.docPath) {
        this.planReviewMarkdown = null;
      }
    }
    const summary = this.planReviewLast.summary;
    const docPath = this.planReviewLast.docPath;
    // Rebuilding on every metadata refresh would restart the enter animation
    // and drop the open preview, so keep the live panel unless content moved.
    if (
      this.planReviewApi &&
      summary === prev.summary &&
      docPath === prev.docPath
    ) {
      return;
    }
    const entering = !this.planReviewApi;
    // Start folded so the panel rises into a growing host instead of popping
    // the transcript up by its full height in one frame.
    if (entering) settleFold(this.planReviewHost, false, { fade: false });
    this.planReviewHost.hidden = false;
    const api = createPlanReviewBar({
      ...(summary !== undefined ? { summary } : {}),
      ...(docPath !== undefined ? { docPath } : {}),
      busy: this.planReviewBusy,
      error: this.planReviewError,
      expanded: this.planReviewExpanded,
      markdown: this.planReviewMarkdown,
      onApprove: () => {
        this.onPlanApprove?.();
      },
      onDiscard: () => {
        this.onPlanDiscard?.();
      },
      onExpandedChange: (expanded) => {
        this.planReviewExpanded = expanded;
      },
      onMarkdownLoaded: (markdown) => {
        this.planReviewMarkdown = markdown;
      },
      onLoadMarkdown: async () => {
        if (!docPath) return null;
        if (this.planReviewMarkdown) return this.planReviewMarkdown;
        const bridge = window.jellybot;
        if (!bridge?.readTextFile) return null;
        const result = await bridge.readTextFile(docPath);
        if (!result.ok) {
          this.planReviewError = result.message;
          return null;
        }
        return result.content;
      },
    });
    this.planReviewApi = api;
    // Drops any panel still sliding out, so its teardown must not run.
    this.planReviewExiting = null;
    this.planReviewHost.replaceChildren(api.root);
    if (entering) {
      api.playEnter();
      void animateFold(this.planReviewHost, true, { fade: false });
    }
  }

  /**
   * Slide the review panel down + out, then unmount it. Called when approval
   * is no longer pending and by Approve / Discard for instant feedback.
   */
  dismissPlanReview(): void {
    const api = this.planReviewApi;
    this.planReviewApi = null;
    this.planReviewError = null;
    this.planReviewBusy = false;
    this.planReviewExpanded = false;
    this.planReviewMarkdown = null;
    this.planReviewLast = {};
    if (!api) {
      // Repeat calls arrive while the previous panel is still sliding out.
      if (this.planReviewExiting) return;
      this.planReviewHost.replaceChildren();
      this.planReviewHost.hidden = true;
      return;
    }
    this.planReviewExiting = api.root;
    void Promise.all([
      api.playExit(),
      animateFold(this.planReviewHost, false, { fade: false }),
    ]).then(() => {
      if (this.planReviewExiting === api.root) this.planReviewExiting = null;
      // A new panel may have mounted meanwhile — only clear our own node.
      if (api.root.parentElement === this.planReviewHost) api.root.remove();
      if (!this.planReviewApi) this.planReviewHost.hidden = true;
    });
  }

  setActionsExpanded(expanded: boolean): void {
    this.composer.setPlusMenuOpen(expanded);
  }

  setOnRunModeSelect(
    handler: ((
      mode: import("../../ui/taskComposer/TaskComposerView.js").ComposerRunMode,
    ) => void) | null,
  ): void {
    this.composer.setOnRunModeSelect(handler);
  }

  setOnCustomGraphSelect(
    handler: ((graph: { id: string; name: string }) => void) | null,
  ): void {
    this.composer.setOnCustomGraphSelect(handler);
  }

  setCustomGraphSelection(
    graph:
      | { id: string; name: string; color?: string | null | undefined }
      | null,
  ): void {
    this.composer.setCustomGraphSelection(graph);
  }

  setOnInfiniteSelect(
    handler: ((enabled: boolean) => void) | null,
  ): void {
    this.composer.setOnInfiniteSelect(handler);
  }

  setInfiniteEnabled(enabled: boolean): void {
    this.composer.setInfiniteEnabled(enabled);
  }

  setOnPermissionsSelect(
    handler: ((fullPermissions: boolean) => void) | null,
  ): void {
    this.composer.setOnPermissionsSelect(handler);
  }

  setOnAutoSkillSummarizeSelect(
    handler: ((enabled: boolean) => void) | null,
  ): void {
    this.composer.setOnAutoSkillSummarizeSelect(handler);
  }

  setOnHandoffSelect(
    handler: ((enabled: boolean) => void) | null,
  ): void {
    this.composer.setOnHandoffSelect(handler);
  }

  setHandoffVisible(visible: boolean): void {
    this.composer.setHandoffVisible(visible);
  }

  setHandoffEnabled(enabled: boolean): void {
    this.composer.setHandoffEnabled(enabled);
  }

  setPermissionsEnabled(enabled: boolean): void {
    this.composer.setPermissionsEnabled(enabled);
  }

  setAutoSkillSummarizeEnabled(enabled: boolean): void {
    this.composer.setAutoSkillSummarizeEnabled(enabled);
  }

  setComposerRunMode(
    mode: import("../../ui/taskComposer/TaskComposerView.js").ComposerRunMode,
  ): void {
    this.composer.setComposerRunMode(mode);
  }

  /** @deprecated Prefer setComposerRunMode. */
  setPlanModeEnabled(enabled: boolean): void {
    this.composer.setComposerRunMode(enabled ? "plan" : "agent");
  }

  setReasoningEffort(
    level: import("../../ui/effortSeg/EffortSegView.js").ReasoningEffortLevel,
  ): void {
    this.composer.setReasoningEffort(level);
  }

  setOnReasoningEffortSelect(
    handler:
      | ((
          level: import("../../ui/effortSeg/EffortSegView.js").ReasoningEffortLevel,
        ) => void)
      | null,
  ): void {
    this.composer.setOnReasoningEffortSelect(handler);
  }

  setContextUsage(
    usage: Parameters<TaskComposerView["setContextUsage"]>[0],
  ): void {
    this.composer.setContextUsage(usage);
  }

  getPrompt(): string {
    return this.composer.getPrompt();
  }

  clearPrompt(): void {
    this.composer.clearPrompt();
  }

  focusInput(): void {
    this.composer.focusInput();
  }

  isStopMode(): boolean {
    return this.composer.isStopMode();
  }

  private renderMessagesGeneration = 0;

  /** Abort any in-flight full transcript rebuild before it commits to the DOM. */
  invalidateInFlightMessageRender(): void {
    this.renderMessagesGeneration += 1;
  }

  renderMessages(
    messages: Array<{
      id?: string;
      role: string;
      createdAt?: number;
      parts: Array<Record<string, unknown>>;
    }>,
    options: RenderMessagesOptions,
  ): Promise<void> {
    this.onReclaimUserPrompt = options.onReclaimUserPrompt ?? null;
    // Fresh reclaimability source for this render (the commit-block re-apply
    // runs before the controller pushes its post-render snapshot).
    this.userPromptReclaimability = { messages, status: options.sessionStatus };
    const generation = ++this.renderMessagesGeneration;
    return this.renderMessagesAsync(generation, messages, options);
  }

  private async renderMessagesAsync(
    generation: number,
    messages: Array<{
      id?: string;
      role: string;
      createdAt?: number;
      parts: Array<Record<string, unknown>>;
    }>,
    options: RenderMessagesOptions,
  ): Promise<void> {
    // A rebuilt transcript already splits prompt-less turns from data.
    if (options.sessionStatus !== "running") this.pendingTurnBoundary = false;
    this.resetStreamingMarkdownState();
    this.removeStreamingRows();
    // Keep pendingOptimistic + any optimistic row until we successfully commit.
    // Stale concurrent refreshes must not clear the just-sent prompt.

    // Wire-only role overlay is a trailing `user` message for cache; never show it.
    messages = messages.filter(
      (message) => !isWireOverlayTranscriptMessage(message),
    );
    messages = recentMessages(messages, options.historySince);

    const needsMermaid = messages.some((message) =>
      message.parts.some(
        (part) =>
          part.type === "text" &&
          typeof part.text === "string" &&
          /```mermaid\b/i.test(part.text),
      ),
    );
    if (needsMermaid) {
      this.setStatusLine("Rendering Mermaid diagram…", true);
    }

    const ctx = this.preserveCollapsedToolCards(buildMessageRenderContext(messages, options));
    // /clear: everything before the last clear marker is hidden from the
    // view; the marker itself renders as a "Conversation cleared" divider.
    let clearIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]!;
      if (
        message.role === "system" &&
        message.parts.some((part) => part.type === "context_clear")
      ) {
        clearIndex = i;
        break;
      }
    }
    const visibleMessages =
      clearIndex >= 0 ? messages.slice(clearIndex) : messages;
    const turns = splitMessagesIntoTurns(visibleMessages, options.turnStartMessageIds);
    const turnInProgress = options.sessionStatus === "running";
    const fragment = document.createDocumentFragment();

    this.windowState = options.window ?? null;
    this.onLoadEarlier = options.onLoadEarlier ?? null;
    this.lastRenderOptions = options;
    this.loadEarlierBusy = false;
    const sentinel = this.createLoadEarlierSentinel();
    if (sentinel) fragment.append(sentinel);

    try {
      const completed = await this.appendTurnsToFragment(
        fragment,
        turns,
        ctx,
        options,
        generation,
        { lastTurnLive: turnInProgress, showBalanceOnLast: true },
      );
      if (!completed) return;

      if (generation !== this.renderMessagesGeneration) return;
      const askingBefore = ConversationView.askingCallIds(this.messagesListEl);
      const pausedTop = this.autoScroll.following ? null : this.messagesEl.scrollTop;
      this.messagesListEl.replaceChildren();
      this.messagesListEl.append(fragment);
      this.layoutTurns();
      if (pausedTop !== null) this.autoScroll.restoreTop(pausedTop);

      // After replaceChildren the optimistic row is gone. Remount it unless
      // the snapshot gained a *new* user since this send (exact text match is
      // unsafe: identical re-sends match the previous turn's user and would
      // clear pending → flash then vanish).
      if (this.pendingOptimistic) {
        // Count on the same basis as userCountBeforePending (rendered DOM
        // rows = visible/sliced users). The full array still holds pre-/clear
        // users — counting those would drop the optimistic row before the
        // new prompt ever lands in the snapshot.
        const snapshotUserCount = visibleMessages.filter(
          (message) => message.role === "user",
        ).length;
        if (snapshotUserCount > this.userCountBeforePending) {
          this.pendingOptimistic = null;
        } else {
          this.mountOptimisticUserRow(this.pendingOptimistic);
        }
      }

      // Re-apply the reclaim affordance — the rebuild above dropped it.
      this.applyUserPromptReclaimability();

      if (!this.revealNewAskCard(askingBefore)) this.scrollToBottomIfStuck();
      // Short window in a tall viewport: scrollTop stays 0 and no scroll
      // event will fire — keep paging until the viewport overflows.
      this.maybeTriggerLoadEarlier();
    } finally {
      if (
        generation === this.renderMessagesGeneration &&
        needsMermaid &&
        options.sessionStatus !== "running"
      ) {
        // Idle refresh: clear the temporary Mermaid status; metadata may reset it.
        this.setStatusLine("", false);
      }
    }
  }

  /**
   * Render turns (message rows + per-turn files/ended summary blocks) into
   * `fragment`. Shared by the full window rebuild and prepended pages.
   * Resolves false when the generation moved on (fragment is partial — drop).
   */
  private async appendTurnsToFragment(
    fragment: DocumentFragment,
    turns: Array<
      Array<{
        id?: string;
        role: string;
        createdAt?: number;
        parts: Array<Record<string, unknown>>;
      }>
    >,
    ctx: ReturnType<typeof buildMessageRenderContext>,
    options: RenderMessagesOptions,
    generation: number,
    behavior: {
      /** Last turn is the live one (running session) — suppress its ended divider. */
      lastTurnLive: boolean;
      /** Attach providerBalanceText to the last completed turn (full render only). */
      showBalanceOnLast: boolean;
    },
  ): Promise<boolean> {
    const lastTurnIndex = turns.length - 1;
    for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
      if (generation !== this.renderMessagesGeneration) return false;
      const turn = turns[turnIndex]!;
      const firstId = turn[0]?.id;
      if (firstId && turn[0]!.role !== "user" && options.turnStartMessageIds?.has(firstId)) {
        fragment.append(createTurnBoundaryRow());
      }
      // File list below uses the original turn. This projection only
      // changes what the column paints while the turn is on screen.
      const displayTurn = projectTurnMessages(turn);
      for (const message of displayTurn) {
        if (message.role === "system") {
          const hasUi = message.parts.some(
            (part) =>
              part.type === "context_compaction" ||
              part.type === "context_clear" ||
              (part.type === "text" &&
                typeof part.text === "string" &&
                part.text.trim().length > 0),
          );
          if (!hasUi) continue;
        }
        try {
          const row = await createMessageViewAsync(message, ctx);
          if (generation !== this.renderMessagesGeneration) return false;
          if (row) fragment.append(row);
        } catch (err) {
          console.error("[conversation] failed to render message", err);
          const fallback = document.createElement("article");
          fallback.className = `conversation-msg conversation-msg-${message.role}`;
          const body = document.createElement("div");
          body.className = "conversation-msg-body";
          body.textContent =
            err instanceof Error
              ? `Failed to render message: ${err.message}`
              : "Failed to render message.";
          fallback.append(body);
          fragment.append(fallback);
        }
      }

      const turnComplete = !(
        behavior.lastTurnLive && turnIndex === lastTurnIndex
      );
      if (!turnComplete) continue;

      const files = await collectTurnFiles(turn, options.filterExistingFiles);
      if (generation !== this.renderMessagesGeneration) return false;
      const urls = collectUrlsFromMessages(turn);
      if (files.length > 0 || urls.length > 0) {
        fragment.append(
          createTurnModifiedFilesView({
            files,
            urls,
            revealLabel: options.revealLabel,
            onOpen: options.onOpenFile,
            onReveal: options.onRevealFile,
            onOpenUrl: options.onOpenUrl,
            onLoadPreview: options.onLoadFilePreview,
            onOpenReader: options.onOpenFileReader,
          }),
        );
      }

      const isLastTurn = turnIndex === lastTurnIndex;
      const ended = createTurnEndedViewFromMessages(
        turn,
        isLastTurn && behavior.showBalanceOnLast
          ? options.providerBalanceText
          : null,
      );
      if (ended) fragment.append(ended);
    }
    return generation === this.renderMessagesGeneration;
  }

  // ------------------------------------------------ progressive window

  /** Cursor of the current progressive window (null = full render). */
  currentWindowFirstMessageId(): string | null {
    return this.windowState?.firstMessageId ?? null;
  }

  /** Busy state for the load-earlier sentinel (thin scan bar). */
  setLoadEarlierBusy(busy: boolean): void {
    this.loadEarlierBusy = busy;
    if (this.loadEarlierBarEl) this.loadEarlierBarEl.hidden = !busy;
    this.loadEarlierEl?.setAttribute("aria-busy", busy ? "true" : "false");
  }

  /** Near-top auto trigger for older pages. */
  private maybeTriggerLoadEarlier(): void {
    if (!this.windowState?.hasMore) return;
    if (this.loadEarlierBusy) return;
    if (this.messagesEl.scrollTop > LOAD_EARLIER_TRIGGER_PX) return;
    this.onLoadEarlier?.();
  }

  /** Sentinel click: explicit load regardless of scroll position. */
  private triggerLoadEarlier(): void {
    if (!this.windowState?.hasMore) return;
    if (this.loadEarlierBusy) return;
    this.onLoadEarlier?.();
  }

  /**
   * Build the sentinel row. Created fresh per full render (the list is
   * rebuilt wholesale); removed entirely when nothing remains above.
   */
  private createLoadEarlierSentinel(): HTMLElement | null {
    this.loadEarlierEl = null;
    this.loadEarlierBarEl = null;
    this.loadEarlierLabelEl = null;
    if (!this.windowState?.hasMore) return null;

    const el = document.createElement("button");
    el.type = "button";
    el.className = LOAD_EARLIER_CLASS;
    const bar = document.createElement("span");
    bar.className = `${LOAD_EARLIER_CLASS}-bar`;
    bar.hidden = true;
    const label = document.createElement("span");
    label.className = `${LOAD_EARLIER_CLASS}-label`;
    el.append(bar, label);
    el.addEventListener("click", () => this.triggerLoadEarlier());
    this.loadEarlierEl = el;
    this.loadEarlierBarEl = bar;
    this.loadEarlierLabelEl = label;
    this.syncLoadEarlierLabel();
    return el;
  }

  /** Reflect window state on the sentinel (label / removal). */
  private syncLoadEarlierSentinel(): void {
    if (!this.windowState?.hasMore) {
      // No content above → the row is not shown at all.
      this.loadEarlierEl?.remove();
      this.loadEarlierEl = null;
      this.loadEarlierBarEl = null;
      this.loadEarlierLabelEl = null;
      return;
    }
    if (!this.loadEarlierEl?.isConnected) {
      const sentinel = this.createLoadEarlierSentinel();
      if (sentinel) this.messagesListEl.prepend(sentinel);
      return;
    }
    this.syncLoadEarlierLabel();
  }

  private syncLoadEarlierLabel(): void {
    const remaining = this.windowState?.remainingTurns ?? 0;
    if (!this.loadEarlierLabelEl) return;
    this.loadEarlierLabelEl.textContent =
      remaining > 0
        ? `Load earlier · ${remaining} turn${remaining === 1 ? "" : "s"}`
        : "Load earlier";
  }

  /**
   * Prepend an older page. `cursor` is the window firstMessageId the page
   * was requested against — a mismatch means a full render landed in the
   * meantime; the page is stale and silently dropped.
   */
  async loadEarlierMessages(
    cursor: string,
    page: {
      messages: Array<{
        id?: string;
        role: string;
        createdAt?: number;
        parts: Array<Record<string, unknown>>;
      }>;
      window: ConversationWindowState;
    },
  ): Promise<void> {
    if (!this.windowState || this.windowState.firstMessageId !== cursor) {
      return;
    }
    this.windowState = page.window;
    this.syncLoadEarlierSentinel();

    const messages = page.messages.filter(
      (message) => !isWireOverlayTranscriptMessage(message),
    );
    if (messages.length === 0) return;

    const options = this.lastRenderOptions;
    if (!options) return;
    const ctx = this.preserveCollapsedToolCards(buildMessageRenderContext(messages, options));
    const turns = splitMessagesIntoTurns(messages, options.turnStartMessageIds);

    const scrollport = this.messagesEl;
    const prevScrollHeight = scrollport.scrollHeight;
    const prevScrollTop = scrollport.scrollTop;
    const anchor = this.loadEarlierEl;
    const generation = this.renderMessagesGeneration;

    const fragment = document.createDocumentFragment();
    const completed = await this.appendTurnsToFragment(
      fragment,
      turns,
      ctx,
      options,
      generation,
      { lastTurnLive: false, showBalanceOnLast: false },
    );
    if (!completed) return;
    if (anchor && !anchor.isConnected) return; // list rebuilt meanwhile

    if (anchor) this.messagesListEl.insertBefore(fragment, anchor);
    else this.messagesListEl.prepend(fragment);
    this.layoutTurns();
    // Scroll anchoring: keep the viewport glued to the same content — the
    // prepended height lands above, so compensate the scroll offset.
    this.autoScroll.restoreTop(
      prevScrollTop + (scrollport.scrollHeight - prevScrollHeight),
    );
    this.applyUserPromptReclaimability();
    this.maybeTriggerLoadEarlier();
  }

  /**
   * Turn-end finalize: rebuild ONLY the latest turn segment. Live streaming
   * already put its rows in the DOM; the rebuild appends the files /
   * turn-ended summary blocks and any trailing system markers, and is a
   * self-healing reconcile for rows that missed live events. History turns
   * and the load-earlier window are untouched. Returns false when the latest
   * turn container is missing (or a rebuild raced in) — caller falls back to
   * a full window render.
   */
  async finalizeTurn(
    messages: Array<{
      id?: string;
      role: string;
      createdAt?: number;
      parts: Array<Record<string, unknown>>;
    }>,
    options: RenderMessagesOptions,
  ): Promise<boolean> {
    this.pendingTurnBoundary = false;
    const turn = this.activeTurnEl();
    if (!turn) return false;

    this.finalizeStreamingDisplay();

    const visible = recentMessages(messages, options.historySince).filter(
      (message) => !isWireOverlayTranscriptMessage(message),
    );

    const ctx = this.preserveCollapsedToolCards(buildMessageRenderContext(visible, options));
    const turns = splitMessagesIntoTurns(visible, options.turnStartMessageIds);
    // The tail slice is exactly one turn group; anything else means the
    // transcript shifted under us — let the caller do a full rebuild.
    if (turns.length !== 1) return false;
    // A live prompt-less turn whose start id has not reached the data yet:
    // the tail still holds the previous prompt, which would be duplicated here.
    const opensWithBoundary =
      turn.querySelector(`.${TURN_BOUNDARY_CLASS}`) !== null;
    if (opensWithBoundary !== (turns[0]![0]?.role !== "user")) return false;

    const generation = this.renderMessagesGeneration;
    const fragment = document.createDocumentFragment();
    const completed = await this.appendTurnsToFragment(
      fragment,
      turns,
      ctx,
      options,
      generation,
      { lastTurnLive: false, showBalanceOnLast: true },
    );
    if (!completed) return false;
    if (!turn.isConnected) return false; // list rebuilt meanwhile

    turn.replaceChildren(...fragment.childNodes);
    this.layoutTurns();
    this.applyUserPromptReclaimability();
    this.scrollToBottomIfStuck();
    return true;
  }

  /**
   * Append assistant text during streaming. Markdown is repainted on a
   * throttled schedule; full {@link renderMessages} replaces the streaming row.
   */
  /** Reply text paints immediately — never held off or folded into Thinking. */
  appendStreamingText(delta: string, messageId: string): boolean {
    if (!delta) return this.streamingMessageId !== null;
    if (this.streamingMessageId !== messageId) {
      this.resetStreamingMarkdownState();
      this.streamingMessageId = messageId;
    }
    this.streamingTextBuffer += delta;
    this.finalizeStreamingReasoning();
    this.ensureCurrentTurnUserCard();
    this.ensureStreamingRow(messageId);
    this.scheduleStreamingMarkdownPaint();
    this.scrollToBottomIfStuck();
    return true;
  }

  /** Stream provider CoT into a live Thinking block (collapsed when reply starts). */
  appendStreamingReasoning(delta: string, _messageId: string): void {
    if (!delta) return;
    const { block, created } = this.beginTurnThought();
    this.reasoningTextBuffer += delta;
    // Only real CoT makes the row expandable before the lazy paint fills
    // the body — a hidden-tool record alone never does (it is invisible
    // while streaming), and whitespace-only streams never mark.
    if (this.reasoningTextBuffer.trim()) markReasoningBlockContent(block);
    // Collapsed (default): meta ticker is enough — skip DOM body churn.
    // Expanded: throttled tail paint.
    if (block.classList.contains("is-open")) {
      this.scheduleReasoningPaint();
    }
    if (created) this.scrollToBottomIfStuck();
  }

  /**
   * A tool call is starting. Text already on screen stays where it is; the
   * streaming row is sealed (final markdown paint) while the Thinking block
   * keeps its live spinner.
   */
  foldHeldReplyIntoThought(): void {
    if (!this.streamingMessageId) return;
    this.finalizeStreamingDisplay({ keepReasoning: true });
  }

  /** Show a tool that paints no card on the Thinking title. */
  noteTurnToolHint(hint: string): void {
    const { block, created } = this.beginTurnThought();
    const hints = reasoningBlockToolHints(block);
    pushToolHint(hints, hint);
    setReasoningBlockToolHints(block, hints);
    if (created) this.scrollToBottomIfStuck();
  }

  /**
   * Track one hidden-tool call for the Thought's expandable record: pushed
   * when the call starts, re-stamped with duration/failure when it ends.
   * The rendered list stays hidden while the block streams (Thought artifact).
   */
  noteTurnToolRecord(record: ReasoningToolRecord): void {
    // A slow call may outlive its segment: find the block that owns the id
    // (records carry it from the tool_call event) before defaulting to the
    // newest Thinking block.
    const blocks = [
      ...this.messagesListEl.querySelectorAll<HTMLElement>(".conversation-reasoning"),
    ].reverse();
    for (const block of blocks) {
      if (reasoningBlockToolRecords(block).some((item) => item.id === record.id)) {
        upsertReasoningToolRecord(block, record);
        return;
      }
    }
    const latest = this.findTurnReasoningBlock();
    if (latest) upsertReasoningToolRecord(latest, record);
  }

  /** Find or open the turn's Thinking block in live (spinner) mode. */
  private beginTurnThought(): { block: HTMLElement; created: boolean } {
    this.ensureCurrentTurnUserCard();
    const { block, created } = this.ensureTurnReasoningBlock({ pinToBottom: true });
    // First real content (CoT delta / tool hint) reaches the row: its title
    // stops mirroring the turn progress and settles on "Thinking…".
    setReasoningBlockStatusText(block, "");
    if (created) {
      this.reasoningMessageId = "turn";
      this.reasoningStartedAt = Date.now();
    } else if (!this.reasoningMessageId) {
      const cot = block.querySelector<HTMLElement>(".conversation-reasoning-cot");
      const seeded = cot?.textContent ?? "";
      if (!this.reasoningTextBuffer && seeded && !seeded.startsWith("…")) {
        this.reasoningTextBuffer = seeded;
      }
      if (!this.reasoningStartedAt) this.reasoningStartedAt = Date.now();
      this.reasoningMessageId = "turn";
    }
    this.ensureReasoningMetaTicker();
    return { block, created };
  }

  /** Collapse the live Thinking block to Thought once reply/tools begin. */
  finalizeStreamingReasoning(): void {
    const block = this.findTurnReasoningBlock();
    if (!this.reasoningMessageId) {
      // No live CoT: a bare status row is removable if it never received
      // content; otherwise seal it so its title stops shimmering.
      if (block && block.dataset.mode === "streaming") {
        if (this.isEmptyStatusRow(block)) block.remove();
        else finalizeReasoningBlock(block);
      }
      this.resetReasoningStreamState();
      return;
    }
    this.flushReasoningPaint({ full: true });
    if (block) {
      finalizeReasoningBlock(block, this.currentReasoningStats());
      delete block.dataset.streaming;
    }
    this.resetReasoningStreamState();
  }

  /** True when an in-flight optimistic user row is already in the DOM. */
  private hasPendingOptimisticRow(): boolean {
    return Boolean(
      this.messagesListEl.querySelector(
        ".conversation-msg-user[data-pending-user='1']",
      ),
    );
  }

  /** Compare a user card's text to the in-flight optimistic prompt. */
  private userCardMatchesPending(userCard: HTMLElement): boolean {
    const pending = this.pendingOptimistic;
    if (!pending) return false;
    const text = (
      userCard.querySelector(".message-part-text")?.textContent ?? ""
    ).trim();
    const pendingText = pending.text.trim();
    if (pendingText) return text === pendingText;
    // Attachment-only send: any user card in the latest turn counts once
    // attachments were reconciled into a real message id.
    return Boolean(userCard.dataset.messageId);
  }

  /**
   * Before any in-turn assistant/stream/tool append: ensure *this* send's user
   * card is in the DOM. Must not treat a *previous* turn's user as the current
   * prompt (that hid new prompts and parked Plan under the old turn).
   */
  private ensureCurrentTurnUserCard(): void {
    if (this.hasPendingOptimisticRow()) {
      if (!this.activeTurnFlowEl()) this.layoutTurns();
      return;
    }
    if (!this.pendingOptimistic) return;

    const turn = this.activeTurnEl();
    const latestUser = turn?.querySelector<HTMLElement>(
      ".conversation-msg-user:not([data-pending-user='1'])",
    );
    if (latestUser && this.userCardMatchesPending(latestUser)) {
      // Already reconciled — drop stale pending so we don't remount below Plan.
      this.pendingOptimistic = null;
      return;
    }

    this.mountOptimisticUserRow(this.pendingOptimistic);
  }

  private resetStreamingMarkdownState(): void {
    this.streamingTextBuffer = "";
    this.streamingMessageId = null;
    this.streamingPaintQueued = false;
    if (this.streamingPaintTimer != null) {
      clearTimeout(this.streamingPaintTimer);
      this.streamingPaintTimer = null;
    }
    if (this.streamingRafId != null) {
      cancelAnimationFrame(this.streamingRafId);
      this.streamingRafId = null;
    }
  }

  /** Drop all ephemeral rows before a full transcript rebuild. */
  private removeStreamingRows(): void {
    for (const row of this.messagesListEl.querySelectorAll<HTMLElement>(
      ".conversation-msg-assistant[data-streaming='1']",
    )) {
      row.remove();
    }
    for (const block of this.messagesListEl.querySelectorAll<HTMLElement>(
      ".conversation-reasoning[data-ephemeral='1']",
    )) {
      block.remove();
    }
    this.resetReasoningStreamState();
  }

  /**
   * Flush the final buffered text before tools begin. The row stays fixed and
   * completed tool cards append after it.
   * @param options.keepReasoning when true, leave the live Thinking spinner alone
   *   (used by mid-turn assistant slice refresh while CoT is still streaming).
   */
  finalizeStreamingDisplay(options?: { keepReasoning?: boolean }): void {
    if (!options?.keepReasoning) {
      this.finalizeStreamingReasoning();
    }
    if (this.streamingMessageId && this.streamingTextBuffer) {
      this.streamingPaintQueued = false;
      if (this.streamingPaintTimer != null) {
        clearTimeout(this.streamingPaintTimer);
        this.streamingPaintTimer = null;
      }
      if (this.streamingRafId != null) {
        cancelAnimationFrame(this.streamingRafId);
        this.streamingRafId = null;
      }
      // Final paint: render real SVG previews (not the streaming placeholder).
      this.paintStreamingMarkdown("final");
    }
    if (this.streamingMessageId) {
      const row = this.messagesListEl.querySelector<HTMLElement>(
        `.conversation-msg-assistant[data-message-id="${CSS.escape(this.streamingMessageId)}"]`,
      );
      if (row) delete row.dataset.streaming;
    }
    this.resetStreamingMarkdownState();
  }

  /** True while a live Thinking block is still receiving CoT for this turn. */
  hasLiveStreamingReasoning(): boolean {
    if (!this.reasoningMessageId) return false;
    const block = this.findTurnReasoningBlock();
    return Boolean(block && block.dataset.mode === "streaming");
  }

  private ensureStreamingRow(messageId: string): HTMLElement {
    let row = this.messagesListEl.querySelector<HTMLElement>(
      `.conversation-msg-assistant[data-message-id="${CSS.escape(messageId)}"]`,
    );
    if (row) {
      // Keep stream text in the latest sticky segment's flow (after Plan / user).
      const flow = this.activeTurnFlowEl();
      if (flow && !flow.contains(row)) flow.append(row);
      return row;
    }

    row = document.createElement("article");
    row.className = "conversation-msg conversation-msg-assistant";
    row.dataset.streaming = "1";
    row.dataset.messageId = messageId;

    const body = document.createElement("div");
    body.className = "conversation-msg-body";

    const wrap = document.createElement("div");
    wrap.className = "message-part message-part-text message-part-streaming";

    const mdContainer = document.createElement("div");
    mdContainer.className = "streaming-markdown";

    wrap.append(mdContainer);
    body.append(wrap);
    row.append(body);

    // User card is guaranteed by ensureCurrentTurnUserCard before this runs.
    let flow = this.activeTurnFlowEl();
    if (!flow) {
      const turn = this.activeTurnEl();
      if (turn) {
        flow = document.createElement("div");
        flow.className = FLOW_CLASS;
        turn.append(flow);
      }
    }
    if (flow) {
      const reasoning = flow.querySelector<HTMLElement>(
        `.conversation-reasoning[data-message-id="${CSS.escape(messageId)}"]`,
      );
      if (reasoning?.nextSibling) {
        flow.insertBefore(row, reasoning.nextSibling);
      } else if (reasoning) {
        flow.append(row);
      } else {
        flow.append(row);
      }
    } else {
      // No user turn available (no pending text) — last resort.
      this.messagesListEl.append(row);
      this.layoutTurns();
    }
    return row;
  }

  /**
   * Keep the live Thinking block at the bottom of the turn while nothing has
   * painted below it. Once reply text, a steer, or a tool card paints below
   * it, the block is sealed where it is — later thinking opens a new block
   * under that content. Mirrors {@link projectTurnMessages}. Moves only when
   * out of place, so its animations survive.
   */
  private settleTurnThought(pinToBottom = false): void {
    const block = this.findTurnReasoningBlock();
    if (!block) return;
    if (block.dataset.mode !== "streaming" && block.dataset.ephemeral !== "1") return;
    // pinToBottom (status line / new thinking): a pure status row moves to
    // the bottom even though a tool card landed under it. Tool paths call
    // without the flag — the row stays where the card found it.
    if (!pinToBottom && this.hasContentBelowThought(block)) {
      if (this.reasoningMessageId && block.dataset.mode === "streaming") {
        this.finalizeStreamingReasoning();
      }
      return;
    }
    // pinToBottom on a block with live CoT below content is not a thing
    // (reply streaming hides the status line); guard anyway.
    if (this.hasContentBelowThought(block) && this.reasoningMessageId) return;
    const flow = this.activeTurnFlowEl();
    if (!flow) return;
    // A projected Thinking row moves whole; a live block moves alone.
    const host = block.parentElement?.closest<HTMLElement>(".conversation-msg");
    const node =
      host && host.dataset.messageId?.startsWith("turn-reasoning:") ? host : block;
    let anchor: Element | null = null;
    for (const row of Array.from(flow.children)) {
      if (row === node || row.contains(node)) continue;
      if (row.matches(".turn-modified-files, .turn-ended")) break;
      anchor = row;
    }
    if (!anchor) {
      if (node.parentElement !== flow) flow.prepend(node);
      return;
    }
    if (node.parentElement === flow && node.previousElementSibling === anchor) return;
    anchor.after(node);
  }

  /** The turn's newest Thinking block. */
  private findTurnReasoningBlock(): HTMLElement | null {
    const turn = this.activeTurnEl();
    // No user turn on screen (CoCo automatic turns suppress the prompt and the
    // history window may hold none): the live block sits directly in the list.
    // Only ephemeral blocks qualify so an older reply's Thought is never resumed.
    const blocks = turn
      ? turn.querySelectorAll<HTMLElement>("[data-turn-reasoning='1']")
      : this.messagesListEl.querySelectorAll<HTMLElement>(
          ":scope > [data-turn-reasoning='1'][data-ephemeral='1']",
        );
    return blocks[blocks.length - 1] ?? null;
  }

  /** True when reply text, a steer prompt, or a tool card is painted below
   * `block`. PURE STATUS rows are exempt: the card lands under the live
   * status line and the line only moves to the bottom on the next
   * thinking / status update (writing a file keeps the status where it
   * was). */
  private hasContentBelowThought(block: HTMLElement): boolean {
    if (this.isEmptyStatusRow(block)) return false;
    const scope = this.activeTurnEl() ?? this.messagesListEl;
    const ordered = Array.from(
      scope.querySelectorAll<HTMLElement>(
        "[data-turn-reasoning='1'], .message-part-text, [data-tool-call-id], .conversation-msg-user",
      ),
    );
    const at = ordered.indexOf(block);
    if (at < 0) return false;
    return ordered
      .slice(at + 1)
      .some((el) => !el.matches("[data-turn-reasoning='1']") && !block.contains(el));
  }

  /**
   * The Thinking block for the current segment. Later iterations append into
   * it until reply text paints below it; then a new block opens.
   */
  private ensureTurnReasoningBlock(options?: {
    pinToBottom?: boolean;
  }): { block: HTMLElement; created: boolean } {
    let block = this.findTurnReasoningBlock();
    if (block && this.hasContentBelowThought(block)) {
      if (this.reasoningMessageId) this.finalizeStreamingReasoning();
      else {
        // A pure status row overtaken by content (tool card / reply text)
        // disappears — the next status update re-opens one below the card.
        if (this.isEmptyStatusRow(block)) block.remove();
        this.resetReasoningStreamState();
      }
      block = null;
    }
    if (block) {
      if (block.dataset.mode !== "streaming") {
        resumeReasoningBlockStreaming(block, this.currentReasoningStats());
      }
      this.settleTurnThought(options?.pinToBottom === true);
      return { block, created: false };
    }

    block = createReasoningBlock({ text: "", mode: "streaming" });
    block.dataset.turnReasoning = "1";
    block.dataset.ephemeral = "1";
    block.dataset.streaming = "1";
    block
      .querySelector(".conversation-reasoning-toggle")
      ?.addEventListener("click", () => {
        if (
          block.classList.contains("is-open") &&
          block.dataset.streaming === "1"
        ) {
          this.flushReasoningPaint();
        }
      });

    let flow = this.activeTurnFlowEl();
    if (!flow) {
      const turn = this.activeTurnEl();
      if (turn) {
        flow = document.createElement("div");
        flow.className = FLOW_CLASS;
        turn.append(flow);
      }
    }
    if (flow) {
      flow.append(block);
      this.settleTurnThought();
    } else {
      this.messagesListEl.append(block);
      this.layoutTurns();
    }
    playCardEnterAnimation(block);
    return { block, created: true };
  }

  private resetReasoningStreamState(): void {
    this.reasoningTextBuffer = "";
    this.reasoningMessageId = null;
    this.reasoningStartedAt = 0;
    this.reasoningPaintQueued = false;
    if (this.reasoningPaintTimer != null) {
      clearTimeout(this.reasoningPaintTimer);
      this.reasoningPaintTimer = null;
    }
    if (this.reasoningRafId != null) {
      cancelAnimationFrame(this.reasoningRafId);
      this.reasoningRafId = null;
    }
    if (this.reasoningBodyScrollRafId != null) {
      cancelAnimationFrame(this.reasoningBodyScrollRafId);
      this.reasoningBodyScrollRafId = null;
    }
    if (this.reasoningMetaTimer != null) {
      clearInterval(this.reasoningMetaTimer);
      this.reasoningMetaTimer = null;
    }
  }

  private currentReasoningStats(): {
    durationMs: number;
    tokenCount: number;
  } {
    const durationMs =
      this.reasoningStartedAt > 0
        ? Math.max(0, Date.now() - this.reasoningStartedAt)
        : 0;
    return {
      durationMs,
      tokenCount: estimateReasoningTokensFromText(this.reasoningTextBuffer),
    };
  }

  private ensureReasoningMetaTicker(): void {
    if (this.reasoningMetaTimer != null) return;
    this.reasoningMetaTimer = setInterval(() => {
      this.refreshReasoningMeta();
    }, 250);
  }

  private refreshReasoningMeta(): void {
    if (!this.reasoningMessageId) return;
    const block = this.findTurnReasoningBlock();
    if (!block || block.dataset.mode !== "streaming") return;
    setReasoningBlockStats(block, this.currentReasoningStats());
  }

  private reasoningPaintIntervalMs(): number {
    // ~+1ms per 400 chars, capped — keeps DOM updates sparse on long CoT.
    return Math.min(
      STREAMING_REASONING_MAX_MS,
      STREAMING_REASONING_MIN_MS +
        Math.floor(this.reasoningTextBuffer.length / 400),
    );
  }

  private scheduleReasoningPaint(): void {
    if (this.reasoningPaintTimer != null || this.reasoningRafId != null) {
      this.reasoningPaintQueued = true;
      return;
    }
    const elapsed = Date.now() - this.lastReasoningPaintAt;
    const delay = Math.max(0, this.reasoningPaintIntervalMs() - elapsed);
    this.reasoningPaintTimer = setTimeout(() => {
      this.reasoningPaintTimer = null;
      this.reasoningRafId = requestAnimationFrame(() => {
        this.reasoningRafId = null;
        this.flushReasoningPaint();
        if (this.reasoningPaintQueued) {
          this.reasoningPaintQueued = false;
          this.scheduleReasoningPaint();
        }
      });
    }, delay);
  }

  private flushReasoningPaint(options?: { full?: boolean }): void {
    if (!this.reasoningMessageId) return;
    this.lastReasoningPaintAt = Date.now();
    const block = this.findTurnReasoningBlock();
    if (!block) return;
    const full = Boolean(options?.full);
    const open = block.classList.contains("is-open");
    // Collapsed streaming: skip body writes (meta still updates). Paint the
    // full buffer once on finalize, or the live tail when the user expands.
    if (full || open) {
      const text = this.reasoningTextBuffer;
      const display =
        !full && text.length > STREAMING_REASONING_TAIL_CHARS
          ? `…\n${text.slice(-STREAMING_REASONING_TAIL_CHARS)}`
          : text;
      setReasoningBlockText(block, display);
      if (open && !full) this.ensureSmoothReasoningBodyScroll(block);
    }
    setReasoningBlockStats(block, this.currentReasoningStats());
  }

  /** Eased chase of the Thinking body scrollbar while CoT is streaming. */
  private ensureSmoothReasoningBodyScroll(block: HTMLElement): void {
    if (this.reasoningBodyScrollRafId != null) return;
    this.reasoningBodyScrollRafId = requestAnimationFrame(() => {
      this.reasoningBodyScrollRafId = null;
      this.tickSmoothReasoningBodyScroll(block);
    });
  }

  private tickSmoothReasoningBodyScroll(block: HTMLElement): void {
    if (!this.autoScroll.following) return;
    if (block.dataset.mode !== "streaming") return;
    // Don't chase while the user has the Thinking body collapsed.
    if (!block.classList.contains("is-open")) return;
    if (
      !this.reasoningMessageId ||
      this.findTurnReasoningBlock() !== block
    ) {
      return;
    }

    const body = block.querySelector<HTMLElement>(
      ".conversation-reasoning-body",
    );
    if (!body) return;

    const target = Math.max(0, body.scrollHeight - body.clientHeight);
    const current = body.scrollTop;
    const remaining = target - current;

    if (remaining <= SCROLL_BOTTOM_SNAP_PX) {
      body.scrollTop = target;
      return;
    }

    // Same exponential ease-out used for the main transcript chase.
    body.scrollTop = current + remaining * SCROLL_BOTTOM_EASE;
    this.ensureSmoothReasoningBodyScroll(block);
  }

  private scheduleStreamingMarkdownPaint(): void {
    if (this.streamingPaintTimer != null || this.streamingRafId != null) {
      this.streamingPaintQueued = true;
      return;
    }

    const elapsed = Date.now() - this.lastStreamingPaintAt;
    const delay = Math.max(0, STREAMING_MARKDOWN_MIN_MS - elapsed);

    this.streamingPaintTimer = setTimeout(() => {
      this.streamingPaintTimer = null;
      this.streamingRafId = requestAnimationFrame(() => {
        this.streamingRafId = null;
        this.paintStreamingMarkdown();
      });
    }, delay);
  }

  private paintStreamingMarkdown(mode: "live" | "final" = "live"): void {
    this.lastStreamingPaintAt = Date.now();
    const messageId = this.streamingMessageId;
    if (!messageId) return;
    const row = this.messagesListEl.querySelector<HTMLElement>(
      `.conversation-msg-assistant[data-message-id="${CSS.escape(messageId)}"]`,
    );
    const container = row?.querySelector<HTMLElement>(".streaming-markdown");
    if (!container || !this.streamingTextBuffer) return;

    try {
      if (mode === "final") {
        // Close dangling fences, then allow SVG cards to render for real.
        const prepared = prepareStreamingMarkdown(this.streamingTextBuffer);
        renderMarkdownText(prepared, container, { streaming: false });
      } else {
        renderMarkdownText(this.streamingTextBuffer, container, {
          streaming: true,
        });
      }
    } catch (err) {
      console.error("[conversation] streaming markdown render failed", err);
      container.replaceChildren();
      container.textContent = this.streamingTextBuffer;
    }

    this.scrollToBottomIfStuck();

    if (this.streamingPaintQueued) {
      this.streamingPaintQueued = false;
      this.scheduleStreamingMarkdownPaint();
    }
  }

  /** Show the just-sent user prompt immediately (before session IPC catches up). */
  appendOptimisticUserMessage(
    text: string,
    attachments: OptimisticAttachmentInput[] = [],
  ): void {
    this.invalidateInFlightMessageRender();
    const trimmed = text.trim();
    const chips = attachments.map(
      (item): AttachmentChipInput => ({
        kind: item.kind,
        uri: item.path,
        mimeType: item.mimeType,
        ...(item.name !== undefined ? { name: item.name } : {}),
        ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}),
      }),
    );
    if (!trimmed && chips.length === 0) return;
    // Count only persisted users — a leftover optimistic row must not inflate
    // the baseline or the next snapshot can never "gain" a user.
    this.userCountBeforePending = this.messagesListEl.querySelectorAll(
      ".conversation-msg-user:not([data-pending-user='1'])",
    ).length;
    this.pendingOptimistic = { text: trimmed, attachments: chips };
    this.mountOptimisticUserRow(this.pendingOptimistic);
  }

  /**
   * Place a user row so it stays *before* Plan / flow in the latest turn when
   * that turn is missing a prompt. If the latest turn already has a user, this
   * is a new turn — append after existing turns (never under that turn's Plan).
   */
  private insertUserRowForCurrentTurn(row: HTMLElement): void {
    const turn = this.activeTurnEl();
    if (turn && !turn.querySelector(".conversation-msg-user")) {
      // Plan/flow landed first (side-path / tool events): prepend user then re-layout.
      turn.insertBefore(row, turn.firstChild);
      this.layoutTurns();
      return;
    }
    this.messagesListEl.append(row);
    this.layoutTurns();
  }

  private mountOptimisticUserRow(pending: PendingOptimisticUser): void {
    this.removeOptimisticUserRow();

    const row = document.createElement("article");
    row.className = "conversation-msg conversation-msg-user";
    row.dataset.pendingUser = "1";

    const body = document.createElement("div");
    body.className = "conversation-msg-body";
    if (pending.text.trim()) {
      const part = document.createElement("div");
      part.className = "message-part message-part-text";
      part.textContent = pending.text.trim();
      body.append(part);
    }
    for (const chip of pending.attachments) {
      body.append(createAttachmentChip(chip));
    }
    applyUserPromptClamp(body);

    row.append(body);
    // Always insert: previous turns often already have a user card — that must
    // not block showing the *new* prompt (regression: prompt missing, only
    // "Planning…" visible, Plan attached to the prior turn).
    this.insertUserRowForCurrentTurn(row);
    playCardEnterAnimation(row);
    this.scrollToBottomIfStuck();
    // A fresh optimistic prompt is (usually) pinned into view — if scrollTop
    // was already at the bottom no scroll event fires, so re-check directly.
    this.checkPromptVisibility();
  }

  private messageMatchesPending(message: {
    role: string;
    parts: Array<Record<string, unknown>>;
  }): boolean {
    const pending = this.pendingOptimistic;
    if (!pending || message.role !== "user") return false;
    const text = message.parts
      .filter(
        (part) => part.type === "text" && typeof part.text === "string",
      )
      .map((part) => part.text as string)
      .join("")
      .trim();
    const pendingText = pending.text.trim();
    if (pendingText) return text === pendingText;
    const attachmentCount = message.parts.filter(
      (part) => part.type === "attachment",
    ).length;
    return attachmentCount > 0;
  }

  /** Inline turn error in the transcript (not the sticky status row). */
  appendTurnErrorMessage(
    text: string,
    retry?: {
      payload: TurnErrorRetryPayload | null;
      onRetry: (payload: TurnErrorRetryPayload) => RetryOutcome;
    },
  ): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.setStatusLine("", false);

    const row = document.createElement("article");
    row.className = "conversation-msg conversation-msg-system";
    row.dataset.turnError = "1";
    row.append(
      createTurnErrorCard({
        text: trimmed,
        retry: retry?.payload ?? null,
        ...(retry?.payload && retry.onRetry
          ? { onRetry: retry.onRetry }
          : {}),
      }),
    );
    this.messagesListEl.append(row);
    this.layoutTurns();
    this.scrollToBottomIfStuck();
  }

  private removeOptimisticUserRow(): void {
    this.messagesListEl
      .querySelector<HTMLElement>(".conversation-msg-user[data-pending-user='1']")
      ?.remove();
  }

  /**
   * Keep create_plan rich cards in sync with rebuilt / live plan snapshots.
   * Used when update_plan / complete_plan run without their own tool cards.
   * Dedupes same createToolCallId (restart + continue can leave an extracted
   * sticky card plus a rebuilt card inside the assistant row).
   */
  syncPlanCards(ctx: Parameters<typeof createMessageView>[1]): void {
    for (const [createId, plan] of ctx.plansByCreateToolCallId) {
      const cards = Array.from(
        this.messagesListEl.querySelectorAll<HTMLElement>(
          `[data-plan-create-tool-call-id="${CSS.escape(createId)}"]`,
        ),
      );
      if (cards.length === 0) continue;
      const existing = cards[0]!;
      for (const extra of cards.slice(1)) extra.remove();
      // Carry the current scroll offset across the rebuild, then ease to the
      // step that just became active so the list never jumps from the top.
      const previousScrollTop = getPlanCardStepsScrollTop(existing);
      const previousStepId = getPlanCardActiveStepId(existing);
      const next = createPlanCard(plan, { autoCenter: false });
      existing.replaceWith(next);
      setPlanCardStepsScrollTop(next, previousScrollTop);
      const stepChanged = getPlanCardActiveStepId(next) !== previousStepId;
      requestAnimationFrame(() => {
        centerPlanCardActiveStep(next, stepChanged ? "smooth" : "auto");
      });
    }
    if (hasUnwrappedPlan(this.messagesListEl)) {
      this.layoutTurns();
    }
  }

  /**
   * Partition transcript into chronological prompt / Plan segments. These are
   * normal-flow append hosts, not scroll-pinned headers.
   */
  private layoutTurns(): void {
    const list = this.messagesListEl;

    for (const turn of Array.from(
      list.querySelectorAll<HTMLElement>(`:scope > .${TURN_CLASS}`),
    )) {
      while (turn.firstChild) {
        list.insertBefore(turn.firstChild, turn);
      }
      turn.remove();
    }

    for (const wrap of Array.from(
      list.querySelectorAll<HTMLElement>(STICKY_UNWRAP_SELECTOR),
    )) {
      const parent = wrap.parentElement;
      if (!parent) continue;
      while (wrap.firstChild) {
        parent.insertBefore(wrap.firstChild, wrap);
      }
      wrap.remove();
    }

    // A live boundary followed by the prompt row (interactive turn whose
    // prompt arrived after the first status row) is redundant. Live orphans
    // between them belong to the prompt's turn.
    for (const boundary of Array.from(
      list.querySelectorAll<HTMLElement>(`:scope > .${TURN_BOUNDARY_CLASS}[data-live='1']`),
    )) {
      const live: Element[] = [];
      let next = boundary.nextElementSibling;
      while (next && !isTurnStartRow(next) && next.matches(LIVE_TURN_ORPHAN_SELECTOR)) {
        live.push(next);
        next = next.nextElementSibling;
      }
      if (next && isTurnStartRow(next) && !next.classList.contains(TURN_BOUNDARY_CLASS)) {
        boundary.remove();
        next.after(...live);
      }
    }

    let index = 0;
    while (index < list.children.length) {
      const el = list.children[index] as HTMLElement;
      const isBoundary = el.classList.contains(TURN_BOUNDARY_CLASS);
      if (!isBoundary && !el.classList.contains("conversation-msg-user")) {
        index += 1;
        continue;
      }

      // Streaming / tools sometimes land as top-level orphans *before* the user
      // row (e.g. append to list when no turn flow yet, then user reconciled at
      // end). Pull them into this turn *after* the user so the prompt is not
      // sandwiched in the middle of the stream.
      // Only in-flight rows qualify: a settled row above the prompt belongs to
      // an earlier turn (CoCo wake greetings / plan-ready notices) and sweeping
      // it below hoisted the new prompt to the very top of the transcript.
      const orphansBefore: HTMLElement[] = [];
      let back = isBoundary ? -1 : index - 1;
      while (back >= 0) {
        const prev = list.children[back] as HTMLElement;
        if (prev.classList.contains(TURN_CLASS)) break;
        if (prev.classList.contains("conversation-msg-user")) break;
        if (prev.classList.contains(TURN_BOUNDARY_CLASS)) break;
        // Clear/compaction dividers are transcript boundaries — they must
        // stay above the turn, never be swept below the prompt they precede
        // (/clear regression: new prompt rendered above the divider).
        if (prev.classList.contains("conversation-msg-compaction")) break;
        // Load-earlier sentinel is a transcript boundary too — always top.
        if (prev.classList.contains(LOAD_EARLIER_CLASS)) break;
        if (!prev.matches(LIVE_TURN_ORPHAN_SELECTOR)) break;
        orphansBefore.unshift(prev);
        back -= 1;
      }

      const toMove: HTMLElement[] = [];
      let look = index + 1;
      while (look < list.children.length) {
        const next = list.children[look] as HTMLElement;
        // Same grouping as splitMessagesIntoTurns: inserted prompts belong to
        // this turn. Otherwise finalizeTurn rebuilds the whole logical turn
        // into only its last prompt container and leaves duplicate rows above.
        if (isTurnStartRow(next)) break;
        toMove.push(next);
        look += 1;
      }

      const rawNodes: HTMLElement[] = [el, ...orphansBefore, ...toMove];
      const insertIndex = index - orphansBefore.length;
      for (const node of rawNodes) node.remove();

      const nodes = extractPlanCardsToSiblings(rawNodes);
      const turn = document.createElement("div");
      turn.className = TURN_CLASS;
      for (const child of buildStickySegments(nodes)) {
        turn.append(child);
      }

      const anchor = list.children[insertIndex] as HTMLElement | undefined;
      if (anchor) list.insertBefore(turn, anchor);
      else list.append(turn);

      index = insertIndex + 1;
    }

    const turns = Array.from(
      list.querySelectorAll<HTMLElement>(`:scope > .${TURN_CLASS}`),
    );
    turns.forEach((turn, i) => {
      turn.classList.toggle(LATEST_TURN_CLASS, i === turns.length - 1);
    });
    this.settleTurnThought();
    // Structural relayout moves rows — re-derive prompt visibility.
    this.checkPromptVisibility();
  }

  /**
   * A turn just started that may have no user prompt (CoCo automatic /
   * hand-over). Its first live row opens a new turn when the latest one is
   * already settled — otherwise it would paint under that turn's footer.
   */
  expectTurnWithoutPrompt(): void {
    this.pendingTurnBoundary = true;
  }

  private openPendingTurnBoundary(): void {
    if (!this.pendingTurnBoundary) return;
    this.pendingTurnBoundary = false;
    const list = this.messagesListEl;
    const turn = this.activeTurnEl();
    const settled = turn
      ? turn.querySelector(".turn-ended") !== null
      : list.lastElementChild?.matches(".turn-ended, .turn-modified-files") === true;
    if (!settled) return;
    const boundary = createTurnBoundaryRow();
    boundary.dataset.live = "1";
    list.append(boundary);
    this.layoutTurns();
  }

  /** Latest turn — host for streaming / tool appends. */
  private activeTurnEl(): HTMLElement | null {
    return (
      this.messagesListEl.querySelector<HTMLElement>(
        `:scope > .${TURN_CLASS}.${LATEST_TURN_CLASS}`,
      ) ??
      this.messagesListEl.querySelector<HTMLElement>(
        `:scope > .${TURN_CLASS}:last-of-type`,
      )
    );
  }

  /**
   * Flow after the latest segment (Plan if present, else User).
   * Must not reuse an earlier segment's flow — that puts stream text above
   * the Plan instead of after it.
   */
  private activeTurnFlowEl(): HTMLElement | null {
    this.openPendingTurnBoundary();
    const turn = this.activeTurnEl();
    if (!turn) return null;

    const lastSeg = turn.querySelector<HTMLElement>(
      `:scope > .${STICKY_SEGMENT_CLASS}:last-of-type`,
    );
    if (lastSeg) {
      let flow = lastSeg.querySelector<HTMLElement>(`:scope > .${FLOW_CLASS}`);
      if (!flow) {
        flow = document.createElement("div");
        flow.className = FLOW_CLASS;
        lastSeg.append(flow);
      }
      return flow;
    }

    const flows = turn.querySelectorAll<HTMLElement>(`:scope > .${FLOW_CLASS}`);
    if (flows.length > 0) return flows[flows.length - 1]!;
    const flow = document.createElement("div");
    flow.className = FLOW_CLASS;
    turn.append(flow);
    return flow;
  }

  /** Body where finished tool cards for a message should append. */
  private findToolAppendBody(messageId: string): HTMLElement | null {
    const turn =
      this.findMessageRow(messageId)?.closest<HTMLElement>(`.${TURN_CLASS}`) ??
      this.activeTurnEl();
    const lastSeg = turn?.querySelector<HTMLElement>(
      `:scope > .${STICKY_SEGMENT_CLASS}:last-of-type`,
    );

    if (lastSeg) {
      const contInSeg = lastSeg.querySelectorAll<HTMLElement>(
        `.conversation-msg[data-message-continuation="${CSS.escape(messageId)}"] .conversation-msg-body`,
      );
      if (contInSeg.length > 0) return contInSeg[contInSeg.length - 1]!;

      const mainInSeg = lastSeg.querySelector<HTMLElement>(
        `.conversation-msg[data-message-id="${CSS.escape(messageId)}"] .conversation-msg-body`,
      );
      if (mainInSeg) return mainInSeg;

      const flow = this.activeTurnFlowEl();
      if (!flow) return null;
      const cont = document.createElement("article");
      cont.className = "conversation-msg conversation-msg-assistant";
      cont.dataset.messageContinuation = messageId;
      const body = document.createElement("div");
      body.className = "conversation-msg-body";
      cont.append(body);
      flow.append(cont);
      return body;
    }

    const continuations = this.messagesListEl.querySelectorAll<HTMLElement>(
      `.conversation-msg[data-message-continuation="${CSS.escape(messageId)}"] .conversation-msg-body`,
    );
    if (continuations.length > 0) {
      return continuations[continuations.length - 1]!;
    }

    return (
      this.findMessageRow(messageId)?.querySelector<HTMLElement>(
        ".conversation-msg-body",
      ) ?? null
    );
  }

  private findMessageRow(messageId: string | undefined): HTMLElement | null {
    if (!messageId) return null;
    return this.messagesListEl.querySelector<HTMLElement>(
      `.conversation-msg[data-message-id="${CSS.escape(messageId)}"]`,
    );
  }

  /** Replace the optimistic user row in place with its persisted message. */
  reconcileUserMessage(
    userMessage: {
      id?: string;
      role: string;
      parts: Array<Record<string, unknown>>;
    },
    ctx: Parameters<typeof createMessageView>[1],
  ): void {
    if (userMessage.role !== "user") return;

    // While a send is in flight, ignore reconciles for *already-rendered*
    // users that are not this send (assistantSliceRefresh often sees the
    // previous turn's user first). Do not require text match — hooks may
    // rewrite the prompt before persist.
    if (
      this.pendingOptimistic &&
      !this.messageMatchesPending(userMessage) &&
      this.findMessageRow(userMessage.id)
    ) {
      return;
    }

    if (this.findMessageRow(userMessage.id)) {
      if (
        this.pendingOptimistic &&
        this.messageMatchesPending(userMessage)
      ) {
        this.removeOptimisticUserRow();
        this.pendingOptimistic = null;
      } else if (!this.pendingOptimistic) {
        this.removeOptimisticUserRow();
      }
      return;
    }

    const next = createMessageView(userMessage, ctx);
    if (!next) return;
    const optimistic = this.messagesListEl.querySelector<HTMLElement>(
      ".conversation-msg-user[data-pending-user='1']",
    );
    if (optimistic) {
      // New persisted user (exact or hook-rewritten) — swap in place.
      optimistic.replaceWith(next);
      this.pendingOptimistic = null;
      this.applyUserPromptReclaimability();
      return;
    }

    // No optimistic row: still must land *before* any Plan already in the
    // latest turn (side-path create_plan can arrive first via tool/plan events).
    this.insertUserRowForCurrentTurn(next);
    playCardEnterAnimation(next);
    this.pendingOptimistic = null;
    this.applyUserPromptReclaimability();
  }

  // ------------------------------------------------ running-prompt reclaim

  /** Controller pushes the latest snapshot; re-applies card reclaimability. */
  setUserPromptReclaimability(
    messages: Array<{
      id?: string;
      role: string;
      parts: Array<Record<string, unknown>>;
    }>,
    status: string,
  ): void {
    this.userPromptReclaimability = { messages, status };
    this.applyUserPromptReclaimability();
  }

  /**
   * Repaint the reclaim affordance on user cards. Called after every
   * transcript repaint (full or reconciled): the DOM was rebuilt, so the
   * clickability state must be re-derived from the latest snapshot.
   */
  private applyUserPromptReclaimability(): void {
    const snapshot = this.userPromptReclaimability;
    const reclaimableId =
      this.onReclaimUserPrompt && snapshot
        ? reclaimableUserMessageId(snapshot.messages, snapshot.status)
        : null;

    for (const row of this.messagesListEl.querySelectorAll<HTMLElement>(
      ".conversation-msg-user",
    )) {
      row.classList.toggle(
        "is-reclaimable-prompt",
        row.dataset.messageId === reclaimableId &&
          row.dataset.pendingUser !== "1",
      );
    }
  }

  /**
   * Click anywhere on the running turn's still-rollback-eligible prompt card
   * stops the turn (STOP-rollback then hands the prompt back to the
   * composer). Interactive descendants (clamp toggle, links) keep their own
   * behavior.
   */
  private handlePromptReclaimClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("button, a, textarea, input")) return;
    const row = target.closest<HTMLElement>(".conversation-msg-user");
    if (!row) return;
    if (!row.classList.contains("is-reclaimable-prompt")) return;
    event.preventDefault();
    this.onReclaimUserPrompt?.();
  }

  /** Preserve collapse before rendering replacements, so hidden bodies never get built. */
  private preserveCollapsedToolCards(
    ctx: Parameters<typeof createMessageView>[1],
  ): Parameters<typeof createMessageView>[1] {
    const collapsed = new Set(ctx.initiallyCollapsedToolCallIds);
    for (const slot of this.messagesListEl.querySelectorAll<HTMLElement>(`.${VIRTUAL_TOOL_CARD_CLASS}`)) {
      const id = slot.dataset.toolCallId;
      if (id && getVirtualToolCardOpen(slot) === false) collapsed.add(id);
    }
    return { ...ctx, initiallyCollapsedToolCallIds: collapsed };
  }

  private patchToolCardsInPlace(
    currentRow: HTMLElement,
    nextRow: HTMLElement,
  ): boolean {
    if (currentRow.dataset.streaming === "1") return false;

    const nextCards = Array.from(
      nextRow.querySelectorAll<HTMLElement>("[data-tool-call-id]"),
    );
    const currentBody =
      currentRow.querySelector<HTMLElement>(".conversation-msg-body");
    if (!currentBody) return false;

    if (nextRow.querySelector(".content-card-hosted-tool, .response-references")) {
      // A local-card-only patch would discard hosted status changes and
      // annotated text in mixed responses. Rebuild while retaining live
      // write previews whose call is not yet in the persisted snapshot.
      const nextBody = nextRow.querySelector<HTMLElement>(".conversation-msg-body");
      if (nextBody) {
        for (const streaming of Array.from(
          currentBody.querySelectorAll<HTMLElement>("[data-tool-streaming='1']"),
        )) {
          const callId = streaming.dataset.toolCallId;
          const replacement = callId ? nextBody.querySelector<HTMLElement>(
            `[data-tool-call-id="${CSS.escape(callId)}"]`,
          ) : null;
          if (replacement) replacement.replaceWith(streaming);
          else nextBody.append(streaming);
        }
      }
      return false;
    }

    if (nextCards.length === 0) {
      // Keep ephemeral write_file previews that are not in the session snapshot yet.
      return Boolean(currentBody.querySelector("[data-tool-streaming='1']"));
    }

    const replacedIds = new Set<string>();
    for (const nextCard of nextCards) {
      const callId = nextCard.dataset.toolCallId;
      if (!callId) continue;
      replacedIds.add(callId);
      const currentCard = currentRow.querySelector<HTMLElement>(
        `[data-tool-call-id="${CSS.escape(callId)}"]`,
      );
      if (currentCard) {
        // Keep live write_file / patch previews — the session snapshot
        // card is not streaming-aware and would clobber partial content.
        if (currentCard.dataset.toolStreaming === "1") continue;
        // Preserve the live spinner node so CSS animation keeps running across
        // assistant-row rebuilds while the subagent is still in progress.
        this.preserveSubagentSpinner(currentCard, nextCard);
        // A badge mid-hold (armed, not yet faded) must survive the snapshot
        // replace — a fresh dormant badge would cut the 3s hold short.
        this.preserveLiveOutcomeMark(
          currentCard,
          nextCard,
          ".content-card-tool-outcome.is-ok:not(.is-dormant):not(.is-faded)",
        );
        this.preserveLiveOutcomeMark(
          currentCard,
          nextCard,
          ".content-card-subagent-status-icon.is-completed:not(.is-dormant):not(.is-faded)",
        );
        transferVirtualToolCardState(currentCard, nextCard);
        currentCard.replaceWith(nextCard);
      } else {
        currentBody.append(nextCard);
        playCardEnterAnimation(nextCard);
      }
    }

    // Preserve in-flight streaming previews that the snapshot has not caught up to.
    for (const streaming of Array.from(
      currentBody.querySelectorAll<HTMLElement>("[data-tool-streaming='1']"),
    )) {
      const callId = streaming.dataset.toolCallId;
      if (callId && replacedIds.has(callId)) continue;
      // Already in currentBody — leave as-is.
    }
    return true;
  }

  /** Move an in-progress spinner SVG onto the replacement card (keeps animation). */
  private preserveSubagentSpinner(
    currentCard: HTMLElement,
    nextCard: HTMLElement,
  ): void {
    if (currentCard.dataset.toolName !== "dispatch_subagent") return;
    if (nextCard.dataset.toolName !== "dispatch_subagent") return;
    const currentIcon = currentCard.querySelector<SVGElement>(
      ".content-card-subagent-status-icon.is-in-progress",
    );
    const nextIcon = nextCard.querySelector<SVGElement>(
      ".content-card-subagent-status-icon.is-in-progress",
    );
    if (!currentIcon || !nextIcon) return;
    nextIcon.replaceWith(currentIcon);
  }

  /**
   * Carry a held success mark (armed, still inside its 3s window) onto the
   * snapshot replacement card. Already-faded marks need nothing — the fresh
   * dormant badge is equally invisible. Armed Patch failures are preserved
   * earlier as whole cards; other failure marks are re-rendered as-is.
   */
  private preserveLiveOutcomeMark(
    currentCard: HTMLElement,
    nextCard: HTMLElement,
    selector: string,
  ): void {
    const held = currentCard.querySelector<HTMLElement>(selector);
    if (!held) return;
    const base = selector.slice(0, selector.indexOf(":not("));
    const fresh = nextCard.querySelector<HTMLElement>(base);
    fresh?.replaceWith(held);
  }

  /**
   * Ephemeral "Commit complete" card shown after a git commit. Not persisted
   * into the session transcript — the next full renderMessages rebuild (from
   * persisted messages) drops it, and nothing in the session data refers to it.
   */
  appendCommitCard(created: {
    hash: string;
    shortHash: string;
    message: string;
    subject: string;
    vcs?: "git" | "svn";
  }, messageSource?: "llm" | "fallback"): void {
    const shortHash = created.shortHash || created.hash || "(unknown)";

    const card = document.createElement("details");
    card.className =
      "content-card content-card-tool-invocation content-card-tool-done is-success";
    card.dataset.ephemeralCommit = "1";
    card.open = true;

    const summary = document.createElement("summary");
    summary.className = "content-card-tool-result-summary";

    const left = document.createElement("div");
    left.className = "content-card-tool-result-left";

    const icon = createLucideIcon(GitCommitHorizontal, { size: 15 });
    icon.classList.add("content-card-tool-icon");

    const name = document.createElement("span");
    name.className = "content-card-tool-name";
    name.textContent = "Commit complete";

    left.append(icon, name);

    const hint = document.createElement("span");
    hint.className = "content-card-tool-result-hint";
    hint.textContent = created.subject
      ? `${shortHash} · ${created.subject}`
      : shortHash;
    hint.title = created.message;
    left.append(hint);

    const right = document.createElement("div");
    right.className = "content-card-tool-result-right";
    right.append(
      createToolOutcomeBadge({ ok: true, tip: "Commit created" }),
      createLucideIcon(ChevronDown, { size: 14 }),
    );
    (right.lastElementChild as SVGElement).classList.add(
      "content-card-tool-result-chevron",
    );

    summary.append(left, right);
    card.append(summary);
    // Ephemeral live card — arm the success badge fade straight away
    // (after the badge is inside the card subtree).
    armLiveOutcomeFade(card);

    const body = document.createElement("div");
    body.className = "content-card-tool-invocation-body";

    const section = document.createElement("section");
    section.className =
      "content-card-tool-section content-card-tool-section-output";

    const meta = document.createElement("div");
    meta.className = "content-card-commit-meta";
    const hashLine = document.createElement("div");
    hashLine.className = "content-card-commit-hash";
    hashLine.textContent =
      created.vcs === "svn"
        ? `revision ${created.hash || shortHash}`
        : created.hash
          ? `commit ${created.hash}`
          : shortHash;
    const msg = document.createElement("div");
    msg.className = "content-card-commit-message";
    msg.textContent = created.message;
    meta.append(hashLine, msg);
    if (messageSource === "fallback") {
      const src = document.createElement("div");
      src.className = "content-card-commit-source";
      src.textContent =
        "AI message generation failed — used a placeholder. Amend the commit if the description matters.";
      meta.append(src);
    }
    section.append(meta);
    body.append(section);
    card.append(body);

    this.messagesListEl.append(card);
    playCardEnterAnimation(card);
    this.scrollToBottomIfStuck();
  }

  /**
   * Live running run_shell card rendered at the `tool_call` stream event, so
   * the spinner + stop button show while the command executes. Replaced by
   * {@link upsertFinishedToolCard} when the result arrives.
   */
  upsertRunningToolCard(input: {
    assistantMessageId: string;
    toolCallId: string;
    name?: string;
    arguments: unknown;
    argumentsRaw: string;
    onAbortToolCall?: (toolCallId: string) => void;
  }): void {
    // Hidden card: skip creation; also drop any card painted before the
    // toggle landed so no stale spinner lingers until the finish event.
    if (!isConversationCardVisible(input.name ?? SHELL_TOOL_NAME, input.arguments)) {
      this.removeToolCardByCallId(input.toolCallId);
      return;
    }
    // Sleep countdown seed: stamp the wait at tool_call time so the local
    // RAF countdown tracks the actual command start (zero main events).
    const sleepInfo = sleepInfoFromArgs(input.arguments);
    const card = createToolInvocationCard({
      id: input.toolCallId,
      name: input.name ?? SHELL_TOOL_NAME,
      status: "running",
      arguments: input.arguments,
      argumentsRaw: input.argumentsRaw,
      ...(sleepInfo
        ? {
            sleepLive: {
              startedAt: Date.now(),
              seconds: sleepInfo.seconds,
              hasFollowUp: sleepInfo.hasFollowUp,
            },
          }
        : {}),
      ...(input.onAbortToolCall
        ? { onAbortToolCall: input.onAbortToolCall }
        : {}),
    });
    card.dataset.toolCallId = input.toolCallId;

    const existing = this.messagesListEl.querySelector<HTMLElement>(
      `[data-tool-call-id="${CSS.escape(input.toolCallId)}"]`,
    );
    if (existing) {
      existing.replaceWith(card);
    } else {
      let body = this.findToolAppendBody(input.assistantMessageId);
      if (!body) {
        const assistantRow = document.createElement("article");
        assistantRow.className = "conversation-msg conversation-msg-assistant";
        assistantRow.dataset.messageId = input.assistantMessageId;
        body = document.createElement("div");
        body.className = "conversation-msg-body";
        assistantRow.append(body);
        const flow = this.activeTurnFlowEl();
        if (flow) flow.append(assistantRow);
        else this.messagesListEl.append(assistantRow);
      }
      body.append(card);
      this.settleTurnThought();
      playCardEnterAnimation(card);
    }

    if (!card.closest(`.${TURN_CLASS}`) || hasUnwrappedPlan(this.messagesListEl)) {
      this.layoutTurns();
    }
    this.scrollToBottomIfStuck();
  }

  /**
   * Patch the live upload zone of a running run_shell card from a tool_live
   * "upload" snapshot. No-op when the card is absent (hidden cards, finished
   * replacements) or has no zone — snapshots are throttled upstream (~8/s).
   */
  updateUploadLiveCard(toolCallId: string, state: UploadLiveState): void {
    const card = this.messagesListEl.querySelector<HTMLElement>(
      `[data-tool-call-id="${CSS.escape(toolCallId)}"]`,
    );
    const zone = card?.querySelector<HTMLElement>(".content-card-tool-upload-zone");
    if (!zone) return;
    patchUploadLiveZone(zone, state);
  }

  /**
   * Live generate_image card rendered at the `tool_call` stream event: a
   * sized placeholder (aspect ratio from the `size` argument) with a
   * generating label, so the card shows while the request is in flight.
   * Replaced by {@link upsertFinishedToolCard} when the image arrives.
   */
  upsertRunningImageCard(input: {
    assistantMessageId: string;
    toolCallId: string;
    name?: string;
    arguments: unknown;
  }): void {
    // Hidden card: skip creation; also drop any card painted before the
    // toggle landed so no stale placeholder lingers until the finish event.
    if (!isConversationCardVisible(input.name ?? "generate_image", input.arguments)) {
      this.removeToolCardByCallId(input.toolCallId);
      return;
    }
    const card = createDisplayImageCard({
      arguments: input.arguments,
      pendingLabel: "Generating image…",
      title: "Generate Image",
    });
    card.dataset.toolCallId = input.toolCallId;

    const existing = this.messagesListEl.querySelector<HTMLElement>(
      `[data-tool-call-id="${CSS.escape(input.toolCallId)}"]`,
    );
    if (existing) {
      existing.replaceWith(card);
    } else {
      let body = this.findToolAppendBody(input.assistantMessageId);
      if (!body) {
        const assistantRow = document.createElement("article");
        assistantRow.className = "conversation-msg conversation-msg-assistant";
        assistantRow.dataset.messageId = input.assistantMessageId;
        body = document.createElement("div");
        body.className = "conversation-msg-body";
        assistantRow.append(body);
        const flow = this.activeTurnFlowEl();
        if (flow) flow.append(assistantRow);
        else this.messagesListEl.append(assistantRow);
      }
      body.append(card);
      this.settleTurnThought();
      playCardEnterAnimation(card);
    }

    if (!card.closest(`.${TURN_CLASS}`) || hasUnwrappedPlan(this.messagesListEl)) {
      this.layoutTurns();
    }
    this.scrollToBottomIfStuck();
  }

  /**
   * Live write_file / patch card while tool arguments stream in. Replaced by
   * {@link upsertFinishedToolCard} when execution finishes.
   */
  upsertStreamingWriteCard(input: {
    assistantMessageId: string;
    toolCallId: string;
    name?: string;
    argumentsRaw: string;
    arguments: unknown;
    status?: string;
    previewContent: string;
  }): void {
    // Keep the real tool name when known (write_plan_doc has its own card);
    // unknown/partial names fall back to write_file while still streaming in.
    const KNOWN_STREAMING_WRITE_NAMES = new Set([
      "write_file",
      "patch",
      "write_plan_doc",
    ]);
    const name =
      input.name && KNOWN_STREAMING_WRITE_NAMES.has(input.name)
        ? input.name
        : "write_file";

    let isNewCard = false;
    const existing = this.messagesListEl.querySelector<HTMLElement>(
      `[data-tool-call-id="${CSS.escape(input.toolCallId)}"]`,
    );

    // Same card shape as the last chunk: patch the preview in place so the
    // scroll container (and its scrollbar) survives the update.
    if (existing) {
      const preview = existing.querySelector<HTMLElement>(".tool-file-lines");
      const followPreview = this.autoScroll.following && (preview ? isScrolledToBottom(preview) : true);
      const patched = updateStreamingWritePreviewCard(existing, {
        name,
        arguments: input.arguments,
        argumentsRaw: input.argumentsRaw,
        previewContent: input.previewContent,
      });
      if (patched) {
        if (followPreview) this.scrollStreamingWritePreviewToBottom(existing);
        this.scrollToBottomIfStuck();
        return;
      }
    }

    const card = createToolInvocationCard({
      id: input.toolCallId,
      name,
      status: input.status ?? "pending",
      arguments: input.arguments,
      argumentsRaw: input.argumentsRaw,
      previewContent: input.previewContent,
      initiallyCollapsed: existing ? getVirtualToolCardOpen(existing) === false : false,
    });
    card.dataset.toolCallId = input.toolCallId;
    card.dataset.toolStreaming = "1";

    if (existing) {
      // wasOpen=null when the old card was a compact div (e.g. a running
      // run_shell card): keep the new card's own default expand state
      // instead of forcing it open. Real <details> cards (streamed write
      // previews) carry their open state across the replace.
      const wasOpen = getVirtualToolCardOpen(existing);
      transferVirtualToolCardState(existing, card);
      existing.replaceWith(card);
      if (wasOpen !== null) setVirtualToolCardOpen(card, wasOpen);
    } else {
      let body = this.findToolAppendBody(input.assistantMessageId);
      if (!body) {
        const assistantRow = document.createElement("article");
        assistantRow.className = "conversation-msg conversation-msg-assistant";
        assistantRow.dataset.messageId = input.assistantMessageId;
        body = document.createElement("div");
        body.className = "conversation-msg-body";
        assistantRow.append(body);
        const flow = this.activeTurnFlowEl();
        if (flow) flow.append(assistantRow);
        else this.messagesListEl.append(assistantRow);
      }
      body.append(card);
      this.settleTurnThought();
      isNewCard = true;
    }

    if (!card.closest(`.${TURN_CLASS}`) || hasUnwrappedPlan(this.messagesListEl)) {
      this.layoutTurns();
    }
    if (isNewCard) playCardEnterAnimation(card);
    this.scrollStreamingWritePreviewToBottom(card);
    this.scrollToBottomIfStuck();
  }

  /** Keep the lined-file preview pinned to the latest streamed lines. */
  private scrollStreamingWritePreviewToBottom(card: HTMLElement): void {
    const lines = card.querySelector<HTMLElement>(".tool-file-lines");
    if (!lines) return;
    const pin = () => {
      if (!this.autoScroll.following) return;
      lines.scrollTop = lines.scrollHeight;
    };
    pin();
    // Layout after replace may land after this frame — pin again once settled.
    requestAnimationFrame(pin);
  }

  /**
   * Scroll offset of a streaming lined write preview, captured right before
   * the finish replace. Null when the preview is not internally scrollable
   * (short file) or is markdown (grows in place, nothing to preserve).
   */
  private captureWritePreviewScroll(
    card: HTMLElement,
  ): { top: number } | null {
    const lines = card.querySelector<HTMLElement>(".tool-file-lines");
    if (!lines || lines.scrollHeight <= lines.clientHeight) return null;
    return { top: lines.scrollTop };
  }

  /** Re-apply a captured offset onto the finished card's lined view. */
  private restoreWritePreviewScroll(
    card: HTMLElement,
    prev: { top: number },
  ): void {
    const apply = () => {
      const lines = card.querySelector<HTMLElement>(".tool-file-lines");
      if (!lines) return;
      lines.scrollTop = Math.min(
        prev.top,
        Math.max(lines.scrollHeight - lines.clientHeight, 0),
      );
    };
    apply();
    // Layout after replace may land after this frame — re-apply once settled.
    requestAnimationFrame(apply);
  }

  /** Retarget a streaming tool card when the provider upgrades pending-N → real id. */
  retargetToolCardId(fromId: string, toId: string): void {
    if (fromId === toId) return;
    const card = this.messagesListEl.querySelector<HTMLElement>(
      `[data-tool-call-id="${CSS.escape(fromId)}"]`,
    );
    if (!card) return;
    card.dataset.toolCallId = toId;
  }

  /**
   * Drop any card (streaming or finished) for a tool call id. Used when a
   * card becomes hidden: the tool still ran — only the card disappears.
   */
  removeToolCardByCallId(toolCallId: string): void {
    const card = this.messagesListEl.querySelector<HTMLElement>(
      `[data-tool-call-id="${CSS.escape(toolCallId)}"]`,
    );
    if (!card) return;
    const body = card.closest<HTMLElement>(".conversation-msg-body");
    const row = card.closest<HTMLElement>(".conversation-msg");
    card.remove();
    // Clean up the empty assistant row the card was keeping alive.
    if (body && body.childElementCount === 0 && row) {
      row.remove();
    }
  }

  /**
   * Patch a dispatch_subagent card in place (any assistant message).
   * Live status/context updates must not rely on refreshing only the last
   * assistant row — dispatch cards often live in earlier model iterations.
   */
  updateSubagentDispatchCard(
    toolCallId: string,
    update: { status: SubagentStatusKind; usedTokens?: number },
  ): boolean {
    const card = this.messagesListEl.querySelector<HTMLElement>(
      `[data-tool-call-id="${CSS.escape(toolCallId)}"]`,
    );
    if (!card || card.dataset.toolName !== "dispatch_subagent") return false;

    const right = card.querySelector<HTMLElement>(
      ".content-card-tool-result-right",
    );
    if (!right) return false;

    if (typeof update.usedTokens === "number" && update.usedTokens > 0) {
      const label = formatTokenCount(update.usedTokens);
      let ctxEl = right.querySelector<HTMLElement>(
        ".content-card-subagent-context",
      );
      if (!ctxEl) {
        ctxEl = document.createElement("span");
        ctxEl.className = "content-card-subagent-context";
        const statusIcon = right.querySelector(
          ".content-card-subagent-status-icon",
        );
        if (statusIcon) right.insertBefore(ctxEl, statusIcon);
        else right.append(ctxEl);
      }
      ctxEl.textContent = label;
      ctxEl.title = `${label} context used`;
    }

    // Keep the same spinner node while still in progress so CSS animation
    // is not restarted on every context/progress tick.
    const nextKind = subagentStatusVisualKind(update.status);
    const prevIcon = right.querySelector<SVGElement>(
      ".content-card-subagent-status-icon",
    );
    const prevKind = prevIcon?.dataset.statusKind;
    if (prevKind === nextKind && prevIcon) {
      return true;
    }

    const nextIcon = createSubagentStatusIcon(update.status);
    if (nextIcon && prevIcon) {
      prevIcon.replaceWith(nextIcon);
    } else if (nextIcon && !prevIcon) {
      right.append(nextIcon);
    } else if (!nextIcon && prevIcon) {
      prevIcon.remove();
    }
    return true;
  }

  /**
   * Insert an assistant message once, then update that exact message in place.
   * New model iterations append after all earlier text and tool cards.
   * Awaits Mermaid cards so the conversation stays ordered.
   */
  async upsertAssistantMessage(
    assistantMessage: {
      id?: string;
      role: string;
      parts: Array<Record<string, unknown>>;
    },
    ctx: Parameters<typeof createMessageView>[1],
  ): Promise<boolean> {
    ctx = this.preserveCollapsedToolCards(ctx);
    const askingBefore = ConversationView.askingCallIds(this.messagesListEl);
    const planCreateIds = assistantMessage.parts.flatMap((part) => {
      if (part.type !== "tool_call" || part.name !== "create_plan") return [];
      return typeof part.id === "string" && part.id ? [part.id] : [];
    });
    const existingAssistant = this.findMessageRow(assistantMessage.id);
    // Plan cards are extracted into sticky siblings. Rebuilding this assistant
    // row would insert a second card unless we drop the orphaned sticky copies.
    for (const createId of planCreateIds) {
      for (const card of Array.from(
        this.messagesListEl.querySelectorAll<HTMLElement>(
          `[data-plan-create-tool-call-id="${CSS.escape(createId)}"]`,
        ),
      )) {
        if (!existingAssistant?.contains(card)) card.remove();
      }
    }

    this.syncPlanCards(ctx);

    const projected = projectAssistantMessage(assistantMessage);
    const partsForView = projected.parts;

    const needsMermaid = partsForView.some(
      (part) =>
        part.type === "text" &&
        typeof part.text === "string" &&
        /```mermaid\b/i.test(part.text),
    );
    if (needsMermaid) {
      this.setStatusLine("Rendering Mermaid diagram…", true);
    }

    let nextAssistant: HTMLElement | null;
    try {
      nextAssistant = await createMessageViewAsync(
        { ...assistantMessage, parts: partsForView },
        ctx,
      );
    } finally {
      // Running turns keep their own progress; idle is handled by refresh metadata.
    }

    if (!nextAssistant) {
      if (partsForView.length === 0) existingAssistant?.remove();
      this.layoutTurns();
      this.scrollToBottomIfStuck();
      return false;
    }

    if (existingAssistant) {
      if (!this.patchToolCardsInPlace(existingAssistant, nextAssistant)) {
        existingAssistant.replaceWith(nextAssistant);
      }
      const row = this.findMessageRow(assistantMessage.id);
      if (!row?.closest(`.${TURN_CLASS}`) || hasUnwrappedPlan(this.messagesListEl)) {
        this.layoutTurns();
      }
    } else if (this.replaceContinuationRows(assistantMessage.id, nextAssistant)) {
      if (
        !nextAssistant.closest(`.${TURN_CLASS}`) ||
        hasUnwrappedPlan(this.messagesListEl)
      ) {
        this.layoutTurns();
      }
    } else {
      this.ensureCurrentTurnUserCard();
      const flow = this.activeTurnFlowEl();
      if (flow) {
        flow.append(nextAssistant);
        if (hasUnwrappedPlan(this.messagesListEl)) this.layoutTurns();
      } else {
        this.messagesListEl.append(nextAssistant);
        this.layoutTurns();
      }
      for (const card of nextAssistant.querySelectorAll<HTMLElement>(
        "[data-tool-call-id]",
      )) {
        playCardEnterAnimation(card);
      }
    }

    this.settleTurnThought();
    if (!this.revealNewAskCard(askingBefore)) this.scrollToBottomIfStuck();
    return true;
  }

  /**
   * A message whose only paint came from finished tool cards lives in
   * continuation rows, not a `data-message-id` row (e.g. the synthetic
   * create_plan pair from plan Approve: no text/reasoning stream ever opened a
   * main row). Swap those rows for the full render instead of appending a
   * second copy of the same parts.
   */
  private replaceContinuationRows(
    messageId: string | undefined,
    nextAssistant: HTMLElement,
  ): boolean {
    if (!messageId) return false;
    const rows = Array.from(
      this.messagesListEl.querySelectorAll<HTMLElement>(
        `.conversation-msg[data-message-continuation="${CSS.escape(messageId)}"]`,
      ),
    );
    const last = rows.pop();
    if (!last) return false;
    for (const row of rows) row.remove();
    last.replaceWith(nextAssistant);
    return true;
  }

  /** Append one completed tool card, or update that same card in place. */
  upsertFinishedToolCard(
    assistantMessageId: string,
    toolCallId: string,
    toolPart: Record<string, unknown>,
    ctx: Parameters<typeof createMessageView>[1],
  ): boolean {
    ctx = this.preserveCollapsedToolCards(ctx);
    const toolName = unwrapToolCallBridge(
      typeof toolPart.name === "string" ? toolPart.name : "",
      toolPart.arguments,
    ).name;
    if (toolName === "update_plan" || toolName === "complete_plan") {
      this.syncPlanCards(ctx);
      this.scrollToBottomIfStuck();
      return true;
    }

    // Hidden card: never create; remove a streaming card painted under the
    // write_file fallback before the real name resolved (or pre-toggle).
    if (!isConversationCardVisible(toolName, toolPart.arguments)) {
      this.removeToolCardByCallId(toolCallId);
      this.scrollToBottomIfStuck();
      return true;
    }

    const cardRow = createMessageView(
      {
        role: "assistant",
        parts: [toolPart],
      },
      ctx,
    );
    const card = cardRow?.querySelector<HTMLElement>(".conversation-msg-body")
      ?.firstElementChild as HTMLElement | null;
    if (!card) {
      this.syncPlanCards(ctx);
      return false;
    }
    card.dataset.toolCallId = toolCallId;
    // Live finish only: reveal the success mark now and let it fade after a
    // short hold (history renders of this card keep it dormant/hidden).
    armLiveOutcomeFade(card);

    let isNewCard = false;
    const existing =
      this.messagesListEl.querySelector<HTMLElement>(
        `[data-tool-call-id="${CSS.escape(toolCallId)}"]`,
      ) ??
      (toolName === "create_plan"
        ? this.messagesListEl.querySelector<HTMLElement>(
            `[data-plan-create-tool-call-id="${CSS.escape(toolCallId)}"]`,
          )
        : null);
    if (existing) {
      // Drop sticky duplicates of the same Plan before replacing one node.
      if (toolName === "create_plan") {
        for (const extra of Array.from(
          this.messagesListEl.querySelectorAll<HTMLElement>(
            `[data-plan-create-tool-call-id="${CSS.escape(toolCallId)}"]`,
          ),
        )) {
          if (extra !== existing) extra.remove();
        }
      }
      // Write previews pin the lined view to the latest streamed line; carry
      // the user's expand state and that scroll offset across the finish
      // replace so the card does not snap back to expanded-at-content-top.
      // Full writes only — the finished patch card renders a diff view where
      // the raw-text offset is meaningless. wasOpen=null for compact old
      // cards: keep the new card's default instead of forcing it open.
      const wasOpen = getVirtualToolCardOpen(existing);
      const result = ctx.toolResultsByCallId.get(toolCallId);
      const collapseFailedPatch = toolName === "patch" &&
        existing.dataset.toolStreaming === "1" && result !== undefined &&
        result.returnCode !== 0;
      transferVirtualToolCardState(existing, card, {
        preserveBody: existing.dataset.toolStreaming !== "1" || isWriteFileTool(toolName),
      });
      const prevWriteScroll = isWriteFileTool(toolName)
        ? this.captureWritePreviewScroll(existing)
        : null;
      const sleepResize =
        existing.classList.contains("content-card-tool-sleep") &&
        card.classList.contains("content-card-tool-sleep");
      if (sleepResize) {
        playCardHeightTransition(existing, card);
      } else {
        existing.replaceWith(card);
      }
      // A failed result closes the running preview; later user toggles survive refreshes.
      if (collapseFailedPatch) setVirtualToolCardOpen(card, false);
      else if (wasOpen !== null) setVirtualToolCardOpen(card, wasOpen);
      if (prevWriteScroll) {
        this.restoreWritePreviewScroll(card, prevWriteScroll);
      }
    } else {
      isNewCard = true;
      this.ensureCurrentTurnUserCard();
      let body = this.findToolAppendBody(assistantMessageId);
      if (!body) {
        const assistantRow = document.createElement("article");
        assistantRow.className = "conversation-msg conversation-msg-assistant";
        assistantRow.dataset.messageId = assistantMessageId;
        body = document.createElement("div");
        body.className = "conversation-msg-body";
        assistantRow.append(body);
        const flow = this.activeTurnFlowEl();
        if (flow) flow.append(assistantRow);
        else this.messagesListEl.append(assistantRow);
      }
      body.append(card);
      this.settleTurnThought();
    }

    if (toolName === "create_plan") {
      this.syncPlanCards(ctx);
      this.layoutTurns();
      if (isNewCard) this.animatePlanCardEntrance(toolCallId);
      this.scrollToBottomIfStuck();
      return true;
    }

    if (!card.closest(`.${TURN_CLASS}`) || hasUnwrappedPlan(this.messagesListEl)) {
      this.layoutTurns();
    }
    if (isNewCard) playCardEnterAnimation(card);
    this.scrollToBottomIfStuck();
    return true;
  }

  /**
   * syncPlanCards swaps the create_plan card for a fresh rich Plan card (which
   * carries only data-plan-create-tool-call-id), so resolve the live node first.
   */
  private animatePlanCardEntrance(toolCallId: string): void {
    const id = CSS.escape(toolCallId);
    const card = this.messagesListEl.querySelector<HTMLElement>(
      `[data-plan-create-tool-call-id="${id}"], [data-tool-call-id="${id}"]`,
    );
    if (card) playCardEnterAnimation(card);
  }

  renderApprovals(approvals: PendingApproval[]): void {
    this.approvalsEl.replaceChildren();
    if (approvals.length === 0) {
      this.approvalsEl.hidden = true;
      return;
    }
    this.approvalsEl.hidden = false;
    for (const approval of approvals) {
      const card = createApprovalCard({
        requestId: approval.requestId,
        toolName: approval.toolName,
        arguments: approval.arguments,
        expiresAt: approval.expiresAt,
        ...(approval.risk ? { risk: approval.risk } : {}),
        onAllow: () => this.onApprovalRespond?.(approval.requestId, true),
        onDeny: () => this.onApprovalRespond?.(approval.requestId, false),
      });
      playCardEnterAnimation(card);
      this.approvalsEl.append(card);
    }
    this.scrollToBottomIfStuck();
  }

  /**
   * Swap the live build-status card (null clears it). The host sits below
   * the transcript, so an active build stays visible while idle turns
   * repaint above it.
   */
  setBuildStatusCard(card: HTMLElement | null): void {
    if (card) this.buildStatusHost.replaceChildren(card);
    else this.buildStatusHost.replaceChildren();
    this.scrollToBottomIfStuck();
  }

  /** Release resources that otherwise retain an entire detached transcript. */
  destroy(): void {
    this.buildStatusHost.replaceChildren();
    this.invalidateInFlightMessageRender();
    this.toolCardViewport.destroy();
    this.scrollViewport.destroy();
    this.resetStreamingMarkdownState();
    this.resetReasoningStreamState();
    this.autoScroll.destroy();
    disposeUserPromptClamps(this.messagesListEl);
    this.composer.destroy();
    this.onApprovalRespond = null;
    this.onReclaimUserPrompt = null;
    this.userPromptReclaimability = null;
    this.planReviewApi = null;
    this.onPlanApprove = null;
    this.onPlanDiscard = null;
    this.windowState = null;
    this.onLoadEarlier = null;
    this.loadEarlierEl = null;
    this.loadEarlierBarEl = null;
    this.loadEarlierLabelEl = null;
    this.lastRenderOptions = null;
    this.messagesListEl.replaceChildren();
    this.root.remove();
  }
}
