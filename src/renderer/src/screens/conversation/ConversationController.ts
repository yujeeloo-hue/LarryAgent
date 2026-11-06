import { shownTurnStarts, textOnlyMessages } from "./textOnlyMessages.js";
import { recentMessages, recentSessionTail } from "./recentHistory.js";
import { demoQueueFingerprint, type DemoCardState, type DemoSubmitReceipt } from "../../../../session/demoCardState.js";
import { isShellToolName } from "../../state/shellToolName.js";
import {
  ContextPillController,
  pillStepState,
  pillTextFromParts,
  pillFilesFromParts,
  sameContextPillSnapshot,
  type ContextPillSnapshot,
} from "../../devmode/contextPill.js";
import { toggleInfiniteMaxCombo } from "../../state/composerShortcuts.js";
import {
  getComposerPrefs,
  hydrateComposerPrefs,
  setComposerPrefsFor,
  subscribeComposerPrefs,
  type SessionComposerPrefs,
} from "../../state/sessionComposerPrefs.js";
import {
  clearSessionDraft,
  getSessionDraft,
  setSessionDraft,
} from "../../state/sessionDrafts.js";
import {
  isFullPermissionsEnabled,
  setFullPermissionsEnabled,
  subscribeFullPermissions,
} from "../../state/fullPermissionsState.js";
import {
  isAutoSkillSummarizeEnabled,
  setAutoSkillSummarizeEnabled,
  subscribeAutoSkillSummarize,
} from "../../state/autoSkillSummarizeState.js";
import {
  dropUnresolvedWriteStreams,
  ensureWriteStreamBackgroundListener,
  listWriteStreams,
  someWriteStream,
  subscribeWriteStreams,
  type WriteStreamEntry,
} from "../../state/writeStreamState.js";
import { isConversationCardVisible, toolHintLabel } from "./turnDisplay.js";
import type { ContextUsage } from "../../ui/contextUsage.js";
import {
  playAskUserChime,
  playPermissionKnock,
  playPlanReviewChime,
} from "../../ui/attentionSounds.js";
import { filterExistingFiles } from "../../ui/existingFiles.js";
import { isImeComposing } from "../../ui/ime.js";
import { createRafCoalescer } from "../../ui/rafCoalesce.js";
import { bindComposerAttachments } from "../../ui/taskComposer/bindComposerAttachments.js";
import type { PendingAttachment } from "../../ui/taskComposer/bindComposerAttachments.js";
import {
  DEV_MODE_COMMAND,
  MODE_SLASH_LABELS,
  matchModeSlashCommand,
  matchSlashCommandWithArgs,
  matchSlashEscape,
  matchWorkspaceTaskCommand,
  SLASH_COMMANDS,
  type SlashCommand,
} from "../../ui/taskComposer/slashCommands.js";
import { parseProtectTokenRatioArg } from "../../../../shared/protectTokenRatio.js";
import {
  createVoiceInput,
  type VoiceInputHandle,
} from "../../ui/taskComposer/voiceInput.js";
import { bindComposerProviders } from "../../ui/taskComposer/bindComposerProviders.js";
import type { ComposerProvidersBinding } from "../../ui/taskComposer/bindComposerProviders.js";
import { getProvidersState } from "../../state/activeProviderState.js";
import type {
  ConversationView,
  PendingApproval,
  PendingUserAsk,
} from "./ConversationView.js";
import type { PromptQueueItem } from "./PromptQueueView.js";
import { resolveComposerSubmitAction } from "./promptQueueGesture.js";
import { shouldShowTurnProgress } from "./turnProgress.js";
import { buildMessageRenderContext } from "./buildMessageRenderContext.js";
import { buildDemoConfirmMessage } from "../../../../session/demoConfirm.js";
import { RETRY_CONTINUATION_PROMPT } from "../../../../agent/turnContinuations.js";
import type { TurnErrorRetryPayload } from "./cards/TurnErrorCardView.js";
import {
  type SubagentCardSnapshot,
} from "./cards/SubagentCardView.js";
import type { SubagentStatusKind } from "./cards/ToolInvocationCardView.js";
import type { AgentReadRange } from "../../devmode/agentFlash.js";
import {
  readRangeFromArgs,
  unwrapToolCallBridge,
  writeToolFilePlan,
  type AgentWriteFilePlan,
} from "./cards/toolInvocationHelpers.js";
import { matchFlashRanges, patchResultFlashRanges } from "./cards/resultContent.js";
import { uploadLiveFromPayload } from "./cards/uploadCard.js";
import {
  buildBufferTail,
  createBuildStatusCard,
  type BuildStatusCardApi,
} from "./cards/BuildStatusCardView.js";
import {
  isValidUsedTokens,
  mergeContextUsage,
  normalizeContextUsage,
  shouldAcceptUsedTokens,
} from "../../ui/contextUsage.js";

/** Throttle write_file preview repaints (~20 fps). */
const WRITE_STREAM_PAINT_MIN_MS = 50;

/**
 * Attachment names of one message (by id) from the cached session snapshot
 * — feeds the pill's file badge when the scroll anchor points at an older
 * prompt. Null when the message (or its attachments) is unknown.
 */
function filesForMessage(
  messages: Array<{ id?: string; parts: Array<Record<string, unknown>> }>,
  messageId: string,
): string[] | null {
  const message = messages.find((m) => m.id === messageId);
  return message ? pillFilesFromParts(message.parts) : null;
}

/**
 * File-content tools that dirty the git working tree. A tool_finished for
 * one of these refreshes the footer Commit/Changes counts immediately
 * instead of waiting for the whole turn to end.
 */
const WORKING_TREE_WRITE_TOOLS = new Set([
  "write_file",
  "patch",
  // Retired names — kept so historical replays still refresh git stats.
  "append_file",
  "edit_file",
]);

function isWorkingTreeWriteToolName(name: unknown): boolean {
  return typeof name === "string" && WORKING_TREE_WRITE_TOOLS.has(name);
}

function requireBridge(): NonNullable<Window["jellybot"]> {
  const bridge = window.jellybot;
  if (!bridge) {
    throw new Error("jellybot bridge is unavailable");
  }
  return bridge;
}

function asSubagentStatus(value: unknown): SubagentStatusKind | null {
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

/**
 * Conversation screen logic — loads session, streams events, follow-up turns.
 */
export class ConversationController {
  private unsubs: Array<() => void> = [];
  private readonly transcriptOnly: boolean;
  private readonly historyWindowMs: number | undefined;
  private readonly externalPrompts: boolean;
  private readonly textOnlyMessageIds: (() => ReadonlySet<string>) | undefined;
  private readonly turnStartMessageIds: (() => ReadonlySet<string>) | undefined;
  /** {@link turnStartMessageIds} mapped onto the displayed (filtered) messages. */
  private displayTurnStarts: ReadonlySet<string> | undefined;
  private readonly quietCurrentTurn: (() => boolean) | undefined;
  private historyTimer: ReturnType<typeof setInterval> | undefined;
  private readonly readOnly: boolean;
  private readonly promptRestoreOverride: ((text:string) => void) | undefined;
  private readonly retryOverride: ((payload: TurnErrorRetryPayload) => Promise<boolean>) | undefined;
  private readonly onContextUsage: ((usage: ContextUsage) => void) | undefined;
  /** Skips full DOM rebuilds when a refresh fetches an unchanged transcript (e.g. CoCo's hourly window timer). */
  private transcriptRenderKey = "";
  private unsubscribePermissions: (() => void) | undefined;
  private unsubscribeAutoSkillSummarize: (() => void) | undefined;
  private unsubscribeComposerPrefs: (() => void) | undefined;
  private providersBinding: ComposerProvidersBinding | undefined;
  /** ⌥⌃ voice mode + push-to-talk wiring for this screen's composer. */
  private voiceInput: VoiceInputHandle | undefined;
  private unbindAttachments: (() => void) | undefined;
  private attachmentsApi:
    | ReturnType<typeof bindComposerAttachments>
    | undefined;
  private sending = false;
  private composerSubmitting = false;
  private composerEnqueuePending = false;
  private insertAfterEnqueue = false;
  private pendingApprovals: PendingApproval[] = [];
  private pendingAsks: PendingUserAsk[] = [];
  /**
   * Mirror of the main-process prompt queue (snapshot from `prompt_queue`
   * stream events). Items are `deferred` unless the user armed them.
   */
  private promptQueue: PromptQueueItem[] = [];
  /** Debounced draft-stash save timer (per-session key). */
  private draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private contextUsage: ContextUsage = {
    usedTokens: 0,
    limitTokens: 128_000,
  };
  private sessionStatus: SessionStatus = "idle";
  /** Manual /compact in flight — keeps the status row visible on idle sessions. */
  private compacting = false;
  /** Older-page fetch in flight (progressive window); one at a time. */
  private loadingEarlier = false;
  /** `/opt` optimization pass in flight — repeat submits are swallowed. */
  private optimizingPrompt = false;
  /** Why the last Approve bounced back to review; shown on the review bar. */
  private planReviewError: string | null = null;
  /** Plan review bar visibility — detects live appearance for the chime. */
  private planReviewActive = false;
  /** First sync after mount is a rehydrate — the chime skips it. */
  private planReviewSyncedOnce = false;
  private lastProgressText = "";
  /**
   * Tool the latest progress line is attributed to (absent on model-phase
   * lines). Drives the card-tool suppression of the status row.
   */
  private lastProgressToolName: string | null = null;
  /** Card-painting tool calls in flight (tool_call → tool_finished). */
  private readonly cardToolCallIds = new Set<string>();
  private lastMessages: Array<{
    id?: string;
    role: string;
    parts: Array<Record<string, unknown>>;
  }> = [];
  private isLocallyStreaming = false;
  private readonly subagentsByToolCallId = new Map<string, SubagentCardSnapshot>();
  /** Live queued/running subagent ids — drives the footer count button. */
  private readonly runningSubagentIds = new Set<string>();
  /** Entry ids that need a paint pass (process-wide store holds the bytes). */
  private readonly dirtyWriteStreamIds = new Set<string>();
  /** Pending devtask exit subscription (/build /run feedback). */
  private devTaskExitOff: (() => void) | undefined;
  /** devtask:progress subscription for the live build card. */
  private devTaskProgressOff: (() => void) | undefined;
  /** Live build card (null when no build attached). */
  private buildCard: BuildStatusCardApi | null = null;
  /** Workspace of the run the live build card is bound to. */
  private buildCardWorkspace = "";
  private writeStreamPaintTimer: ReturnType<typeof setTimeout> | null = null;
  private writeStreamPaintRaf: number | null = null;
  private writeStreamPaintQueued = false;
  private lastWriteStreamPaintAt = 0;
  /** Ignore stream paints until the initial session hydrate finishes. */
  private writeStreamPaintReady = false;
  private readonly refreshCoalesce = createRafCoalescer(
    () => this.refresh(),
    "conversation.refresh",
  );
  private readonly assistantSliceRefresh = createRafCoalescer(
    () => this.refreshLastAssistant(),
    "conversation.assistant_slice",
  );
  private readonly finalizeTurnCoalesce = createRafCoalescer(
    () => this.finalizeTurn(),
    "conversation.finalize_turn",
  );
  private destroyed = false;
  private readonly demoStates = new Map<string, DemoCardState>();
  private toolRenderQueue: Promise<void> = Promise.resolve();
  /** Coalesced reasoning_delta text awaiting a paint flush. */
  private pendingReasoningDelta = "";
  private pendingReasoningMessageId: string | null = null;
  private reasoningFlushScheduled = false;
  private workspacePath = "";
  private providerId = "";
  /** Balance line for the latest completed turn (provider adapter text). */
  private lastTurnBalanceText: string | null = null;
  private gitStatsSeq = 0;
  /** A working-tree scan is running; further requests coalesce into one rerun. */
  private gitStatsInFlight = false;
  private gitStatsRerunWanted = false;
  private gitBusy = false;
  /** Debounce timer for write-tool-triggered git stats refreshes. */
  private gitStatsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly initialOptimistic: {
    text: string;
    attachments: PendingAttachment[];
  } | null;

  /** Dev Mode file-open override (workbench editor pane). */
  private readonly onOpenFileOverride: ((path: string) => void) | null = null;
  /** Dev Mode toggle (/dev) — wired by the shell. */
  private readonly onToggleDevMode: (() => void) | null = null;
  /**
   * Dev Mode: fires when a write_file / patch tool finishes, with the
   * files it touched and the changed-line flash ranges for each (patch
   * hunks; empty for replace-mode writes). Wired by DevModeController to
   * open the files in the workbench editor pane and flash the changes.
   */
  private readonly onFileWritten:
    | ((files: AgentWriteFilePlan[]) => void)
    | null = null;
  /**
   * Dev Mode: fires when a read_file tool finishes — open the file and
   * flash the lines that were read. Wired by DevModeController.
   */
  private readonly onFileRead:
    | ((path: string, range: AgentReadRange) => void)
    | null = null;
  /**
   * Dev Mode: emits the top context-pill snapshot (running flag, latest
   * user prompt, progress text, active plan). Wired by DevModeController.
   */
  private readonly onContextPill:
    | ((snapshot: ContextPillSnapshot) => void)
    | null = null;
  /**
   * Dev Mode: command feedback rides the top context pill's notice state
   * (the composer-side slash-hint bar is gone). Wired by
   * DevModeController; normal mode falls back to its local pill.
   */
  private readonly onPillNotice:
    | ((text: string, durationMs?: number, spinner?: boolean) => void)
    | null = null;
  /** Pill cache — latest user prompt line (whitespace-collapsed). */
  private pillUserText: string | null = null;
  /** Attachment names of the latest transcript prompt (badge tooltip). */
  private pillUserFiles: string[] | null = null;
  /** Pill cache — active plan mapped onto pill step states. */
  private pillPlan: ContextPillSnapshot["plan"] = null;
  private lastPillSnapshot: ContextPillSnapshot | null = null;
  /** Latest user bubble on screen in the transcript (view tracks scrolling). */
  private pillPromptVisible = false;
  /**
   * Prompt the current scroll position is reading (view-tracked anchor);
   * null until the first DOM render — falls back to the latest prompt.
   */
  private pillAnchorText: string | null = null;
  /** Attachments of the anchor prompt (message lookup by id). */
  private pillAnchorFiles: string[] | null = null;
  /**
   * Normal mode: the pill has no external consumer, so the conversation
   * screen carries it itself — same component, anchored to the screen top
   * (below the titlebar). Dev Mode passes onContextPill instead (its chat
   * pane hosts the pill) and this stays null.
   */
  private localPill: ContextPillController | null = null;
  /** tool_callId → touched file plan, consumed by its tool_finished. */
  private readonly pendingWriteFiles = new Map<string, AgentWriteFilePlan[]>();
  /**
   * Write plans staged between tool_finished and the finished-card render —
   * the flash fires from the render pass, which holds the same session
   * snapshot the card is built from (single source, no second lookup).
   */
  private readonly pendingFlashPlans = new Map<string, AgentWriteFilePlan[]>();
  /** tool_callId → read target + span, consumed by its tool_finished. */
  private readonly pendingReadFiles = new Map<
    string,
    { path: string; range: AgentReadRange }
  >();

  constructor(
    private readonly view: ConversationView,
    private readonly sessionId: string,
    options?: {
      /** Embed the ordinary message list and session events without a second composer. */
      transcriptOnly?: boolean;
      historyWindowMs?: number;
      externalPrompts?: boolean;
      textOnlyMessageIds?: () => ReadonlySet<string>;
      /**
       * First messages of turns without a user prompt (CoCo automatic /
       * hand-over replies). Setting this also makes a live prompt-less turn
       * open its own turn instead of painting under the previous footer.
       */
      turnStartMessageIds?: () => ReadonlySet<string>;
      quietCurrentTurn?: () => boolean;
      /** Inspect an independently owned background turn without interactive actions. */
      readOnly?: boolean;
      onPromptRestore?: (text:string) => void;
      onRetryTurnError?: (payload: TurnErrorRetryPayload) => Promise<boolean>;
      /** Mirrors every composer ring update (for hosts with their own composer). */
      onContextUsage?: (usage: ContextUsage) => void;
      optimisticUserText?: string;
      attachments?: PendingAttachment[];
      /**
       * Dev Mode override: file clicks open in the workbench editor pane
       * instead of the File Reader window (wired by DevModeController).
       */
      onOpenFile?: (path: string) => void;
      /** `/dev` — toggle Dev Mode; null = unwired (hint explains). */
      onToggleDevMode?: () => void;
      /**
       * Dev Mode: a write_file / patch tool finished — open these files
       * (paths as written in the tool args; relative = workspace-relative)
       * and flash the changed lines when the patch body carried hunks.
       */
      onFileWritten?: (files: AgentWriteFilePlan[]) => void;
      /**
       * Dev Mode: a read_file tool finished — open the file and flash the
       * read span (offset/limit; `end: null` = through EOF, whole-file).
       */
      onFileRead?: (path: string, range: AgentReadRange) => void;
      /**
       * Dev Mode: top context-pill snapshot updates (running flag, latest
       * prompt, progress, active plan). Fires only on actual changes.
       */
      onContextPill?: (snapshot: ContextPillSnapshot) => void;
      /**
       * Dev Mode: command feedback notice (same payload the normal-mode
       * local pill gets). Wired to the chat pill + editor status strip.
       */
      onPillNotice?: (
        text: string,
        durationMs?: number,
        spinner?: boolean,
      ) => void;
    },
  ) {
    this.historyWindowMs = options?.historyWindowMs;
    this.externalPrompts = options?.externalPrompts === true;
    this.textOnlyMessageIds = options?.textOnlyMessageIds;
    this.turnStartMessageIds = options?.turnStartMessageIds;
    this.quietCurrentTurn = options?.quietCurrentTurn;
    this.readOnly = options?.readOnly === true;
    this.transcriptOnly = options?.transcriptOnly === true || this.readOnly;
    this.promptRestoreOverride = options?.onPromptRestore;
    this.retryOverride = options?.onRetryTurnError;
    this.onContextUsage = options?.onContextUsage;
    const text = options?.optimisticUserText?.trim() ?? "";
    const attachments = options?.attachments ?? [];
    this.onOpenFileOverride = options?.onOpenFile ?? null;
    this.onToggleDevMode = options?.onToggleDevMode ?? null;
    this.onFileWritten = options?.onFileWritten ?? null;
    this.onFileRead = options?.onFileRead ?? null;
    this.onContextPill = options?.onContextPill ?? null;
    this.onPillNotice = options?.onPillNotice ?? null;
    if (!this.onContextPill && !this.transcriptOnly) {
      this.localPill = new ContextPillController();
    }
    // Prompt anchor feeds the pill's auto-fold AND its text (the prompt
    // the viewport is reading — not always the latest one; local pill and
    // the Dev Mode chat pill alike — it rides the same snapshot).
    this.view.onPromptVisibilityChange = (visible, promptText, messageId) => {
      this.pillPromptVisible = visible;
      this.pillAnchorText = promptText;
      // Badge follows the anchor prompt: look its message up in the last
      // session snapshot (rows without an id — pending optimistic bubbles —
      // keep the latest transcript files).
      this.pillAnchorFiles =
        messageId !== null
          ? filesForMessage(this.lastMessages, messageId) ?? this.pillUserFiles
          : null;
      this.emitContextPill();
    };
    this.initialOptimistic =
      text || attachments.length > 0 ? { text, attachments } : null;
    this.view.setActionsExpanded(false);
    this.pushContextUsage();
    this.view.setPermissionsEnabled(isFullPermissionsEnabled());
    this.view.setAutoSkillSummarizeEnabled(isAutoSkillSummarizeEnabled());
    this.applyComposerPrefs(this.getPrefs());
    this.view.setOnInfiniteSelect((enabled) => {
      setComposerPrefsFor(this.sessionId, { infinite: enabled });
    });
    this.view.setOnRunModeSelect((mode) => {
      setComposerPrefsFor(this.sessionId, { runMode: mode, fsmGraphId: null });
    });
    this.view.setOnCustomGraphSelect((graph) => {
      setComposerPrefsFor(this.sessionId, {
        runMode: "custom",
        fsmGraphId: graph.id,
      });
      this.view.setCustomGraphSelection(graph);
    });
    this.view.setOnPermissionsSelect((full) => {
      setFullPermissionsEnabled(full);
    });
    this.view.setOnAutoSkillSummarizeSelect((enabled) => {
      setAutoSkillSummarizeEnabled(enabled);
    });
    this.view.setHandoffVisible(true);
    this.view.setOnHandoffSelect((enabled) => {
      setComposerPrefsFor(this.sessionId, { handoffEnabled: enabled });
    });
    this.view.setPlanReviewHandlers({
      onApprove: () => {
        void this.handlePlanApprove();
      },
      onDiscard: () => {
        void this.handlePlanDiscard();
      },
    });
    this.bind();
    // Restore this session's stashed draft — switching sessions back and
    // forth must keep un-submitted input. Fresh sessions (created from New
    // Task with an optimistic prompt) have no stash and get "".
    const draft = getSessionDraft(this.sessionId);
    if (draft.length > 0) {
      this.view.composer.setPrompt(draft);
      this.syncSendEnabled();
    }
  }

  /** True while a turn is running or a send is in flight (commit guard). */
  isBusy(): boolean {
    return this.sessionStatus === "running" || this.sending;
  }

  /** Re-read the transcript after host display filters (e.g. `textOnlyMessageIds`) change. */
  refreshDisplay(): void {
    if (this.destroyed) return;
    this.scheduleStructuralRefresh();
  }

  /** Composer-selected provider — Dev Mode commit prefers it for drafts. */
  get activeProviderId(): string {
    return this.providerId;
  }

  mount(): HTMLElement {
    if (this.readOnly) this.view.root.classList.add("conversation-read-only");
    const bridge = requireBridge();
    if (this.initialOptimistic) {
      this.view.appendOptimisticUserMessage(
        this.initialOptimistic.text,
        this.initialOptimistic.attachments,
      );
      this.sessionStatus = "running";
      this.sending = true;
      this.view.setRunning(true);
      this.pillUserText = this.initialOptimistic.text || this.pillUserText;
      const optimisticFiles = this.initialOptimistic.attachments
        .map((a) => a.name)
        .filter((name) => name.trim().length > 0);
      this.pillUserFiles = optimisticFiles.length > 0 ? optimisticFiles : null;
      this.syncTurnProgress("Waiting for model…");
      this.syncSendEnabled();
    }
    void this.loadContextLimit();
    // A STOP-rollback may have fired while this screen was unmounted —
    // pull the latched prompt so it lands back in the composer.
    if (!this.readOnly) void this.consumePendingPromptRestore();
    const bridgeForStreams = requireBridge();
    ensureWriteStreamBackgroundListener(bridgeForStreams);
    this.unsubs.push(
      subscribeWriteStreams((change) => {
        if (change.sessionId !== this.sessionId) return;
        if (change.retarget) {
          this.view.retargetToolCardId(change.retarget.from, change.retarget.to);
          this.dirtyWriteStreamIds.delete(change.retarget.from);
          this.dirtyWriteStreamIds.add(change.retarget.to);
        } else if (change.toolCallId) {
          // Cleared finished streams should not be repainted.
          const stillLive = someWriteStream(
            this.sessionId,
            (e) => e.id === change.toolCallId,
          );
          if (stillLive) this.dirtyWriteStreamIds.add(change.toolCallId);
          else this.dirtyWriteStreamIds.delete(change.toolCallId);
        }
        if (this.writeStreamPaintReady) {
          this.scheduleWriteStreamPaint();
        }
      }),
    );
    void this.refresh();
    if (this.historyWindowMs) this.historyTimer = setInterval(() => { if (!this.destroyed) this.refreshCoalesce.schedule(); }, 30000);
    if (this.transcriptOnly) {
      this.view.setTranscriptOnly();
      if (!this.readOnly) this.view.setApprovalHandler((requestId,approved) => { void bridge.respondToolApproval?.({requestId,approved}); });
      this.bindSessionEvents(bridge);
      return this.view.root;
    }
    this.providersBinding = bindComposerProviders(this.view.composer, {
      getProviderId: () =>
        this.providerId.trim() || getProvidersState().activeProviderId,
      onProviderSelect: async (providerId) => {
        const bridge = requireBridge();
        if (typeof bridge.setSessionProvider !== "function") {
          throw new Error("setSessionProvider is unavailable");
        }
        const session = await bridge.setSessionProvider(
          this.sessionId,
          providerId,
        );
        this.providerId =
          typeof session.providerId === "string"
            ? session.providerId.trim()
            : providerId;
      },
      onSelectionMissing: (providerId) => {
        this.providerId = providerId;
        if (this.sessionStatus === "running" || this.sending) return;
        const bridge = requireBridge();
        if (typeof bridge.setSessionProvider !== "function") return;
        void bridge
          .setSessionProvider(this.sessionId, providerId)
          .then((session) => {
            this.providerId =
              typeof session.providerId === "string"
                ? session.providerId.trim()
                : providerId;
          })
          .catch((err) => {
            console.error(
              "[conversation] adopt provider after remote delete failed",
              err,
            );
          });
      },
      isLocked: () =>
        this.sessionStatus === "running" || this.sending === true,
    });
    this.attachmentsApi = bindComposerAttachments({
      composer: this.view.composer,
      syncSendEnabled: () => this.syncSendEnabled(),
    });
    this.unbindAttachments = () => this.attachmentsApi?.destroy();
    this.voiceInput = createVoiceInput({
      composer: this.view.composer,
      // Exit-voice-mode hands the send enablement back: without this the
      // mic face's forced-enabled state lingers on an empty composer.
      syncSendEnabled: () => this.syncSendEnabled(),
      onSubmitText: (text, send) => {
        this.view.composer.setPrompt(text);
        this.syncSendEnabled();
        send();
      },
    });
    this.unsubscribePermissions = subscribeFullPermissions((enabled) => {
      this.view.setPermissionsEnabled(enabled);
    });
    this.view.setPermissionsEnabled(isFullPermissionsEnabled());
    this.unsubscribeAutoSkillSummarize = subscribeAutoSkillSummarize(
      (enabled) => {
        this.view.setAutoSkillSummarizeEnabled(enabled);
      },
    );
    this.view.setAutoSkillSummarizeEnabled(isAutoSkillSummarizeEnabled());

    this.unsubscribeComposerPrefs = subscribeComposerPrefs(
      this.sessionId,
      (prefs) => {
        this.applyComposerPrefs(prefs);
      },
    );
    this.applyComposerPrefs(this.getPrefs());
    this.view.setApprovalHandler((requestId, approved) => {
      void bridge.respondToolApproval?.({ requestId, approved });
    });

    this.view.setPromptQueue(this.promptQueue, {
      onRemove: (id) => void this.removeQueuedPrompt(id),
      onUpdateText: (id, text) => void this.updateQueuedPromptText(id, text),
      onMoveToFront: (id) => void this.moveQueuedPromptToFront(id),
      onPromote: (id) => void this.promoteQueuedPrompt(id),
      onDefer: (id) => void this.deferQueuedPrompt(id),
    });
    void this.hydratePromptQueue();

    this.view.gitBar.onChanges = () => {
      const path = this.workspacePath.trim();
      if (!path) return;
      void requireBridge().openWorkspaceChangesWindow?.(path);
    };
    this.view.gitBar.onCommit = () => {
      void this.runGitCommit();
    };
    this.view.gitBar.onPush = () => {
      void this.runGitPush();
    };
    this.view.gitBar.onSubagents = () => {
      this.openSubagentsWindow();
    };
    // Footer count bootstrap: remount mid-run (view swap / session rehydrate)
    // still shows the live queued/running subagent count.
    void this.bootstrapRunningSubagents();

    this.unsubs.push(
      bridge.onVcsChanged(({ rootPath }) => {
        // Commits/pushes from ANY surface (Dev Mode outline toolbar, another
        // conversation, external git) land here — keep the footer stats live
        // instead of waiting for the next tool call / remount.
        const root = rootPath.replace(/\\/g, "/");
        const mine = this.workspacePath.trim().replace(/\\/g, "/");
        if (!mine || root !== mine) return;
        this.scheduleGitStatsRefresh();
      }),
    );
    this.bindSessionEvents(bridge);

    queueMicrotask(() => {
      if (!this.destroyed) this.view.focusInput();
    });
    // Normal mode pill rides the conversation screen (Dev Mode hosts its
    // own in the chat pane — onContextPill was wired, localPill is null).
    if (this.localPill) {
      this.localPill.mount(this.view.root);
      this.emitContextPill();
    }
    return this.view.root;
  }

  private bindSessionEvents(bridge: ReturnType<typeof requireBridge>): void {
    this.unsubs.push(
      bridge.onAgentStream((payload) => {
        if (payload.sessionId !== this.sessionId) return;
        this.handleStreamEvent(payload.event);
      }),
    );
    this.unsubs.push(
      bridge.onSessionUpdated((summary) => {
        if (summary.id !== this.sessionId) return;
        this.applySessionSummary(summary);
        if (summary.status !== "running") {
          void this.toolRenderQueue.then(() => {
            this.finalizeTurnCoalesce.schedule();
          });
          void this.refreshGitStats();
        }
      }),
    );
    if (typeof bridge.onToolApproval === "function") {
      this.unsubs.push(
        bridge.onToolApproval((payload) => {
          if (payload.sessionId !== this.sessionId) return;
          this.pendingApprovals = [
            ...this.pendingApprovals.filter(
              (item) => item.requestId !== payload.requestId,
            ),
            {
              requestId: payload.requestId,
              toolName: payload.toolName,
              arguments: payload.arguments,
              expiresAt: payload.expiresAt,
              ...(payload.risk ? { risk: payload.risk } : {}),
            },
          ];
          this.view.renderApprovals(this.externalPrompts ? [] : this.pendingApprovals);
          playPermissionKnock();
        }),
      );
    }
    if (typeof bridge.onToolApprovalDismiss === "function") {
      this.unsubs.push(
        bridge.onToolApprovalDismiss((payload) => {
          if (payload.sessionId !== this.sessionId) return;
          this.pendingApprovals = this.pendingApprovals.filter(
            (item) => item.requestId !== payload.requestId,
          );
          this.view.renderApprovals(this.externalPrompts ? [] : this.pendingApprovals);
        }),
      );
    }
    if (typeof bridge.onUserAsk === "function") {
      this.unsubs.push(
        bridge.onUserAsk((payload) => {
          if (payload.sessionId !== this.sessionId) return;
          this.pendingAsks = [
            ...this.pendingAsks.filter(
              (item) => item.requestId !== payload.requestId,
            ),
            {
              requestId: payload.requestId,
              toolCallId: payload.toolCallId,
              question: payload.question,
              options: payload.options,
              ...(payload.optionDetails ? { optionDetails: payload.optionDetails } : {}),
              allowCustom: payload.allowCustom,
              allowMultiple: payload.allowMultiple === true,
            },
          ];
          // ask_user / request_full_permissions card just appeared.
          playAskUserChime();
          if (this.sessionStatus === "running") {
            this.assistantSliceRefresh.schedule();
          } else {
            this.refreshCoalesce.schedule();
          }
        }),
      );
    }
    if (typeof bridge.onUserAskDismiss === "function") {
      this.unsubs.push(
        bridge.onUserAskDismiss((payload) => {
          if (payload.sessionId !== this.sessionId) return;
          this.pendingAsks = this.pendingAsks.filter(
            (item) => item.requestId !== payload.requestId,
          );
          if (this.sessionStatus === "running") {
            this.assistantSliceRefresh.schedule();
          } else {
            this.refreshCoalesce.schedule();
          }
        }),
      );
    }

  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // A pending /build /run exit notification has no listener anymore.
    this.devTaskExitOff?.();
    this.devTaskExitOff = undefined;
    this.devTaskProgressOff?.();
    this.devTaskProgressOff = undefined;
    this.buildCard = null;
    this.buildCardWorkspace = "";
    // Flush a pending draft save before the view goes away — switching
    // sessions within the 300ms window must not lose the last keystrokes.
    if (this.draftSaveTimer != null) {
      clearTimeout(this.draftSaveTimer);
      this.draftSaveTimer = null;
      setSessionDraft(this.sessionId, this.view.getPrompt());
    }
    this.refreshCoalesce.cancel();
    this.assistantSliceRefresh.cancel();
    this.finalizeTurnCoalesce.cancel();
    this.pendingReasoningDelta = "";
    this.pendingReasoningMessageId = null;
    this.reasoningFlushScheduled = false;
    this.voiceInput?.destroy();
    this.voiceInput = undefined;
    this.unsubscribePermissions?.();
    this.unsubscribePermissions = undefined;
    this.unsubscribeAutoSkillSummarize?.();
    this.unsubscribeAutoSkillSummarize = undefined;
    this.unsubscribeComposerPrefs?.();
    this.unsubscribeComposerPrefs = undefined;
    this.providersBinding?.dispose();
    this.providersBinding = undefined;
    this.unbindAttachments?.();
    this.unbindAttachments = undefined;
    this.attachmentsApi = undefined;
    this.view.gitBar.onChanges = null;
    this.view.gitBar.onCommit = null;
    this.view.gitBar.onPush = null;
    this.view.gitBar.onSubagents = null;
    if (this.gitStatsRefreshTimer != null) {
      clearTimeout(this.gitStatsRefreshTimer);
      this.gitStatsRefreshTimer = null;
    }
    this.runningSubagentIds.clear();
    this.view.gitBar.setSubagentCount(0);
    if (!this.transcriptOnly) void window.jellybot?.closeWorkspaceChangesWindow?.();
    this.view.setApprovalHandler(null);
    this.view.setPromptQueue([], null);
    this.promptQueue = [];
    this.pendingApprovals = [];
    if (this.historyTimer) clearInterval(this.historyTimer);
    this.pendingAsks = [];
    this.dirtyWriteStreamIds.clear();
    this.pendingWriteFiles.clear();
    this.pendingFlashPlans.clear();
    this.writeStreamPaintReady = false;
    // Detach from the queued render chain. Tasks already scheduled bail on the
    // `destroyed` guard, but the chain itself would keep this controller (and
    // its view) reachable until the last one settles.
    this.toolRenderQueue = Promise.resolve();
    if (this.writeStreamPaintTimer != null) {
      clearTimeout(this.writeStreamPaintTimer);
      this.writeStreamPaintTimer = null;
    }
    if (this.writeStreamPaintRaf != null) {
      cancelAnimationFrame(this.writeStreamPaintRaf);
      this.writeStreamPaintRaf = null;
    }
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.localPill?.destroy();
    this.localPill = null;
    this.view.destroy();
  }

  private handleStreamEvent(event: StreamEvent): void {
    if (this.quietCurrentTurn?.() && ["reasoning_delta", "tool_call_delta", "tool_call", "tool_finished"].includes(event.type)) return;
    switch (event.type) {
      case "transcript_changed":
        this.scheduleStructuralRefresh();
        return;
      case "text_delta":
        if (
          typeof event.text === "string" &&
          typeof event.messageId === "string"
        ) {
          this.enqueueTextDelta(event.text, event.messageId);
        }
        return;
      case "reasoning_delta":
        if (
          typeof event.text === "string" &&
          typeof event.messageId === "string"
        ) {
          this.enqueueReasoningDelta(event.text, event.messageId);
        }
        return;
      case "hosted_tool":
        // Main persists provider activity before emitting. Reconcile that
        // snapshot; hosted calls never enter local tool/preview/abort paths.
        if (typeof event.messageId === "string" && event.messageId) {
          this.scheduleStructuralRefresh();
        }
        return;
      case "response_state":
        // Opaque native replay state is hidden; turn finalization picks up
        // annotated text alongside the final hosted activity snapshot.
        return;
      case "tool_call_delta": {
        // Large write/edit payloads stream here for a long time with no tool
        // card yet — end text-stream mode so tool progress (e.g. Writing file…) can show.
        // Args accumulate in writeStreamState (background listener); paint via subscribe.
        this.flushPendingReasoning();
        this.isLocallyStreaming = false;
        this.foldHeldReplyAfterQueuedText(null);
        this.syncTurnProgress();
        return;
      }
      case "round_interrupted": {
        // Interrupted round never reaches text/tool events — seal the live
        // stream chrome (Thinking card spinner + streaming text row) now so
        // it stops instead of spinning until the next round's first delta or
        // a later structural refresh.
        this.flushPendingReasoning();
        this.isLocallyStreaming = false;
        this.view.foldHeldReplyIntoThought();
        this.view.finalizeStreamingReasoning();
        // Half-streamed write args never became a real tool call (dropped
        // main-side) — remove their pending preview cards + stream state so
        // they don't linger as "streaming" until a later rebuild. Real calls
        // get their finished (cancelled) card via the tool_finished seal.
        for (const droppedId of dropUnresolvedWriteStreams(this.sessionId)) {
          this.dirtyWriteStreamIds.delete(droppedId);
          this.view.removeToolCardByCallId(droppedId);
        }
        this.syncTurnProgress();
        return;
      }
      case "tool_call":
        this.flushPendingReasoning();
        this.isLocallyStreaming = false;
        {
          const hint = toolHintLabel(
            typeof event.name === "string" ? event.name : "",
            event.arguments,
          );
          this.foldHeldReplyAfterQueuedText(hint);
        }
        // write_file / append_file args live in writeStreamState; other tools
        // still land via structural refresh / finished-tool path.
        // run_shell (sleep countdown) and upload_files (live rsync progress)
        // build their running card right at tool_call time. Deferred
        // `tool_call` bridge calls unwrap to the inner tool first.
        const bridged = unwrapToolCallBridge(
          typeof event.name === "string" ? event.name : "",
          event.arguments,
        );
        const toolCallId = typeof event.id === "string" ? event.id : "";
        const toolMessageId =
          typeof event.messageId === "string" ? event.messageId : "";
        const argumentsRaw =
          typeof event.argumentsRaw === "string" ? event.argumentsRaw : "";
        // Hidden tools open a record row the moment the call starts (the
        // finished path re-stamps duration/status onto the same id).
        {
          const recordHint = toolHintLabel(
            typeof event.name === "string" ? event.name : "",
            event.arguments,
          );
          if (toolCallId && recordHint) {
            const record = { id: toolCallId, hint: recordHint };
            this.toolRenderQueue = this.toolRenderQueue
              .then(() => {
                if (this.destroyed) return;
                this.view.noteTurnToolRecord(record);
              })
              .catch((err: unknown) => {
                console.error("[conversation] tool record render failed", err);
              });
          }
        }
        // Card tools own their progress — the status row must not open a
        // Thinking shell beside the card while it runs (Write/Patch rule).
        if (
          toolCallId &&
          isConversationCardVisible(bridged.name, bridged.arguments)
        ) {
          this.cardToolCallIds.add(toolCallId);
        }
        // Dev Mode auto-open: remember the files this write will touch so
        // the finishing event can open them in the editor pane. Bounded —
        // a dropped finished event must not leak entries forever.
        if (
          toolCallId &&
          isWorkingTreeWriteToolName(bridged.name) &&
          this.onFileWritten !== null
        ) {
          const plan = writeToolFilePlan(bridged.arguments);
          if (plan.length > 0) {
            if (this.pendingWriteFiles.size >= 32) {
              const oldest = this.pendingWriteFiles.keys().next().value;
              if (oldest !== undefined) this.pendingWriteFiles.delete(oldest);
            }
            this.pendingWriteFiles.set(toolCallId, plan);
          }
        }
        // Dev Mode read flash: same lifecycle as writes — capture at the
        // call, open + flash at the finish.
        if (
          toolCallId &&
          bridged.name === "read_file" &&
          this.onFileRead !== null &&
          typeof (bridged.arguments as Record<string, unknown> | null)
            ?.path === "string"
        ) {
          const args = bridged.arguments as Record<string, unknown>;
          const rawPath = args.path;
          if (typeof rawPath === "string" && rawPath.trim()) {
            if (this.pendingReadFiles.size >= 32) {
              const oldest = this.pendingReadFiles.keys().next().value;
              if (oldest !== undefined) this.pendingReadFiles.delete(oldest);
            }
            this.pendingReadFiles.set(toolCallId, {
              path: rawPath.trim(),
              range: readRangeFromArgs(bridged.arguments),
            });
          }
        }
        if (
          isConversationCardVisible(bridged.name, bridged.arguments) &&
          (isShellToolName(bridged.name) || bridged.name === "upload_files") &&
          toolCallId &&
          toolMessageId &&
          argumentsRaw
        ) {
          // Running cards join the serial render queue: queued assistant text
          // for an earlier message must land in the DOM first.
          this.enqueueViewRender(() => {
            this.view.upsertRunningToolCard({
              assistantMessageId: toolMessageId,
              toolCallId,
              name: bridged.name,
              arguments: bridged.arguments,
              argumentsRaw,
              onAbortToolCall: (callId) => this.abortToolCall(callId),
            });
          });
        } else if (
          bridged.name === "generate_image" &&
          toolCallId &&
          toolMessageId
        ) {
          // Show the sized generating placeholder while the request runs.
          this.enqueueViewRender(() => {
            this.view.upsertRunningImageCard({
              assistantMessageId: toolMessageId,
              toolCallId,
              name: bridged.name,
              arguments: bridged.arguments,
            });
          });
        }
        return;
      case "tool_finished":
        if (
          typeof event.id === "string" &&
          typeof event.messageId === "string"
        ) {
          this.dirtyWriteStreamIds.delete(event.id);
          this.cardToolCallIds.delete(event.id);
          this.enqueueFinishedTool(event.id, event.messageId);
        }
        // Dev Mode auto-open: the write landed — hand the touched files to
        // the workbench editor (no-op when the tool was not a write).
        if (typeof event.id === "string") {
          const written = this.pendingWriteFiles.get(event.id);
          if (written) {
            this.pendingWriteFiles.delete(event.id);
            // Stage for the finished-card render pass — it already holds
            // the session snapshot and computes the flash from the very
            // parts the card renders. Bounded like the plan map above.
            if (this.pendingFlashPlans.size >= 32) {
              const oldest = this.pendingFlashPlans.keys().next().value;
              if (oldest !== undefined) this.pendingFlashPlans.delete(oldest);
            }
            this.pendingFlashPlans.set(event.id, written);
          }
          const read = this.pendingReadFiles.get(event.id);
          if (read) {
            this.pendingReadFiles.delete(event.id);
            this.onFileRead?.(read.path, read.range);
          }
        }
        // File writes dirty the working tree — refresh the footer git bar
        // right away so Commit/Changes stay live mid-turn.
        if (isWorkingTreeWriteToolName(event.name)) {
          this.scheduleGitStatsRefresh();
        }
        // Keep showing the latest wait/run label while the turn continues.
        this.syncTurnProgress();
        return;
      case "progress":
        if (typeof event.text === "string") {
          // Side-path JSON (Planning…) and other waits happen after a text
          // round with no tool_call — end stream mode so the status row shows.
          if (this.isLocallyStreaming) {
            this.isLocallyStreaming = false;
            this.view.finalizeStreamingDisplay();
          }
          this.lastProgressToolName =
            typeof event.toolName === "string" && event.toolName
              ? event.toolName
              : null;
          this.syncTurnProgress(event.text);
        }
        return;
      case "tool_live": {
        // Mid-execution live payload (e.g. rsync upload progress). Pure UI
        // patching — never triggers structural refreshes.
        if (
          event.kind === "upload" &&
          typeof event.toolCallId === "string"
        ) {
          const state = uploadLiveFromPayload(event.payload);
          if (state) this.view.updateUploadLiveCard(event.toolCallId, state);
        }
        return;
      }
      case "full_permissions":
        if (event.enabled === true) {
          setFullPermissionsEnabled(true);
        }
        return;
      case "status": {
        const status = event.status;
        const running =
          status === "running" ||
          status === "streaming" ||
          status === "tool_running";
        if (status === "running" && this.sessionStatus !== "running" && this.turnStartMessageIds) {
          this.view.expectTurnWithoutPrompt();
        }
        if (
          status === "idle" ||
          status === "running" ||
          status === "completed" ||
          status === "error" ||
          status === "cancelled" ||
          status === "paused"
        ) {
          this.sessionStatus = status;
        } else if (running) {
          this.sessionStatus = "running";
        }
        this.view.setRunning(running);
        this.sending = running;
        this.syncSendEnabled();
        this.emitContextPill();
        this.pushContextUsage();
        if (status === "running") {
          // Pick up the persisted user prompt while Planner side-path /
          // first model iteration may still have no assistant text/tools.
          this.assistantSliceRefresh.schedule();
        }
        if (!running) {
          // Turn boundary: card-tool attribution resets with the turn.
          this.lastProgressToolName = null;
          this.cardToolCallIds.clear();
          // Queued prompts survive the turn now (main keeps them). Only the
          // palette changes: an idle session cannot auto-drain armed items.
          this.renderPromptQueue();
        } else {
          this.view.setPromptQueueIdle(false);
        }
        if (status === "paused") {
          this.notifyHint("Paused — /resume to continue");
        }
        return;
      }
      case "usage": {
        const used =
          typeof event.promptTokens === "number"
            ? event.promptTokens
            : typeof event.totalTokens === "number"
              ? event.totalTokens
              : null;
        if (used != null) {
          this.applyContextUsage(
            {
              usedTokens: used,
              source: "provider",
              ...(typeof event.cachedTokens === "number"
                ? { cachedTokens: event.cachedTokens }
                : {}),
            },
            "stream:usage",
          );
        } else {
          console.debug("[context-usage] stream usage ignored (no tokens)", {
            sessionId: this.sessionId,
            event,
            kept: this.contextUsage.usedTokens,
          });
        }
        return;
      }
      case "context_display": {
        // Provider-only ring: main already gates estimate emissions; keep the
        // renderer guard so stale emitters can never push estimates either.
        if (event.source !== "provider") return;
        const used =
          typeof event.usedTokens === "number" ? event.usedTokens : null;
        if (used == null) return;
        this.applyContextUsage(
          {
            usedTokens: used,
            source: "provider",
            ...(typeof event.cachedTokens === "number"
              ? { cachedTokens: event.cachedTokens }
              : {}),
          },
          "stream:context_display",
        );
        return;
      }
      case "plan":
        void this.refreshPlanCards();
        return;
      case "plan_approval":
        this.planReviewError =
          typeof event.error === "string" && event.error.trim()
            ? event.error
            : null;
        void this.refreshPlanReview();
        return;
      case "phase":
      case "plan_phase": // legacy stream type
        // FSM resume signal only — Approve chrome keys off plan_approval /
        // planDoc.approvalPending, not Session.phase.
        return;
      case "subagent": {
        this.applySubagentStreamEvent(event);
        this.applySubagentRunningState(event);
        return;
      }
      case "subagent_live": {
        // Live subagent output stream — consumed by the standalone Subagents
        // window (it subscribes to the same agent:stream broadcast itself).
        // The footer count only keys off `subagent` lifecycle events.
        return;
      }
      case "prompt_queue": {
        // Authoritative snapshot from main after any queue mutation/drain.
        this.applyPromptQueueSnapshot(
          Array.isArray(event.items) ? (event.items as QueuedPrompt[]) : [],
        );
        return;
      }
      case "prompt_restored": {
        // STOP landed before any model content: main dropped the turn's
        // prompt from the transcript. Consume the latch (so a later remount
        // does not re-fire) and put the prompt back for a second edit.
        void requireBridge()
          .takePromptRestore(this.sessionId)
          .catch(() => {
            // Latch consumption is best-effort; the event already carries
            // the payload.
          });
        if (typeof event.text === "string") {
          this.restorePromptToComposer(
            event.text,
            Array.isArray(event.attachments)
              ? (event.attachments as Array<{
                  path: string;
                  name: string;
                  kind: string;
                  mimeType: string;
                  sizeBytes?: number;
                }>)
              : [],
          );
        }
        this.scheduleStructuralRefresh();
        return;
      }
      case "steer_consumed": {
        const id = typeof event.id === "string" ? event.id : "";
        if (id) {
          // Row removal already arrived via `prompt_queue`; this event only
          // means the inserted message is now part of the transcript.
          this.promptQueue = this.promptQueue.filter((item) => item.id !== id);
          this.renderPromptQueue();
        }
        this.scheduleStructuralRefresh();
        return;
      }
      case "error": {
        this.sessionStatus = "error";
        this.isLocallyStreaming = false;
        this.view.setRunning(false);
        this.sending = false;
        this.syncSendEnabled();
        this.emitContextPill();
        this.view.setStatusLine("", false);
        // Transcript message is persisted by main; refresh to pick it up.
        this.scheduleStructuralRefresh();
        // Queue is intentionally preserved on error (main holds it): the user
        // decides whether the queued follow-ups still apply.
        this.renderPromptQueue();
        return;
      }
      default:
        if (event.type === "done") {
          this.isLocallyStreaming = false;
          this.view.finalizeStreamingDisplay();
          void this.onTurnDone();
          return;
        }
        this.scheduleStructuralRefresh();
    }
  }

  /** After a turn finishes: fetch provider balance (if any), then finalize the turn in place. */
  private async onTurnDone(): Promise<void> {
    await this.fetchProviderBalance();
    await this.toolRenderQueue;
    this.finalizeTurnCoalesce.schedule();
    void this.refreshGitStats();
  }

  /**
   * Turn-end incremental finalize: rebuild only the latest turn (summary
   * blocks + missed rows) instead of the whole window. Falls back to a full
   * window render whenever the state does not line up.
   */
  private async finalizeTurn(): Promise<void> {
    if (this.destroyed) return;
    try {
      const tail = await requireBridge().getSessionTail(this.sessionId, {
        turns: 1,
      });
      if (this.destroyed) return;
      if (!tail) {
        await this.refresh();
        return;
      }
      const session = this.displaySession(tail.session);
      // A new turn started while we fetched — the mid-turn incremental path
      // owns the DOM now; the missed ended-divider lands on the next end.
      if (session.status === "running") {
        this.assistantSliceRefresh.schedule();
        return;
      }
      const ok = await this.view.finalizeTurn(
        session.messages,
        this.renderContextOptions(session),
      );
      if (!ok) {
        this.transcriptRenderKey = "";
        await this.refresh();
        return;
      }
      this.isLocallyStreaming = false;
      this.applySessionMetadata(session);
      this.restoreWriteStreamPreviews();
    } catch (err) {
      console.error("[conversation] finalize turn failed", err);
      await this.refresh();
    }
  }

  private async fetchProviderBalance(): Promise<void> {
    const bridge = requireBridge();
    if (typeof bridge.getProviderBalance !== "function") {
      this.lastTurnBalanceText = null;
      return;
    }
    try {
      const result = await bridge.getProviderBalance(
        this.providerId ? { providerId: this.providerId } : {},
      );
      this.lastTurnBalanceText =
        typeof result.text === "string" && result.text.trim()
          ? result.text.trim()
          : null;
    } catch (err) {
      console.debug("[conversation] provider balance unavailable", err);
      this.lastTurnBalanceText = null;
    }
  }

  private async refreshPlanCards(): Promise<void> {
    try {
      const saved = await requireBridge().getSession(this.sessionId);
      const session = saved ? this.displaySession(saved) : null;
      if (!session) return;
      const ctx = buildMessageRenderContext(
        session.messages,
        this.renderContextOptions(session),
      );
      const latestUser = this.findLatestUserMessage(session.messages);
      if (latestUser) {
        this.view.reconcileUserMessage(latestUser, ctx);
      }
      this.view.syncPlanCards(ctx);
      this.applySessionMetadata(session);
    } catch (err) {
      console.error("[conversation] refresh plan cards failed", err);
    }
  }

  private applySubagentStreamEvent(event: StreamEvent): void {
    const id = typeof event.id === "string" ? event.id : "";
    const parentToolCallId =
      typeof event.parentToolCallId === "string" ? event.parentToolCallId : "";
    const title = typeof event.title === "string" ? event.title : "Subagent";
    const status = asSubagentStatus(event.status);
    if (!id || !parentToolCallId || !status) return;

    const prev = this.subagentsByToolCallId.get(parentToolCallId);
    const usedTokens =
      typeof event.usedTokens === "number" &&
      Number.isFinite(event.usedTokens) &&
      event.usedTokens > 0
        ? Math.max(0, Math.round(event.usedTokens))
        : prev?.usedTokens;
    const next: SubagentCardSnapshot = {
      id,
      parentToolCallId,
      title,
      status,
      ...(typeof event.progressText === "string"
        ? { progressText: event.progressText }
        : prev?.progressText
          ? { progressText: prev.progressText }
          : {}),
      ...(typeof event.summary === "string"
        ? { summary: event.summary }
        : prev?.summary
          ? { summary: prev.summary }
          : {}),
      ...(typeof event.errorMessage === "string"
        ? { errorMessage: event.errorMessage }
        : prev?.errorMessage
          ? { errorMessage: prev.errorMessage }
          : {}),
      ...(prev?.role ? { role: prev.role } : {}),
      ...(typeof usedTokens === "number" ? { usedTokens } : {}),
    };
    this.subagentsByToolCallId.set(parentToolCallId, next);
    // Patch the dispatch card wherever it lives (not only the last assistant).
    const patched = this.view.updateSubagentDispatchCard(parentToolCallId, {
      status,
      ...(typeof usedTokens === "number" ? { usedTokens } : {}),
    });
    if (!patched) {
      // Card may not be in the DOM yet (tool_finished still queued).
      this.assistantSliceRefresh.schedule();
    }
  }

  /** Footer count from `subagent` lifecycle events (queued/running vs terminal). */
  private applySubagentRunningState(event: StreamEvent): void {
    const id = typeof event.id === "string" ? event.id : "";
    const status = asSubagentStatus(event.status);
    if (!id || !status) return;
    const isLive = status === "queued" || status === "running";
    const wasLive = this.runningSubagentIds.has(id);
    if (isLive !== wasLive) {
      if (isLive) {
        this.runningSubagentIds.add(id);
      } else {
        this.runningSubagentIds.delete(id);
      }
      this.view.gitBar.setSubagentCount(this.runningSubagentIds.size);
    }
  }

  /** Open/focus the standalone Subagents window bound to this session. */
  private openSubagentsWindow(): void {
    const bridge = window.jellybot;
    if (!bridge?.openSubagentsWindow) return;
    bridge
      .openSubagentsWindow(this.sessionId)
      .catch((err: unknown) => {
        console.error("[conversation] open subagents window failed", err);
      });
  }

  /** Remount mid-run: pull live snapshots so the count starts correct. */
  private async bootstrapRunningSubagents(): Promise<void> {
    try {
      const bridge = window.jellybot;
      if (!bridge?.listRunningSubagents) return;
      const snapshots = await bridge.listRunningSubagents(this.sessionId);
      for (const snap of snapshots ?? []) {
        if (snap?.id) this.runningSubagentIds.add(snap.id);
      }
      this.view.gitBar.setSubagentCount(this.runningSubagentIds.size);
    } catch (err) {
      console.error("[conversation] bootstrap running subagents failed", err);
    }
  }

  private scheduleStructuralRefresh(): void {
    if (this.sessionStatus === "running") {
      this.assistantSliceRefresh.schedule();
      return;
    }
    this.refreshCoalesce.schedule();
  }

  private enqueueFinishedTool(toolCallId: string, messageId: string): void {
    this.toolRenderQueue = this.toolRenderQueue
      .then(() => this.renderFinishedTool(toolCallId, messageId))
      .catch((err) => {
        console.error("[conversation] finished tool render failed", err);
      });
  }

  /**
   * Dev Mode write flash, fired from the finished-card render pass: the
   * card and the flash share one session snapshot and one diff parse —
   * what the card shows is exactly what flashes. A failed tool wrote
   * nothing (no flash at all); a successful patch re-anchors its ranges
   * to the post-apply file_diff parts (the args-side hunk lines drift
   * whenever the agent based its patch on a stale copy). With no result
   * part in the snapshot the args-parsed plan stands (best effort).
   */
  private emitFlashFromFinishedTool(
    session: {
      messages: Array<{
        parts: Array<{
          type: string;
          toolCallId?: string;
          returnCode?: number;
          content?: Array<Record<string, unknown>>;
        }>;
      }>;
    },
    toolCallId: string,
  ): void {
    const plan = this.pendingFlashPlans.get(toolCallId);
    if (!plan) return;
    this.pendingFlashPlans.delete(toolCallId);
    if (this.destroyed || !this.onFileWritten) return;
    let result:
      | { returnCode: number; content: Array<Record<string, unknown>> }
      | undefined;
    for (const message of session.messages) {
      for (const part of message.parts) {
        if (part.type !== "tool_result" || part.toolCallId !== toolCallId) {
          continue;
        }
        result = {
          returnCode:
            typeof part.returnCode === "number" ? part.returnCode : 1,
          content: Array.isArray(part.content)
            ? (part.content as Array<Record<string, unknown>>)
            : [],
        };
      }
    }
    let emit = plan;
    if (result) {
      if (result.returnCode !== 0) return;
      const trueRanges = patchResultFlashRanges(result.content);
      if (trueRanges.size > 0) {
        emit = plan.map((file) => {
          // Report paths are absolute (`Patching file /abs/...`); plan
          // paths are workspace-relative as the agent wrote them — match
          // on exact or path-segment suffix either way.
          const ranges = matchFlashRanges(trueRanges, file.path);
          return ranges ? { ...file, ranges } : file;
        });
      }
    }
    this.onFileWritten?.(emit);
  }

  /**
   * Run an order-sensitive view mutation (e.g. a live running tool card) on
   * the serial render queue, strictly after earlier queued text/tool renders.
   * Direct writes here would let a card overtake buffered assistant text
   * whenever the queue is momentarily busy (previous tool render / IPC).
   */
  private enqueueViewRender(render: () => void): void {
    this.toolRenderQueue = this.toolRenderQueue
      .then(() => {
        if (this.destroyed) return;
        render();
      })
      .catch((err) => {
        console.error("[conversation] queued view render failed", err);
      });
  }

  private scheduleWriteStreamPaint(): void {
    if (!this.writeStreamPaintReady) return;
    if (this.writeStreamPaintTimer != null || this.writeStreamPaintRaf != null) {
      this.writeStreamPaintQueued = true;
      return;
    }
    const elapsed = Date.now() - this.lastWriteStreamPaintAt;
    const delay = Math.max(0, WRITE_STREAM_PAINT_MIN_MS - elapsed);
    this.writeStreamPaintTimer = setTimeout(() => {
      this.writeStreamPaintTimer = null;
      this.writeStreamPaintRaf = requestAnimationFrame(() => {
        this.writeStreamPaintRaf = null;
        this.paintWriteStreamPreviews();
      });
    }, delay);
  }

  /** After hydrate / remount: paint every in-flight write stream for this session. */
  private restoreWriteStreamPreviews(): void {
    this.dirtyWriteStreamIds.clear();
    for (const entry of listWriteStreams(this.sessionId)) {
      this.dirtyWriteStreamIds.add(entry.id);
    }
    this.writeStreamPaintReady = true;
    if (this.dirtyWriteStreamIds.size > 0) {
      this.paintWriteStreamPreviews();
    }
  }

  private paintWriteStreamPreviews(): void {
    this.lastWriteStreamPaintAt = Date.now();
    const entries = listWriteStreams(this.sessionId);
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const id of [...this.dirtyWriteStreamIds]) {
      this.dirtyWriteStreamIds.delete(id);
      const entry = byId.get(id);
      if (!entry || !entry.messageId) continue;
      this.paintOneWriteStream(entry);
    }
    if (this.writeStreamPaintQueued) {
      this.writeStreamPaintQueued = false;
      this.scheduleWriteStreamPaint();
    }
  }

  private paintOneWriteStream(entry: WriteStreamEntry): void {
    // Hidden card: the stream keeps accumulating (session stays complete),
    // we just never paint a preview card for it.
    if (!isConversationCardVisible(entry.name)) return;
    const args: Record<string, unknown> = {};
    if (entry.path !== undefined) args.path = entry.path;
    if (entry.title !== undefined) args.title = entry.title;
    if (entry.content !== undefined) args.content = entry.content;
    if (entry.patchText !== undefined) args.patch = entry.patchText;
    if (entry.oldString !== undefined) args.old_string = entry.oldString;
    if (entry.newString !== undefined) args.new_string = entry.newString;
    const previewContent =
      entry.name === "patch"
        ? (entry.patchText ?? entry.newString ?? "")
        : (entry.content ?? "");
    this.view.upsertStreamingWriteCard({
      assistantMessageId: entry.messageId,
      toolCallId: entry.id,
      name: entry.name,
      argumentsRaw: entry.argumentsRaw,
      arguments: args,
      status: "pending",
      previewContent,
    });
  }

  private enqueueTextDelta(text: string, messageId: string): void {
    // A later model iteration may start before Electron has painted the preceding
    // tool cards. Wait for that render queue so transcript order stays strict:
    // assistant text → completed tools → next assistant text.
    void this.toolRenderQueue.then(() => {
      if (this.destroyed) return;
      this.flushPendingReasoning();
      this.isLocallyStreaming = this.view.appendStreamingText(text, messageId);
      this.syncTurnProgress();
    });
  }

  /**
   * A tool call ends the text segment. Runs after queued text deltas so the
   * streaming row is sealed in transcript order (assistant text → tools).
   */
  private foldHeldReplyAfterQueuedText(hint: string | null): void {
    void this.toolRenderQueue.then(() => {
      if (this.destroyed) return;
      this.view.foldHeldReplyIntoThought();
      if (hint) this.view.noteTurnToolHint(hint);
    });
  }

  private enqueueReasoningDelta(text: string, messageId: string): void {
    if (
      this.pendingReasoningMessageId &&
      this.pendingReasoningMessageId !== messageId
    ) {
      this.flushPendingReasoning();
    }
    this.pendingReasoningMessageId = messageId;
    this.pendingReasoningDelta += text;
    if (this.reasoningFlushScheduled) return;
    this.reasoningFlushScheduled = true;
    // One paint path per event-loop turn instead of one Promise per token.
    queueMicrotask(() => {
      void this.toolRenderQueue.then(() => {
        if (this.destroyed) return;
        this.reasoningFlushScheduled = false;
        this.flushPendingReasoning();
      });
    });
  }

  private flushPendingReasoning(): void {
    if (this.destroyed) return;
    const text = this.pendingReasoningDelta;
    const messageId = this.pendingReasoningMessageId;
    this.pendingReasoningDelta = "";
    if (!text || !messageId) return;
    this.view.appendStreamingReasoning(text, messageId);
  }

  private async renderFinishedTool(
    toolCallId: string,
    messageId: string,
  ): Promise<void> {
    if (this.destroyed) return;
    const saved = await requireBridge().getSession(this.sessionId);
      const session = saved ? this.displaySession(saved) : null;
    if (this.destroyed || !session) return;
    const assistantIndex = session.messages.findIndex(
      (message) => message.id === messageId && message.role === "assistant",
    );
    if (assistantIndex < 0) {
      this.emitFlashFromFinishedTool(session, toolCallId);
      return;
    }
    const assistant = session.messages[assistantIndex]!;
    const toolPart = assistant.parts.find(
      (part) => part.type === "tool_call" && part.id === toolCallId,
    );
    if (!toolPart) {
      this.emitFlashFromFinishedTool(session, toolCallId);
      return;
    }

    const ctx = buildMessageRenderContext(
      session.messages,
      this.renderContextOptions(session),
    );
    const userMessage = this.findTurnUserBefore(
      session.messages,
      assistantIndex,
    );
    if (userMessage) {
      this.view.reconcileUserMessage(userMessage, ctx);
    }
    this.view.upsertFinishedToolCard(messageId, toolCallId, toolPart, ctx);
    // Hidden tool: re-stamp its Thought record row with the terminal
    // duration/status (stamped main-side onto the part).
    {
      const hint = toolPart.name ? toolHintLabel(toolPart.name, toolPart.arguments) : null;
      if (hint) {
        this.view.noteTurnToolRecord({
          id: toolCallId,
          hint,
          ...(typeof toolPart.durationMs === "number" && Number.isFinite(toolPart.durationMs)
            ? { durationMs: toolPart.durationMs }
            : {}),
          ...(toolPart.status === "error" ? { failed: true } : {}),
        });
      }
    }
    this.applySessionMetadata(session);
    // Dev Mode flash rides the render pass — same snapshot the card was
    // built from, so the flashed lines are the card's diff lines.
    this.emitFlashFromFinishedTool(session, toolCallId);

    // Guarantee separate completed tools get separate paint opportunities.
    // Pure rAF stalls while the window is hidden (Windows minimises/occludes
    // aggressively; macOS keeps unfocused windows "visible"): the queue would
    // freeze and later appends would land after direct-write tool cards.
    // rAF wins the race on visible windows (fires well before 120ms); the
    // timer only takes over when rAF is frozen.
    await new Promise<void>((resolve) => {
      let done = false;
      const settle = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cancelAnimationFrame(raf);
        resolve();
      };
      const raf = requestAnimationFrame(() => settle());
      const timer = setTimeout(settle, 120);
    });
  }

  private applyContextUsage(
    incoming: {
      usedTokens: number;
      cachedTokens?: number;
      source?: "provider" | "estimate";
    },
    source: string,
  ): void {
    const previous = this.contextUsage.usedTokens;
    if (!shouldAcceptUsedTokens(previous, incoming.usedTokens)) {
      console.debug("[context-usage] keep previous usedTokens", {
        sessionId: this.sessionId,
        source,
        incoming,
        kept: previous,
        limitTokens: this.contextUsage.limitTokens,
      });
      this.pushContextUsage();
      return;
    }
    this.contextUsage = mergeContextUsage(this.contextUsage, {
      usedTokens: incoming.usedTokens,
      limitTokens: this.contextUsage.limitTokens,
      ...(incoming.source ? { source: incoming.source } : {}),
      ...(typeof incoming.cachedTokens === "number"
        ? { cachedTokens: incoming.cachedTokens }
        : {}),
    });
    if (previous !== this.contextUsage.usedTokens) {
      console.debug("[context-usage] update usedTokens", {
        sessionId: this.sessionId,
        source,
        from: previous,
        to: this.contextUsage.usedTokens,
        cachedTokens: this.contextUsage.cachedTokens ?? null,
        usageSource: this.contextUsage.source ?? null,
        limitTokens: this.contextUsage.limitTokens,
      });
    }
    this.pushContextUsage();
  }

  private renderContextOptions(
    session: NonNullable<Awaited<ReturnType<ReturnType<typeof requireBridge>["getSession"]>>>,
  ) {
    const bridge = requireBridge();
    return {
      sessionId: this.sessionId,
      sessionStatus: session.status,
      revealLabel: this.revealLabel(),
      onOpenFile: (path: string) => void this.openFile(path),
      onRevealFile: (path: string) => void this.revealFile(path),
      onSaveFile: (path: string) => void this.saveFileAs(path),
      onOpenUrl: (url: string) => void this.openUrl(url),
      onLoadFilePreview: (path: string) => this.loadFilePreview(path),
      onOpenFileReader: (path: string) => this.openFileInReader(path),
      filterExistingFiles,
      historySince: this.historyWindowMs ? Date.now() - this.historyWindowMs : undefined,
      turnStartMessageIds: this.displayTurnStarts,
      pendingAsks: this.externalPrompts ? [] : this.pendingAsks,
      plan: session.plan ?? null,
      providerBalanceText: this.lastTurnBalanceText,
      subagentsByToolCallId: this.subagentsByToolCallId,
      onUserAskAnswer: (requestId: string, answer: { selected: string; selections?: string[]; custom: boolean; comment?: string }) => {
        if (this.readOnly) return;
        void bridge.respondUserAsk?.({
          requestId,
          ...(answer.selections && answer.selections.length > 0
            ? { selections: answer.selections }
            : { selected: answer.selected }),
          custom: answer.custom,
          ...(answer.comment ? { comment: answer.comment } : {}),
        });
      },
      onAbortToolCall: (toolCallId: string) => {
        this.abortToolCall(toolCallId);
      },
      onReclaimUserPrompt: () => {
        this.reclaimRunningPrompt();
      },
      onRetryTurnError: (payload: TurnErrorRetryPayload) =>
        this.retryTurnError(payload),
      queuedPrompts: this.promptQueue.map((item) => item.text),
      demoStates: this.demoStates,
      onSubmitDemoParams: (
        toolCallId: string,
        values: Record<string, string | number | boolean | null>,
        note?: string,
      ) => {
        return this.submitDemoConfirm(toolCallId, values, note);
      },
    };
  }

  /**
   * Retry click on an error card.
   *
   * Transcript-backed error rows (payload.continuation === "retry"):
   * consume the persisted error row (so it never resurfaces on the next
   * full render), then start a HIDDEN continuation turn — the model gets a
   * "continue the task" instruction (RETRY_CONTINUATION_PROMPT) marked
   * UI-hidden; the original prompt and partial work stay in the transcript,
   * so nothing is resent and no user bubble appears.
   *
   * Ephemeral failures (no errorMessageId; the turn never started, the
   * prompt was never persisted): resend the payload's prompt through the
   * normal send path — otherwise the task would be lost.
   *
   * Returns false when the retry was rejected (running turn, consume
   * failure) so the card can un-collapse its pill.
   */
  private async retryTurnError(payload: TurnErrorRetryPayload): Promise<boolean> {
    if (this.readOnly) return false;
    if (this.retryOverride) return this.retryOverride(payload);
    if (this.destroyed) return false;
    if (this.sessionStatus === "running" || this.sending) return false;
    if (payload.continuation === "retry") {
      if (payload.errorMessageId) {
        try {
          const result = await requireBridge().removeTurnError(
            this.sessionId,
            payload.errorMessageId,
          );
          if (!result.ok) {
            this.view.setStatusLine(`Retry unavailable — ${result.error}`, true);
            return false;
          }
        } catch (err) {
          console.error("[conversation] removeTurnError failed", err);
          this.view.setStatusLine(
            "Retry unavailable — could not clear the failed turn",
            true,
          );
          return false;
        }
      }
      await this.startRetryContinuationTurn().catch(() => {
        // startRetryContinuationTurn's own catch surfaced the error card.
      });
      return true;
    }
    const text = payload.text ?? "";
    const attachments = payload.attachments ?? [];
    if (!text.trim() && attachments.length === 0) return false;
    await this.startFollowUpTurn(
      text,
      attachments.map((item) => ({
        id: crypto.randomUUID(),
        path: item.path,
        name: item.name,
        kind: item.kind,
        mimeType: item.mimeType,
        ...(item.sizeBytes !== undefined
          ? { sizeBytes: item.sizeBytes }
          : {}),
      })),
    ).catch(() => {
      // startFollowUpTurn's own catch already surfaced the error card.
    });
    return true;
  }

  /**
   * Hidden continuation turn (Retry click): submit RETRY_CONTINUATION_PROMPT
   * with continuation: "retry". No optimistic user row, no context-pill
   * text — the instruction must never surface. Same running-state handling
   * as startFollowUpTurn.
   */
  private async startRetryContinuationTurn(): Promise<void> {
    this.sending = true;
    this.sessionStatus = "running";
    this.isLocallyStreaming = false;
    this.view.setRunning(true);
    this.syncTurnProgress("Waiting for model…");
    // Drop a queued full refresh so it cannot race the running state. Must
    // not call cancel() — that permanently disables schedule() and skips
    // the end-of-turn rebuild (Completed · … footer, modified files, etc.).
    this.refreshCoalesce.clearPending();
    this.syncSendEnabled();
    try {
      const prefs = this.getPrefs();
      const customGraphId =
        prefs.runMode === "custom" &&
        typeof prefs.fsmGraphId === "string" &&
        prefs.fsmGraphId.length > 0
          ? prefs.fsmGraphId
          : undefined;
      await requireBridge().startTurn({
        sessionId: this.sessionId,
        userText: RETRY_CONTINUATION_PROMPT,
        fullPermissions: isFullPermissionsEnabled(),
        autoSkillSummarize: isAutoSkillSummarizeEnabled(),
        runMode: prefs.runMode,
        ...(customGraphId !== undefined ? { fsmGraphId: customGraphId } : {}),
        reasoningEffort: prefs.reasoningEffort,
        continuation: "retry",
      });
    } catch (err) {
      this.sending = false;
      this.sessionStatus = "error";
      this.view.setRunning(false);
      this.syncSendEnabled();
      this.emitContextPill();
      const message = err instanceof Error ? err.message : String(err);
      this.view.appendTurnErrorMessage(message, {
        // Ephemeral failure (turn never started): nothing persisted to
        // consume — retry re-runs the hidden continuation.
        payload: { continuation: "retry" },
        onRetry: (payload) => this.retryTurnError(payload),
      });
      throw err instanceof Error ? err : new Error(message);
    }
  }

  /**
   * Click on the running turn's prompt card = Stop. While the turn has not
   * produced visible model content yet, main's STOP-rollback drops the
   * prompt message from the transcript and fires prompt_restored, which
   * lands the text (and attachment chips) back in the composer for a
   * second edit.
   */
  private reclaimRunningPrompt(): void {
    if (this.readOnly) return;
    if (this.destroyed || this.sessionStatus !== "running") return;
    void requireBridge()
      .cancelTurn(this.sessionId)
      .catch((err) => {
        console.error("[conversation] reclaim prompt stop failed", err);
      });
  }

  private abortToolCall(toolCallId: string): void {
    if (this.readOnly) return;
    const bridge = requireBridge();
    void bridge
      .abortToolCall({ sessionId: this.sessionId, toolCallId })
      .catch((err) => {
        console.error("[conversation] abort tool call failed", err);
      });
  }

  private applySessionMetadata(
    session: NonNullable<Awaited<ReturnType<ReturnType<typeof requireBridge>["getSession"]>>>,
  ): void {
    const running = session.status === "running";
    this.sessionStatus = session.status;
    this.lastMessages = session.messages;
    const nextPath =
      typeof session.workspacePath === "string"
        ? session.workspacePath.trim()
        : "";
    this.workspacePath = nextPath;
    this.providerId =
      typeof session.providerId === "string" ? session.providerId.trim() : "";
    // Context pill caches: latest prompt + active plan from this snapshot.
    const latestUser = this.findLatestUserMessage(session.messages);
    this.pillUserText = latestUser
      ? pillTextFromParts(latestUser.parts)
      : null;
    this.pillUserFiles = latestUser
      ? pillFilesFromParts(latestUser.parts)
      : null;
    this.pillPlan =
      session.plan &&
      session.plan.status === "active" &&
      session.plan.steps.length > 0
        ? {
            title: session.plan.title,
            steps: session.plan.steps.map((step) => ({
              title: step.title,
              state: pillStepState(step.status),
            })),
          }
        : null;
    this.hydrateComposerPrefsFromSession(session);
    this.view.setRunning(running);
    this.providersBinding?.refresh();
    this.view.setUserPromptReclaimability(session.messages, session.status);
    this.syncTurnProgress(session.progressText);
    this.emitContextPill();
    this.sending = running;
    this.syncSendEnabled();
    // Queue rows persist across turn boundaries; only the palette follows the
    // running flag.
    this.view.setPromptQueueIdle(!running);

    // Provider-only ring: persisted estimate readings (post-compact BPE,
    // displayUsedTokens previews) never drive the composer display. The ring
    // keeps its last provider value (0 on a fresh mount) until a usage event.
    const persistedUsage = session.contextUsage;
    const sessionUsed =
      persistedUsage?.source === "provider" &&
      isValidUsedTokens(persistedUsage.usedTokens)
        ? persistedUsage.usedTokens
        : null;
    if (
      sessionUsed != null &&
      shouldAcceptUsedTokens(this.contextUsage.usedTokens, sessionUsed)
    ) {
      this.applyContextUsage(
        {
          usedTokens: sessionUsed,
          source: "provider",
          ...(typeof persistedUsage?.cachedTokens === "number"
            ? { cachedTokens: persistedUsage.cachedTokens }
            : {}),
        },
        "session:metadata",
      );
    } else {
      if (sessionUsed != null && sessionUsed === 0) {
        console.debug("[context-usage] session usedTokens=0 ignored", {
          sessionId: this.sessionId,
          status: session.status,
          kept: this.contextUsage.usedTokens,
        });
      }
      this.pushContextUsage();
    }
    this.syncPlanReviewFromSession(session);
  }

  private syncPlanReviewFromSession(
    session: NonNullable<Awaited<ReturnType<ReturnType<typeof requireBridge>["getSession"]>>>,
  ): void {
    const active =
      session.planDoc?.approvalPending === true && session.status !== "running";
    // Chime only when the bar newly appears while this screen is live — not
    // on mount rehydrate (session switch) and not on the Approve-bounce
    // restore, where the bar never actually left the active state.
    if (active && !this.planReviewActive && this.planReviewSyncedOnce) {
      playPlanReviewChime();
    }
    this.planReviewActive = active;
    this.planReviewSyncedOnce = true;
    this.view.syncPlanReview({
      active,
      error: this.planReviewError,
      ...(session.planDoc?.summary
        ? { summary: session.planDoc.summary }
        : {}),
      ...(session.planDoc?.path ? { docPath: session.planDoc.path } : {}),
    });
  }

  private async refreshPlanReview(): Promise<void> {
    try {
      const session = await requireBridge().getSession(this.sessionId);
      if (!session) return;
      this.syncPlanReviewFromSession(session);
    } catch (err) {
      console.error("[conversation] refresh plan review failed", err);
    }
  }

  private async handlePlanApprove(): Promise<void> {
    // Approve is accepted immediately (task extraction runs in the background),
    // so the panel leaves right away instead of sitting in a busy state.
    this.planReviewError = null;
    this.view.dismissPlanReview();
    try {
      const result = await requireBridge().approvePlan(this.sessionId);
      if (!result.ok) {
        // Still in review — bring the panel back carrying the reason.
        await this.restorePlanReview(result.error);
        return;
      }
      await this.refresh();
    } catch (err) {
      await this.restorePlanReview(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async handlePlanDiscard(): Promise<void> {
    this.planReviewError = null;
    this.view.dismissPlanReview();
    try {
      const result = await requireBridge().discardPlan(this.sessionId);
      if (!result.ok) {
        await this.restorePlanReview(result.error);
        return;
      }
      await this.refresh();
    } catch (err) {
      await this.restorePlanReview(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Bring the dismissed review panel back with the reason it could not run. */
  private async restorePlanReview(message: string): Promise<void> {
    this.planReviewError = message;
    this.view.setPlanReviewBusy(false, message);
    try {
      const session = await requireBridge().getSession(this.sessionId);
      if (session) this.syncPlanReviewFromSession(session);
    } catch (err) {
      console.error("[conversation] restore plan review failed", err);
    }
  }

  private findLastAssistantIndex(
    messages: Array<{ role: string }>,
  ): number {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === "assistant") return i;
    }
    return -1;
  }

  private findTurnUserBefore(
    messages: Array<{
      id?: string;
      role: string;
      parts: Array<Record<string, unknown>>;
    }>,
    assistantIndex: number,
  ): (typeof messages)[number] | null {
    for (let i = assistantIndex - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === "user") return messages[i]!;
    }
    return null;
  }

  private async refreshLastAssistant(): Promise<void> {
    if (this.destroyed) return;
    try {
      // One-turn tail slice: everything this reconcile touches (last user +
      // last assistant + their in-turn tool pairings) lives in the last turn,
      // so the full transcript never crosses the IPC boundary mid-turn.
      const tail = await requireBridge().getSessionTail(this.sessionId, {
        turns: 1,
      });
      if (this.destroyed || !tail) return;
      const session = this.displaySession(tail.session);

      // Mid-turn slice refresh must not collapse live Thinking — that dropped
      // the running spinner until (or unless) a new ephemeral block appeared.
      this.view.finalizeStreamingDisplay({
        keepReasoning: this.view.hasLiveStreamingReasoning(),
      });

      const ctx = buildMessageRenderContext(
        session.messages,
        this.renderContextOptions(session),
      );

      const assistantIndex = this.findLastAssistantIndex(session.messages);
      if (assistantIndex < 0) {
        // Plan-mode side-path can sit for a long time with only the user
        // message — still surface / reconcile that prompt immediately.
        const latestUser = this.findLatestUserMessage(session.messages);
        if (latestUser) {
          this.view.reconcileUserMessage(latestUser, ctx);
        }
        this.applySessionMetadata(session);
        return;
      }

      const assistant = session.messages[assistantIndex]!;
      const userMessage = this.findTurnUserBefore(
        session.messages,
        assistantIndex,
      );

      if (userMessage) {
        this.view.reconcileUserMessage(userMessage, ctx);
      }
      await this.view.upsertAssistantMessage(assistant, ctx);
      this.applySessionMetadata(session);
    } catch (err) {
      console.error("[conversation] refresh last assistant failed", err);
    }
  }

  private findLatestUserMessage(
    messages: Array<{
      id?: string;
      role: string;
      parts: Array<Record<string, unknown>>;
    }>,
  ): (typeof messages)[number] | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === "user") return messages[i]!;
    }
    return null;
  }

  /**
   * Push the context-pill snapshot to Dev Mode (or the normal-mode local
   * pill); no-op when unchanged (field-wise compare over exactly what the
   * pill renders).
   */
  private pushContextUsage(): void {
    this.view.setContextUsage(this.contextUsage);
    this.onContextUsage?.(this.contextUsage);
  }

  private emitContextPill(): void {
    const snapshot: ContextPillSnapshot = {
      running: this.sessionStatus === "running" || this.sending,
      // Anchor text once the view has rows; before that (pre-render) the
      // latest transcript prompt is the best guess.
      lastUserText: this.pillAnchorText ?? this.pillUserText,
      lastUserFiles:
        this.pillAnchorText !== null
          ? this.pillAnchorFiles
          : this.pillUserFiles,
      progressText: this.lastProgressText,
      plan: this.pillPlan,
      promptVisible: this.pillPromptVisible,
    };
    if (sameContextPillSnapshot(this.lastPillSnapshot, snapshot)) return;
    this.lastPillSnapshot = snapshot;
    if (this.onContextPill) this.onContextPill(snapshot);
    else this.localPill?.update(snapshot);
  }

  /**
   * Command feedback for executed slash commands / workspace tasks — the
   * top context pill's notice state (replaces the old composer-side
   * floating hint bar). Long texts stay single-line readable in the narrow
   * Dev Mode chat pane; the pill's tooltip keeps the full text.
   */
  private notifyHint(
    text: string,
    durationMs?: number,
    spinner = false,
  ): void {
    if (this.onPillNotice) this.onPillNotice(text, durationMs, spinner);
    else this.localPill?.showNotice(text, durationMs, { spinner });
  }

  private applySessionSummary(summary: SessionSummary): void {
    const running = summary.status === "running";
    this.sessionStatus = summary.status;
    this.view.setRunning(running);
    this.syncTurnProgress(summary.progressText);
    this.sending = running;
    this.syncSendEnabled();
    this.pushContextUsage();
    this.view.setPromptQueueIdle(!running);
    this.emitContextPill();
  }

  private syncTurnProgress(progressText?: string): void {
    if (this.quietCurrentTurn?.()) { this.view.setStatusLine("", false); return; }
    if (progressText !== undefined) {
      this.lastProgressText = progressText;
    }
    this.emitContextPill();
    const show = shouldShowTurnProgress({
      progressText: this.lastProgressText,
      messages: this.lastMessages,
      sessionStatus: this.sessionStatus,
      isLocallyStreaming: this.isLocallyStreaming,
      overrideActive: this.compacting,
      toolCardOwnsProgress: this.toolCardOwnsProgress(),
    });
    this.view.setStatusLine(this.lastProgressText, show);
  }

  /**
   * True while a card-painting tool owns the progress line — its card
   * self-describes, so no status row / Thinking shell may sit beside it
   * (Write/Patch during args streaming, execution, and approval waits).
   * Card-less tools (read/grep/shell) keep the status row + hint chips.
   */
  private toolCardOwnsProgress(): boolean {
    // Latest progress line is attributed to a card tool — stays suppressed
    // past tool_finished so stale session summaries don't flash it back.
    if (
      this.lastProgressToolName &&
      isConversationCardVisible(this.lastProgressToolName)
    ) {
      return true;
    }
    // Execution window (also covers approval/ask waits on card tools).
    if (this.cardToolCallIds.size > 0) return true;
    // Args still streaming, tool_call not materialized yet: write-family
    // preview cards are already on screen (writeStreamState).
    return someWriteStream(
      this.sessionId,
      (entry) => !entry.called && isConversationCardVisible(entry.name),
    );
  }

  /** Session-keyed composer prefs (resolved: pinned row values → defaults). */
  private getPrefs(): SessionComposerPrefs {
    return getComposerPrefs(this.sessionId);
  }

  private applyComposerPrefs(prefs: SessionComposerPrefs): void {
    if (prefs.runMode === "custom" && prefs.fsmGraphId) {
      this.view.setCustomGraphSelection({
        id: prefs.fsmGraphId,
        name: prefs.fsmGraphId,
      });
      // Resolve display name asynchronously when possible.
      void window.jellybot?.getFsmGraph?.(prefs.fsmGraphId).then((record) => {
        if (!record) return;
        const current = this.getPrefs();
        if (
          current.runMode === "custom" &&
          current.fsmGraphId === prefs.fsmGraphId
        ) {
          this.view.setCustomGraphSelection({
            id: record.id,
            name: record.name,
            color: record.color,
          });
        }
      });
    } else {
      this.view.setComposerRunMode(prefs.runMode);
    }
    this.view.setInfiniteEnabled(prefs.infinite);
    this.view.setReasoningEffort(prefs.reasoningEffort);
    this.view.setHandoffEnabled(prefs.handoffEnabled);
  }

  /** Sync the keyed store from the session row (unpinned → follows defaults). */
  private hydrateComposerPrefsFromSession(session: {
    composerRunMode?: "agent" | "ask" | "plan" | "custom" | null;
    composerFsmGraphId?: string | null;
    composerInfinite?: boolean | null;
    reasoningEffort?: ReasoningEffort | null;
    handoffEnabled?: boolean | null;
  }): void {
    hydrateComposerPrefs(this.sessionId, {
      runMode: session.composerRunMode ?? null,
      fsmGraphId: session.composerFsmGraphId ?? null,
      infinite: session.composerInfinite ?? null,
      reasoningEffort: session.reasoningEffort ?? null,
      handoffEnabled: session.handoffEnabled ?? null,
    });
  }

  private syncSendEnabled(): void {
    const hasText = this.view.getPrompt().trim().length > 0;
    const hasAttachments =
      (this.attachmentsApi?.getAttachments().length ?? 0) > 0;
    const hasContent = hasText || hasAttachments;
    if (this.sending) {
      // Button mirrors the gesture resolver so its icon never lies about what
      // Enter would do: Stop only when there is nothing to send or queue.
      const action = resolveComposerSubmitAction({
        hasContent,
        running: true,
        queueHasDeferred: this.promptQueue.some(
          (item) => item.mode === "deferred",
        ),
      });
      this.view.setStopMode(action === "stop", {
        steer: action === "enqueue" || action === "promote-head",
      });
      this.view.setSendEnabled(!this.composerSubmitting);
      return;
    }

    this.view.setStopMode(false);
    this.view.setSendEnabled(
      hasContent && !this.optimizingPrompt && !this.composerSubmitting,
    );
  }

  private bind(): void {
    this.view.setOnReasoningEffortSelect((level) => {
      setComposerPrefsFor(this.sessionId, { reasoningEffort: level });
    });

    this.view.textarea.addEventListener("input", () => {
      this.syncSendEnabled();
      this.scheduleDraftSave();
    });

    // Slash commands (/pause /resume /compact) are consumed here and never
    // reach the model as prompt text.
    this.view.composer.setOnSlashCommand((command) => {
      void this.executeSlashCommand(command);
      return true;
    });
    // Slash popup scope: the conversation composer shows the full registry;
    // the only filter is /dev, hidden when its host did not wire the
    // toggle (both layouts wire it today — normal shell and Dev Mode).
    this.view.composer.setSlashCommandScope(
      this.onToggleDevMode
        ? null
        : SLASH_COMMANDS.filter((c) => c.name !== DEV_MODE_COMMAND).map(
            (c) => c.name,
          ),
    );

    this.view.sendButton.addEventListener("click", () => {
      void this.runComposerSubmitAction();
    });

    this.view.textarea.addEventListener("keydown", (event) => {
      if (event.key.toLowerCase() === "m" && event.metaKey && event.shiftKey) {
        event.preventDefault();
        // Provider menu is read-only while a turn runs — the combo shortcut
        // must respect the same lock (bindComposerProviders.isLocked parity).
        if (this.sessionStatus === "running" || this.sending === true) return;
        toggleInfiniteMaxCombo(this.sessionId);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !isImeComposing(event)) {
        event.preventDefault();
        if (event.repeat) return;
        void this.runComposerSubmitAction({ respectDisabled: true });
      }
    });
  }

  /**
   * Single entry point for the submit gesture (Enter and the send button share
   * it) so both stay in lockstep with `resolveComposerSubmitAction`.
   */
  private async runComposerSubmitAction(options?: {
    respectDisabled?: boolean;
  }): Promise<void> {
    const hasContent =
      this.view.getPrompt().trim().length > 0 ||
      (this.attachmentsApi?.getAttachments().length ?? 0) > 0;
    if (this.composerSubmitting) {
      // A deliberate second Enter may arrive before the enqueue reply. Wait
      // for that item rather than treating the still-empty queue as Stop.
      if (
        options?.respectDisabled &&
        this.composerEnqueuePending &&
        !hasContent
      ) {
        this.insertAfterEnqueue = true;
      }
      return;
    }
    const action = resolveComposerSubmitAction({
      hasContent,
      running: this.sending,
      queueHasDeferred: this.promptQueue.some(
        (item) => item.mode === "deferred",
      ),
    });
    if (
      action === "send" &&
      options?.respectDisabled &&
      this.view.sendButton.disabled
    ) return;
    this.composerSubmitting = true;
    this.syncSendEnabled();
    try {
      switch (action) {
        case "send":
          await this.sendFollowUp();
          return;
        case "enqueue": {
          this.composerEnqueuePending = true;
          const queued = await this.enqueueComposerPrompt();
          if (queued && this.insertAfterEnqueue && this.sending && !this.destroyed) {
            const head = this.promptQueue.find((item) => item.mode === "deferred");
            if (head) await this.promoteQueuedPrompt(head.id);
          }
          return;
        }
        case "promote-head": {
          // Enter on an empty composer = "insert the next queued message now".
          const head = this.promptQueue.find((item) => item.mode === "deferred");
          if (head) await this.promoteQueuedPrompt(head.id);
          return;
        }
        case "stop":
          await requireBridge().cancelTurn(this.sessionId);
          return;
        default:
          return;
      }
    } finally {
      this.composerSubmitting = false;
      this.composerEnqueuePending = false;
      this.insertAfterEnqueue = false;
      if (!this.destroyed) this.syncSendEnabled();
    }
  }

  /**
   * Put a STOP-rollback prompt back into the composer. Never clobbers new
   * input: if the user already typed something (or re-attached files) after
   * stopping, the restore is skipped — the transcript refresh still runs.
   */
  private restorePromptToComposer(
    text: string,
    attachments: Array<{
      path: string;
      name: string;
      kind: string;
      mimeType: string;
      sizeBytes?: number;
    }>,
  ): void {
    if (this.promptRestoreOverride) { this.promptRestoreOverride(text); return; }
    const hasInput =
      this.view.getPrompt().trim().length > 0 ||
      (this.attachmentsApi?.getAttachments().length ?? 0) > 0;
    if (hasInput) return;
    this.view.composer.setPrompt(text);
    setSessionDraft(this.sessionId, text);
    if (attachments.length > 0) {
      this.attachmentsApi?.restore(
        attachments.map((item) => ({
          id: crypto.randomUUID(),
          path: item.path,
          name: item.name,
          kind: item.kind,
          mimeType: item.mimeType,
          ...(item.sizeBytes !== undefined
            ? { sizeBytes: item.sizeBytes }
            : {}),
        })),
      );
    }
    this.view.focusInput();
    this.syncSendEnabled();
  }

  /**
   * Remount fallback for `prompt_restored`: the one-shot stream event fired
   * while this screen was unmounted, so ask main for the latched payload.
   */
  private async consumePendingPromptRestore(): Promise<void> {
    if (this.destroyed) return;
    try {
      const payload = await requireBridge().takePromptRestore(
        this.sessionId,
      );
      if (!payload || this.destroyed) return;
      this.restorePromptToComposer(payload.text, payload.attachments);
    } catch {
      // Older main (no channel) or unknown session — nothing to restore.
    }
  }

  private async loadContextLimit(): Promise<void> {
    try {
      const settings = await requireBridge().getWorkspaceSettings();
      const limit =
        typeof settings?.contextLimitTokens === "number" &&
        settings.contextLimitTokens > 0
          ? settings.contextLimitTokens
          : 128_000;
      this.contextUsage = normalizeContextUsage({
        ...this.contextUsage,
        limitTokens: limit,
      });
      this.pushContextUsage();
    } catch (err) {
      console.error("[conversation] load context limit failed", err);
    }
  }

  private displaySession(session: Session): Session {
    const recent = this.historyWindowMs ? recentMessages(session.messages, Date.now() - this.historyWindowMs) : session.messages;
    const messages = this.textOnlyMessageIds ? textOnlyMessages(recent, this.textOnlyMessageIds()) : recent;
    const starts = this.turnStartMessageIds?.();
    this.displayTurnStarts = starts?.size ? shownTurnStarts(recent, messages, starts) : undefined;
    return messages === session.messages ? session : { ...session, messages };
  }

  private async refresh(): Promise<void> {
    if (this.destroyed) return;
    this.writeStreamPaintReady = false;
    try {
      const bridge = requireBridge();
      const [tail, pendingAsks, pendingApprovals] = await Promise.all([
        this.historyWindowMs ? recentSessionTail(bridge, this.sessionId, Date.now() - this.historyWindowMs) : bridge.getSessionTail(this.sessionId),
        typeof bridge.listPendingUserAsks === "function"
          ? bridge.listPendingUserAsks(this.sessionId)
          : Promise.resolve([]),
        typeof bridge.listPendingToolApprovals === "function"
          ? bridge.listPendingToolApprovals(this.sessionId)
          : Promise.resolve([]),
      ]);
      if (this.destroyed) return;
      const session = tail?.session ? this.displaySession(tail.session) : null;
      if (this.destroyed) return;
      // Main is source of truth for in-flight asks/approvals (lost on remount
      // when the one-shot IPC broadcast fired while this screen was unmounted).
      this.pendingAsks = pendingAsks.map((ask) => ({
        requestId: ask.requestId,
        toolCallId: ask.toolCallId,
        question: ask.question,
        options: ask.options,
        ...(ask.optionDetails ? { optionDetails: ask.optionDetails } : {}),
        allowCustom: ask.allowCustom,
        allowMultiple: ask.allowMultiple === true,
      }));
      this.pendingApprovals = pendingApprovals.map((approval) => ({
        requestId: approval.requestId,
        toolName: approval.toolName,
        arguments: approval.arguments,
        expiresAt: approval.expiresAt,
        ...(approval.risk ? { risk: approval.risk } : {}),
      }));
      this.view.renderApprovals(this.externalPrompts ? [] : this.pendingApprovals);
      if (!session) {
        this.transcriptRenderKey = "";
        await this.view.renderMessages([], {
          sessionStatus: "idle",
          revealLabel: this.revealLabel(),
          onOpenFile: (path) => void this.openFile(path),
          onRevealFile: (path) => void this.revealFile(path),
          onSaveFile: (path) => void this.saveFileAs(path),
          onOpenUrl: (url) => void this.openUrl(url),
          onLoadFilePreview: (path) => this.loadFilePreview(path),
          onOpenFileReader: (path) => this.openFileInReader(path),
          pendingAsks: [],
        });
        this.view.setStatusLine("Session not found", true);
        this.view.setRunning(false);
        this.sending = false;
        this.syncSendEnabled();
        this.restoreWriteStreamPreviews();
        return;
      }
      const renderKey = JSON.stringify({
        messages: session.messages.map(message => [message.id, message.role, message.createdAt, message.parts]),
        asks: this.pendingAsks.map(ask => ask.requestId),
        approvals: this.pendingApprovals.map(approval => approval.requestId),
        status: session.status,
        window: tail?.window ?? null,
      });
      // Hourly-window / coalesced refreshes often re-fetch an identical transcript —
      // skip the full DOM rebuild so scroll position and live chrome stay put.
      if (renderKey === this.transcriptRenderKey) {
        this.applySessionMetadata(session);
        return;
      }
      this.transcriptRenderKey = renderKey;
      this.view.finalizeStreamingDisplay();
      await this.view.renderMessages(session.messages, {
        ...this.renderContextOptions(session),
        window: tail?.window ?? null,
        onLoadEarlier: () => void this.loadEarlierTurns(),
      });
      if (this.destroyed) return;
      this.isLocallyStreaming = false;
      this.applySessionMetadata(session);
      void this.refreshGitStats();
      // Remount / full hydrate wipes live write cards — restore from the
      // process-wide accumulator that kept collecting while we were away.
      this.restoreWriteStreamPreviews();
      // Same for a build still running in this workspace: remount its card.
      void this.restoreBuildCard();
    } catch (err) {
      console.error("[conversation] refresh failed", err);
      this.view.setStatusLine(
        err instanceof Error ? err.message : "Failed to load session",
        true,
      );
      this.restoreWriteStreamPreviews();
    }
  }

  /**
   * Page older turns in (progressive window). One in flight at a time; a
   * null page means the cursor message vanished (compact/clear rewrote the
   * transcript) — fall back to a full window rebuild.
   */
  private async loadEarlierTurns(): Promise<void> {
    if (this.destroyed || this.loadingEarlier || this.historyWindowMs) return;
    const cursor = this.view.currentWindowFirstMessageId();
    if (!cursor) return;
    this.loadingEarlier = true;
    this.view.setLoadEarlierBusy(true);
    try {
      const page = await requireBridge().getMessagesBefore(
        this.sessionId,
        cursor,
      );
      if (this.destroyed) return;
      if (!page) {
        await this.refresh();
        return;
      }
      await this.view.loadEarlierMessages(cursor, {
        messages: page.messages,
        window: {
          firstMessageId: page.firstMessageId,
          hasMore: page.hasMore,
          remainingTurns: page.remainingTurns,
        },
      });
    } catch (err) {
      console.error("[conversation] load earlier turns failed", err);
    } finally {
      this.loadingEarlier = false;
      this.view.setLoadEarlierBusy(false);
    }
  }

  /**
   * Coalesce rapid write-tool finishes into one git stats fetch: batches of
   * edit_file/write_file land back-to-back, and each refresh spawns git
   * status/diff subprocesses. First fetch fires ~200ms after the tool result
   * — imperceptible next to the git round trip itself.
   */
  private scheduleGitStatsRefresh(): void {
    if (this.gitStatsRefreshTimer != null) return;
    this.gitStatsRefreshTimer = setTimeout(() => {
      this.gitStatsRefreshTimer = null;
      void this.refreshGitStats();
    }, 200);
  }

  /**
   * Working-tree stats, at most one scan in flight.
   *
   * The sequence number below only discards stale *results* — it never stopped
   * a second scan from starting. Several callers fire on the same session
   * update, and one scan walks the whole working copy (seconds on a large SVN
   * checkout), so overlapping calls pile up subprocesses and disk reads until
   * the machine crawls. Requests arriving mid-scan collapse into a single
   * follow-up run.
   */
  private async refreshGitStats(): Promise<void> {
    if (this.transcriptOnly) return;
    if (this.gitStatsInFlight) {
      this.gitStatsRerunWanted = true;
      return;
    }
    const path = this.workspacePath.trim();
    if (!path) {
      this.view.gitBar.setStats(null);
      return;
    }
    const seq = ++this.gitStatsSeq;
    this.gitStatsInFlight = true;
    try {
      const stats = await requireBridge().getWorkingTreeStats(path);
      if (seq !== this.gitStatsSeq) return;
      this.view.gitBar.setStats(stats);
    } catch (err) {
      if (seq !== this.gitStatsSeq) return;
      console.debug("[conversation] git stats failed", err);
      this.view.gitBar.setStats(null);
    } finally {
      this.gitStatsInFlight = false;
      if (this.gitStatsRerunWanted && !this.destroyed) {
        this.gitStatsRerunWanted = false;
        void this.refreshGitStats();
      }
    }
  }

  private async runGitCommit(): Promise<void> {
    if (this.gitBusy) return;
    const path = this.workspacePath.trim();
    if (!path) return;
    if (this.sessionStatus === "running" || this.sending) {
      void requireBridge().alertDialog?.({
        title: "Commit",
        message: "Wait for the current turn to finish before committing.",
        type: "warning",
      });
      return;
    }
    this.gitBusy = true;
    this.view.gitBar.setBusy(true, "Committing…");
    try {
      const prepared = await requireBridge().prepareCommit(
        path,
        // Prefer the session's composer-selected provider for the message
        // draft; main falls back to the global active provider when empty.
        this.providerId.trim() || undefined,
      );
      const message = prepared.draftMessage.trim();
      if (!message) {
        throw new Error("Commit message is empty");
      }
      const created = await requireBridge().commitWorkspace({
        workspacePath: path,
        message,
      });
      void requireBridge().closeWorkspaceChangesWindow?.();
      await this.refreshGitStats();
      this.view.gitBar.setBusy(false);
      this.gitBusy = false;
      // Ephemeral notice only — the LLM does not need to know about the commit,
      // and the card is intentionally never persisted into the transcript.
      this.view.appendCommitCard(created, prepared.messageSource);
    } catch (err) {
      this.view.gitBar.setBusy(false);
      this.gitBusy = false;
      const text =
        err instanceof Error ? err.message : "Failed to create commit";
      void requireBridge().alertDialog?.({
        title: "Commit",
        message: text,
        type: "warning",
      });
      void this.refreshGitStats();
      console.error("[conversation] commit failed", err);
    }
  }

  /**
   * Push local commits to the remote — same call the Dev Mode outline Push
   * popover makes. No turn-busy guard: pushing never snapshots the working
   * tree, and remote-only failures surface via alertDialog.
   */
  private async runGitPush(): Promise<void> {
    if (this.gitBusy) return;
    const path = this.workspacePath.trim();
    if (!path) return;
    this.gitBusy = true;
    this.view.gitBar.setPushBusy(true);
    try {
      const res = await requireBridge().pushWorkspace(path);
      if (!res.ok) {
        throw new Error(res.message ?? "unknown error");
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : "Push failed";
      void requireBridge().alertDialog?.({
        title: "Push",
        message: text,
        type: "warning",
      });
      console.error("[conversation] push failed", err);
    } finally {
      this.gitBusy = false;
      this.view.gitBar.setPushBusy(false);
      // main's vcs:changed broadcast also lands here — this covers the race
      // where the broadcast arrives before pushWorkspace resolves (and any
      // future watcher-less path), so the ahead count settles immediately.
      void this.refreshGitStats();
    }
  }

  private revealLabel(): string {
    return requireBridge().platform === "darwin"
      ? "Reveal in Finder"
      : "Show in Folder";
  }

  private async openFile(path: string): Promise<void> {
    try {
      await requireBridge().openPath(path);
    } catch (err) {
      console.error("[conversation] openPath failed", err);
    }
  }

  private async openUrl(url: string): Promise<void> {
    try {
      await requireBridge().openExternal(url);
    } catch (err) {
      console.error("[conversation] openExternal failed", err);
    }
  }

  private async revealFile(path: string): Promise<void> {
    try {
      await requireBridge().showItemInFolder(path);
    } catch (err) {
      console.error("[conversation] showItemInFolder failed", err);
    }
  }

  /** Copy a generated file to a user-chosen location (Save As dialog). */
  private async saveFileAs(path: string): Promise<void> {
    try {
      const result = await requireBridge().saveFileAs(path);
      if (!result.ok && result.error) {
        console.error("[conversation] saveFileAs failed", result.error);
      }
    } catch (err) {
      console.error("[conversation] saveFileAs failed", err);
    }
  }

  /** Open a file in the dedicated File Reader window (or Dev Mode editor). */
  private openFileInReader(path: string): void {
    if (this.onOpenFileOverride) {
      this.onOpenFileOverride(path);
      return;
    }
    try {
      void requireBridge().openFileReader?.(path);
    } catch (err) {
      console.error("[conversation] openFileReader failed", err);
    }
  }

  private async loadFilePreview(
    path: string,
  ): Promise<{ ok: true; content: string } | { ok: false; message: string }> {
    const bridge = requireBridge();
    if (!bridge.readTextFile) {
      return { ok: false, message: "File preview is unavailable." };
    }
    try {
      return await bridge.readTextFile(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[conversation] readTextFile failed", err);
      return { ok: false, message };
    }
  }

  /**
   * Execute a matched slash command; feedback lands in the top pill's
   * notice state.
   */
  private async executeSlashCommand(command: SlashCommand): Promise<void> {
    const hint = (text: string): void => {
      this.notifyHint(text);
    };
    // `/opt` is arg-carrying: a bare match is a usage hint, not a send.
    // Available in Ask mode too — it only polishes prompt text.
    if (command.name === "/opt") {
      hint("Usage: /opt <prompt>");
      return;
    }
    // Mode switches (/plan /ask /auto) work in every mode — including Ask,
    // otherwise there would be no slash route out of it. They mirror the
    // plus-menu rows: pin the mode and drop any custom graph selection.
    const modeTarget = matchModeSlashCommand(command.name);
    if (modeTarget) {
      const label = MODE_SLASH_LABELS[modeTarget];
      if (this.getPrefs().runMode === modeTarget) {
        hint(`Already in ${label} mode`);
      } else {
        setComposerPrefsFor(this.sessionId, {
          runMode: modeTarget,
          fsmGraphId: null,
        });
        hint(`Switched to ${label} mode`);
      }
      return;
    }
    // Workspace actions (/build /run /dev) are shell-level: available in
    // every composer mode, Ask included (they never touch the model).
    const task = matchWorkspaceTaskCommand(command.name);
    if (task) {
      void this.runWorkspaceTask(task);
      return;
    }
    if (command.name === DEV_MODE_COMMAND) {
      if (!this.onToggleDevMode) {
        hint("Dev Mode is unavailable here");
        return;
      }
      this.onToggleDevMode();
      return;
    }
    // Ask mode is read-only Q&A — no pause/resume/compact there.
    if (this.getPrefs().runMode === "ask") {
      hint("Slash commands are not available in Ask mode");
      return;
    }
    try {
      const bridge = requireBridge();
      if (command.name === "/pause") {
        const result = await bridge.pauseTurn(this.sessionId);
        if (result.ok) {
          hint("Pausing — the turn stops after this round");
        } else if (result.reason === "waiting_input") {
          hint("Already waiting for your answer");
        } else {
          hint("No turn running");
        }
        return;
      }
      if (command.name === "/resume") {
        const result = await bridge.resumeTurn({
          sessionId: this.sessionId,
          fullPermissions: isFullPermissionsEnabled(),
          autoSkillSummarize: isAutoSkillSummarizeEnabled(),
        });
        if (result.ok) {
          this.sending = true;
          this.sessionStatus = "running";
          this.isLocallyStreaming = false;
          this.view.setRunning(true);
          this.syncTurnProgress("Waiting for model…");
          this.syncSendEnabled();
          this.emitContextPill();
          void this.refresh();
        } else if (result.reason === "running") {
          hint("A turn is already running");
        } else {
          hint("Session is not paused — nothing to resume");
        }
        return;
      }
      if (command.name === "/compact") {
        await this.runManualCompact();
        return;
      }
      if (command.name === "/clear") {
        const result = await bridge.clearSession(this.sessionId);
        if (result.ok) {
          this.notifyHint("Context cleared — new conversation", 6000);
          void this.refresh();
        } else if (result.reason === "running") {
          hint("Wait for the running turn to finish first");
        } else if (result.reason === "paused") {
          hint("Resume the session before clearing");
        } else {
          hint("Cannot clear right now");
        }
        return;
      }
      if (command.name === "/end") {
        // Feedback mirrors /compact: the status row carries the in-flight
        // state (`compacting` overrides the idle gate); the hint reports
        // the outcome and the ring picks up the digest window size.
        this.compacting = true;
        this.syncTurnProgress("Summarising conversation…");
        let result: Awaited<ReturnType<typeof bridge.endSession>>;
        try {
          result = await bridge.endSession(this.sessionId);
        } finally {
          this.compacting = false;
          this.syncTurnProgress();
        }
        if (result.ok) {
          this.notifyHint(
            result.compacted
              ? `Summarised — ~${(result.estimatedTokens ?? 0).toLocaleString()} tokens (est.)`
              : "Nothing new to summarize",
            6000,
          );
          if (
            result.compacted &&
            typeof result.estimatedTokens === "number" &&
            result.estimatedTokens > 0
          ) {
            this.applyContextUsage(
              {
                usedTokens: result.estimatedTokens,
                cachedTokens: 0,
                source: "estimate",
              },
              "slash:end",
            );
          }
          void this.refresh();
        } else if (result.reason === "running") {
          hint("Wait for the running turn to finish first");
        } else if (result.reason === "paused") {
          hint("Resume the session before ending");
        } else {
          hint("Cannot summarise right now");
        }
        return;
      }
    } catch (err) {
      console.error("[conversation] slash command failed", command.name, err);
      hint("Command failed");
    }
  }

  /**
   * Manual /compact execution shared by the bare command and the
   * `/compact <keep>` argument form. `keepRatio` overrides the protect
   * token ratio for this one pass only (0 < ratio ≤ 0.9).
   */
  private async runManualCompact(keepRatio?: number): Promise<void> {
    const hint = (text: string): void => {
      this.notifyHint(text);
    };
    // Feedback mirrors a running turn: the LLM status row carries the
    // in-flight state (idle sessions never show it unassisted, so
    // `compacting` overrides the gate); the hint only reports the
    // outcome, and the ring picks up the compacted window size.
    this.compacting = true;
    this.syncTurnProgress("Compacting context…");
    const bridge = requireBridge();
    let result: Awaited<ReturnType<typeof bridge.compactSession>>;
    try {
      result = await bridge.compactSession(
        this.sessionId,
        keepRatio !== undefined ? { protectTokenRatio: keepRatio } : undefined,
      );
    } finally {
      this.compacting = false;
      this.syncTurnProgress();
    }
    if (result.ok) {
      // Result numbers need a beat longer to read than a plain label.
      this.notifyHint(
        result.compacted
          ? `Context compacted${keepRatio !== undefined ? ` — keep ≤${Math.round(keepRatio * 100)}%` : ""} — ~${(result.estimatedTokens ?? 0).toLocaleString()} tokens (est.)`
          : "Nothing new to compact",
        6000,
      );
      if (
        result.compacted &&
        typeof result.estimatedTokens === "number" &&
        result.estimatedTokens > 0
      ) {
        // The one controlled estimate writer for the ring: the compacted
        // window is a projection until the next provider usage event.
        this.applyContextUsage(
          {
            usedTokens: result.estimatedTokens,
            cachedTokens: 0,
            source: "estimate",
          },
          "slash:compact",
        );
      }
      void this.refresh();
    } else if (result.reason === "running") {
      hint("Wait for the running turn to finish first");
    } else if (result.reason === "paused") {
      hint("Resume the session before compacting");
    } else {
      hint("Cannot compact right now");
    }
  }

  /**
   * `/compact <keep>` interception for the send paths: a one-off keep-ratio
   * override for this manual pass (e.g. `/compact 0.1` keeps only the newest
   * iterations within 10% of the context limit raw, everything older is
   * summarized). Invalid arguments consume the submission with a usage hint
   * (the draft stays in the composer) — they are never sent to the model.
   *
   * Decides synchronously — no await before the verdict — so the submit
   * chains keep their microtask shape; the compaction itself runs detached,
   * exactly like the bare /compact path. Returns true when consumed.
   */
  private beginSlashCompactKeepRatio(): boolean {
    const match = matchSlashCommandWithArgs(this.view.getPrompt());
    if (!match || match.command.name !== "/compact") return false;
    const keepRatio = parseProtectTokenRatioArg(match.args);
    if (keepRatio === null) {
      this.notifyHint(
        "Usage: /compact <keep ratio> — e.g. /compact 0.1 (0 < ratio ≤ 0.9)",
        6000,
      );
      return true;
    }
    this.view.clearPrompt();
    this.clearDraftStash();
    this.syncSendEnabled();
    void this.runManualCompact(keepRatio);
    return true;
  }

  /**
   * `/build` `/run` — run the session workspace's task via the same
   * devTasks IPC as the Dev Mode outline buttons. `/build` additionally
   * mounts the live build progress card (devtask:progress stream); the
   * pill hint stays as the lightweight acknowledgment in both paths.
   */
  private async runWorkspaceTask(task: "build" | "run"): Promise<void> {
    const hint = (text: string, ms?: number): void => {
      this.notifyHint(text, ms);
    };
    const root = this.workspacePath.trim();
    if (!root) {
      hint("No workspace for this session — open it inside a project");
      return;
    }
    const bridge = window.jellybot;
    if (!bridge?.runDevTask) {
      hint("Workspace tasks are unavailable in this build");
      return;
    }
    try {
      const res = await bridge.runDevTask(root, task);
      if (!res.ok && !res.runId) {
        hint(`${task} failed to start — ${res.message}`, 6000);
        return;
      }
      const runId = res.runId;
      hint(`${task} started`, 2400);
      if (task === "build" && runId) void this.attachBuildCard(runId);
      this.devTaskExitOff?.();
      const off = bridge.onDevTaskExit((snap) => {
        if (snap.runId !== runId) return;
        off();
        if (this.devTaskExitOff === off) this.devTaskExitOff = undefined;
        if (this.destroyed) return;
        if (snap.status === "done") {
          hint(`${task} finished`, 6000);
        } else if (snap.status === "failed" || snap.status === "spawn-error") {
          hint(`${task} failed — open Dev Mode for output`, 6000);
        } else {
          hint(`${task} ${snap.status}`, 6000);
        }
        if (
          task === "build" &&
          this.buildCard &&
          this.buildCard.root.dataset.runId === snap.runId
        ) {
          this.buildCard.finish({
            runId: snap.runId,
            workspacePath: snap.workspacePath,
            status: snap.status,
            startedAt: snap.startedAt,
            durationMs: snap.durationMs,
            progress: snap.progress,
            failureHint: snap.failureHint,
            bufferTail: buildBufferTail(snap.buffer ?? ""),
          });
        }
      });
      this.devTaskExitOff = off;
    } catch (err) {
      hint(
        `${task} failed to start — ${err instanceof Error ? err.message : String(err)}`,
        6000,
      );
    }
  }

  /**
   * Hydrate the live build card for an active run — used after /build
   * starts one and when the conversation remounts over a still-running
   * build (getDevTaskState snapshots carry progress for replay).
   */
  private async attachBuildCard(runId: string): Promise<void> {
    const bridge = window.jellybot;
    const root = this.workspacePath.trim();
    if (!bridge?.getDevTaskState || !root) return;
    try {
      const state = await bridge.getDevTaskState(root);
      if (this.destroyed) return;
      const snap = state.active.find((s) => s.runId === runId);
      if (!snap) return; // finished between the click and this query
      // Build progress UI is Unreal-only — no parser attached (non-Unreal
      // workspace) means no progress snapshot, so no card.
      if (!snap.progress) return;
      this.mountBuildCard(snap);
    } catch {
      // Cosmetic — the pill hint already acknowledged the start.
    }
  }

  /** Build the card DOM and start the progress stream subscription. */
  private mountBuildCard(snap: DevTaskRunSnapshot): void {
    this.ensureBuildProgressSubscription();
    this.buildCard = createBuildStatusCard({
      runId: snap.runId,
      workspacePath: snap.workspacePath,
      status: "running",
      startedAt: snap.startedAt,
      durationMs: null,
      progress: snap.progress,
      failureHint: null,
      bufferTail: null,
    });
    this.buildCardWorkspace = snap.workspacePath.replace(/\\/g, "/");
    this.view.setBuildStatusCard(this.buildCard.root);
  }

  /** One process-wide devtask:progress listener for the mounted card. */
  private ensureBuildProgressSubscription(): void {
    if (this.devTaskProgressOff) return;
    const bridge = window.jellybot;
    if (!bridge?.onDevTaskProgress) return;
    this.devTaskProgressOff = bridge.onDevTaskProgress((payload) => {
      if (payload.task !== "build" || !this.buildCard) return;
      const ws = payload.workspacePath.replace(/\\/g, "/");
      if (ws !== this.buildCardWorkspace) return;
      this.buildCard.updateProgress(payload, payload.elapsedMs);
    });
  }

  /**
   * After a transcript repaint: reattach the card when a build for this
   * workspace is still running; otherwise clear any stale card (a new
   * conversation / workspace switch must not inherit the old run's card).
   */
  private async restoreBuildCard(): Promise<void> {
    const bridge = window.jellybot;
    const root = this.workspacePath.trim();
    if (!bridge?.getDevTaskState || !root) {
      this.buildCard = null;
      this.buildCardWorkspace = "";
      this.view.setBuildStatusCard(null);
      return;
    }
    try {
      const state = await bridge.getDevTaskState(root);
      if (this.destroyed) return;
      const active = state.active.find((s) => s.task === "build");
      if (!active || !active.progress) {
        // No live run, or a non-Unreal workspace (progress UI is
        // Unreal-only — parser never attaches, snapshot carries no progress).
        this.buildCard = null;
        this.buildCardWorkspace = "";
        this.view.setBuildStatusCard(null);
        return;
      }
      if (this.buildCard?.root.dataset.runId === active.runId) return;
      this.mountBuildCard(active);
    } catch {
      // Cosmetic — leave whatever card state was already mounted.
    }
  }

  /**
   * `/plan|/ask|/auto <prompt>` interception for the send paths: switch the
   * composer run mode (same as the plus-menu row), strip the command, and
   * let the caller continue sending the remaining text as the prompt.
   * Runs before {@link tryOptimizePrompt}, so the remaining text can still
   * be an `/opt …` composition. `//plan …`-style input is NOT matched here —
   * the escape layer in tryOptimizePrompt strips one slash and sends it
   * literally.
   */
  private trySlashModeSwitch(): void {
    const match = matchSlashCommandWithArgs(this.view.getPrompt());
    if (!match) return;
    const modeTarget = matchModeSlashCommand(match.command.name);
    if (!modeTarget) return;
    if (this.getPrefs().runMode !== modeTarget) {
      setComposerPrefsFor(this.sessionId, {
        runMode: modeTarget,
        fsmGraphId: null,
      });
      this.notifyHint(`Switched to ${MODE_SLASH_LABELS[modeTarget]} mode`);
    }
    this.view.composer.setPrompt(match.args);
  }

  /**
   * `/opt` interception for the send paths (docs/plans/
   * 20260828-composer-prompt-optimizer.md). `//opt <text>` escapes: one
   * leading slash is stripped and the text is sent literally. `/opt <args>`
   * optimizes the argument with one fast LLM pass before submission.
   * Returns true when the submission is consumed (failed optimization —
   * the `/opt` draft stays in the composer); false lets the caller
   * continue with the (possibly replaced) prompt text.
   */
  private async tryOptimizePrompt(): Promise<boolean> {
    const raw = this.view.getPrompt();
    const escaped = matchSlashEscape(raw);
    if (escaped !== null) {
      if (escaped !== raw.trim()) {
        this.view.composer.setPrompt(escaped);
      }
      return false;
    }
    const match = matchSlashCommandWithArgs(raw);
    if (!match) return false;
    // Only /opt carries a prompt to optimize — other arg commands (e.g.
    // `/compact <ratio>`) are handled by their own interception and must
    // fall through untouched.
    if (match.command.name !== "/opt") return false;
    // Busy guard: swallow Enter/click repeats while the pass is in flight.
    if (this.optimizingPrompt) return true;
    this.optimizingPrompt = true;
    this.syncSendEnabled();
    // Long-lived in-flight notice; completion replaces it (the optimize call
    // itself is capped at 10s in the main process).
    this.notifyHint("Optimising prompt…", 60_000, true);
    try {
      const result = await requireBridge().optimizeUserPrompt({
        text: match.args,
        sessionId: this.sessionId,
      });
      if ("text" in result && result.text.trim()) {
        this.view.composer.setPrompt(result.text);
        this.notifyHint("Prompt optimised");
        return false;
      }
      this.notifyHint("Optimisation failed — retry or send without /opt", 6000);
      return true;
    } catch (err) {
      console.error("[conversation] /opt optimization failed", err);
      this.notifyHint("Optimisation failed — retry or send without /opt", 6000);
      return true;
    } finally {
      this.optimizingPrompt = false;
      this.syncSendEnabled();
    }
  }

  private async sendFollowUp(): Promise<void> {
    if (this.view.composer.trySubmitSlashCommand()) return;
    if (this.beginSlashCompactKeepRatio()) return;
    this.trySlashModeSwitch();
    if (await this.tryOptimizePrompt()) return;
    const text = this.view.getPrompt().trim();
    const attachments = this.attachmentsApi?.getAttachments() ?? [];
    if ((!text && attachments.length === 0) || this.sending) return;
    const pending = cloneAttachments(attachments);
    this.view.clearPrompt();
    this.clearDraftStash();
    this.attachmentsApi?.clear();
    this.syncSendEnabled();
    await this.startFollowUpTurn(text, pending);
  }

  /** Debounce draft stashing so fast typing does not hit storage per key. */
  private scheduleDraftSave(): void {
    if (this.draftSaveTimer != null) clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = setTimeout(() => {
      this.draftSaveTimer = null;
      setSessionDraft(this.sessionId, this.view.getPrompt());
    }, 300);
  }

  /** Cancel any pending save and drop the stash (send / terminal shortcut). */
  private clearDraftStash(): void {
    if (this.draftSaveTimer != null) {
      clearTimeout(this.draftSaveTimer);
      this.draftSaveTimer = null;
    }
    clearSessionDraft(this.sessionId);
  }

  /**
   * present_demo Confirm (plan D1, non-blocking): the D7 marker message goes
   * through the same gesture semantics as the composer — idle starts a turn
   * immediately, running enqueues deferred (rendered settled via the queue
   * scan).
   */
  private async submitDemoConfirm(
    toolCallId: string,
    values: Record<string, string | number | boolean | null>,
    note?: string,
  ): Promise<DemoSubmitReceipt> {
    if (this.destroyed) throw new Error("This conversation is closed. Reopen it to confirm the demo.");
    const text = buildDemoConfirmMessage({
      toolCallId,
      paramsJson: JSON.stringify(values),
      ...(note ? { note } : {}),
    });
    if (this.sessionStatus === "running" || this.sending) {
      const response = await requireBridge().enqueuePrompt({
        sessionId: this.sessionId,
        userText: text,
        attachments: [],
        mode: "deferred",
      });
      this.applyPromptQueueSnapshot(response.items);
      return { enqueued: true };
    }
    await this.startFollowUpTurn(text, []);
    return { enqueued: false };
  }

  /**
   * Default to the next turn. Empty-composer Enter (or the row's Insert
   * action) arms the queued item for the current turn's next natural boundary.
   */
  private async enqueueComposerPrompt(): Promise<boolean> {
    if (this.view.composer.trySubmitSlashCommand()) return false;
    if (this.beginSlashCompactKeepRatio()) return false;
    this.trySlashModeSwitch();
    if (await this.tryOptimizePrompt()) return false;
    const text = this.view.getPrompt().trim();
    const attachments = this.attachmentsApi?.getAttachments() ?? [];
    if (!text && attachments.length === 0) return false;
    const pending = cloneAttachments(attachments);
    // Consume this draft before IPC, so a reply never clears newly typed input.
    this.view.clearPrompt();
    this.clearDraftStash();
    this.attachmentsApi?.clear();
    this.syncSendEnabled();
    try {
      const response = await requireBridge().enqueuePrompt({
        sessionId: this.sessionId,
        userText: text,
        attachments: pending,
        mode: "deferred",
      });
      this.applyPromptQueueSnapshot(response.items);
      this.view.focusInput();
      return true;
    } catch (err) {
      this.restorePromptToComposer(text, pending);
      console.error("[conversation] enqueuePrompt failed", err);
      const message = err instanceof Error ? err.message : String(err);
      this.notifyHint(message, 5000);
      return false;
    }
  }

  private async removeQueuedPrompt(id: string): Promise<void> {
    try {
      const response = await requireBridge().removeQueuedPrompt(
        this.sessionId,
        id,
      );
      this.applyPromptQueueSnapshot(response.items);
    } catch (err) {
      console.error("[conversation] removeQueuedPrompt failed", err);
    }
  }

  private async updateQueuedPromptText(id: string, text: string): Promise<void> {
    try {
      const response = await requireBridge().updateQueuedPromptText(
        this.sessionId,
        id,
        text,
      );
      this.applyPromptQueueSnapshot(response.items);
    } catch (err) {
      console.error("[conversation] updateQueuedPromptText failed", err);
    }
  }

  /** Insert at the next natural boundary (row / empty-composer Enter). */
  private async promoteQueuedPrompt(id: string): Promise<void> {
    try {
      const response = await requireBridge().promoteQueuedPrompt(
        this.sessionId,
        id,
      );
      this.applyPromptQueueSnapshot(response.items);
      if (response.started) {
        // Idle session: main started a turn from the row — pick up the new
        // user card as soon as it is persisted.
        this.scheduleStructuralRefresh();
      }
    } catch (err) {
      console.error("[conversation] promoteQueuedPrompt failed", err);
    }
  }

  /** Cancel insert — back to "after this turn". */
  private async deferQueuedPrompt(id: string): Promise<void> {
    try {
      const response = await requireBridge().deferQueuedPrompt(
        this.sessionId,
        id,
      );
      this.applyPromptQueueSnapshot(response.items);
    } catch (err) {
      console.error("[conversation] deferQueuedPrompt failed", err);
    }
  }

  private async moveQueuedPromptToFront(id: string): Promise<void> {
    try {
      const response = await requireBridge().moveQueuedPromptToFront(
        this.sessionId,
        id,
      );
      this.applyPromptQueueSnapshot(response.items);
    } catch (err) {
      console.error("[conversation] moveQueuedPromptToFront failed", err);
    }
  }

  /** Mirror a main-process snapshot (IPC reply or `prompt_queue` event). */
  private applyPromptQueueSnapshot(items: QueuedPrompt[]): void {
    const demoQueueChanged = demoQueueFingerprint(this.promptQueue.map((item) => item.text)) !== demoQueueFingerprint(items.map((item) => item.userText));
    this.promptQueue = items.map(queuedPromptToViewItem);
    this.renderPromptQueue();
    this.syncSendEnabled();
    if (demoQueueChanged) this.scheduleStructuralRefresh();
  }

  private renderPromptQueue(): void {
    this.view.setPromptQueue(this.promptQueue);
    // Idle + non-empty queue → the rows switch to the "ready to send" palette.
    this.view.setPromptQueueIdle(this.sessionStatus !== "running");
  }

  private async hydratePromptQueue(): Promise<void> {
    try {
      const items = await requireBridge().listPromptQueue(this.sessionId);
      this.applyPromptQueueSnapshot(items ?? []);
    } catch (err) {
      console.error("[conversation] listPromptQueue failed", err);
    }
  }

  private async startFollowUpTurn(
    text: string,
    attachments: PendingAttachment[],
  ): Promise<void> {
    this.sending = true;
    this.sessionStatus = "running";
    this.isLocallyStreaming = false;
    this.view.setRunning(true);
    this.pillUserText = text.trim() || this.pillUserText;
    this.syncTurnProgress("Waiting for model…");
    const pending = cloneAttachments(attachments);
    // Drop a queued full refresh so it cannot race the optimistic card.
    // Must not call cancel() — that permanently disables schedule() and skips
    // the end-of-turn rebuild (Completed · … footer, modified files, etc.).
    this.refreshCoalesce.clearPending();
    this.view.appendOptimisticUserMessage(text, pending);
    this.syncSendEnabled();
    try {
      const prefs = this.getPrefs();
      const customGraphId =
        prefs.runMode === "custom" &&
        typeof prefs.fsmGraphId === "string" &&
        prefs.fsmGraphId.length > 0
          ? prefs.fsmGraphId
          : undefined;
      await requireBridge().startTurn({
        sessionId: this.sessionId,
        userText: text,
        fullPermissions: isFullPermissionsEnabled(),
        autoSkillSummarize: isAutoSkillSummarizeEnabled(),
        runMode: prefs.runMode,
        ...(customGraphId !== undefined ? { fsmGraphId: customGraphId } : {}),
        reasoningEffort: prefs.reasoningEffort,
        attachments: pending.map((item) => ({
          path: item.path,
          name: item.name,
          kind: item.kind,
          mimeType: item.mimeType,
          ...(item.sizeBytes !== undefined
            ? { sizeBytes: item.sizeBytes }
            : {}),
        })),
      });
    } catch (err) {
      this.sending = false;
      this.sessionStatus = "error";
      this.view.setRunning(false);
      this.syncSendEnabled();
      this.emitContextPill();
      const message = err instanceof Error ? err.message : String(err);
      this.view.appendTurnErrorMessage(message, {
        // Ephemeral failure (turn never started): nothing persisted to
        // consume — retry just resends this closure's prompt.
        payload: {
          text,
          attachments: pending.map((item) => ({
            path: item.path,
            name: item.name,
            kind: item.kind,
            mimeType: item.mimeType,
            ...(item.sizeBytes !== undefined
              ? { sizeBytes: item.sizeBytes }
              : {}),
          })),
        },
        onRetry: (payload) => this.retryTurnError(payload),
      });
      throw err instanceof Error ? err : new Error(message);
    }
  }
}

function cloneAttachments(
  attachments: PendingAttachment[],
): PendingAttachment[] {
  return attachments.map((item) => ({
    id: item.id,
    path: item.path,
    name: item.name,
    kind: item.kind,
    mimeType: item.mimeType,
    ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}),
  }));
}

function queuedPromptToViewItem(queued: QueuedPrompt): PromptQueueItem {
  return {
    id: queued.id,
    text: queued.userText,
    mode: queued.mode === "interrupt" ? "interrupt" : "deferred",
    attachments: queued.attachments.map((item) => ({
      id: crypto.randomUUID(),
      path: item.path,
      name: item.name,
      kind: item.kind,
      mimeType: item.mimeType,
      ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}),
    })),
  };
}
