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
import { currentEditorContext } from "../../state/editorContextState.js";
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

const WRITE_STREAM_PAINT_MIN_MS = 50;

function filesForMessage(
  messages: Array<{ id?: string; parts: Array<Record<string, unknown>> }>,
  messageId: string,
): string[] | null {
  const message = messages.find((m) => m.id === messageId);
  return message ? pillFilesFromParts(message.parts) : null;
}

const WORKING_TREE_WRITE_TOOLS = new Set([
  "write_file",
  "patch",
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

function sameDir(a: string, b: string): boolean {
  const norm = (p: string) =>
    p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

function gitTargetKind(
  gitRoot: string | null,
  workspace: string,
): "none" | "workspace" | "external" {
  if (!gitRoot) return "none";
  return sameDir(gitRoot, workspace) ? "workspace" : "external";
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

export class ConversationController {
  private unsubs: Array<() => void> = [];
  private readonly transcriptOnly: boolean;
  private readonly historyWindowMs: number | undefined;
  private readonly externalPrompts: boolean;
  private readonly textOnlyMessageIds: (() => ReadonlySet<string>) | undefined;
  private readonly turnStartMessageIds: (() => ReadonlySet<string>) | undefined;
  private displayTurnStarts: ReadonlySet<string> | undefined;
  private readonly quietCurrentTurn: (() => boolean) | undefined;
  private historyTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly readOnly: boolean;
  private readonly promptRestoreOverride: ((text:string) => void) | undefined;
  private readonly retryOverride: ((payload: TurnErrorRetryPayload) => Promise<boolean>) | undefined;
  private readonly onContextUsage: ((usage: ContextUsage) => void) | undefined;
  private transcriptRenderKey = "";
  private unsubscribePermissions: (() => void) | undefined;
  private unsubscribeAutoSkillSummarize: (() => void) | undefined;
  private unsubscribeComposerPrefs: (() => void) | undefined;
  private providersBinding: ComposerProvidersBinding | undefined;
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
  private promptQueue: PromptQueueItem[] = [];
  private draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private contextUsage: ContextUsage = {
    usedTokens: 0,
    limitTokens: 128_000,
  };
  private sessionStatus: SessionStatus = "idle";
  private compacting = false;
  private loadingEarlier = false;
  private optimizingPrompt = false;
  private planReviewError: string | null = null;
  private planReviewActive = false;
  private planReviewSyncedOnce = false;
  private lastProgressText = "";
  private lastProgressToolName: string | null = null;
  private readonly cardToolCallIds = new Set<string>();
  private lastMessages: Array<{
    id?: string;
    role: string;
    parts: Array<Record<string, unknown>>;
  }> = [];
  private isLocallyStreaming = false;
  private readonly subagentsByToolCallId = new Map<string, SubagentCardSnapshot>();
  private readonly runningSubagentIds = new Set<string>();
  private readonly dirtyWriteStreamIds = new Set<string>();
  private devTaskExitOff: (() => void) | undefined;
  private devTaskProgressOff: (() => void) | undefined;
  private buildCard: BuildStatusCardApi | null = null;
  private buildCardWorkspace = "";
  private writeStreamPaintTimer: ReturnType<typeof setTimeout> | null = null;
  private writeStreamPaintRaf: number | null = null;
  private writeStreamPaintQueued = false;
  private lastWriteStreamPaintAt = 0;
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
  private pendingReasoningDelta = "";
  private pendingReasoningMessageId: string | null = null;
  private reasoningFlushScheduled = false;
  private workspacePath = "";
  private providerId = "";
  private lastTurnBalanceText: string | null = null;
  private gitStatsSeq = 0;
  private gitStatsInFlight = false;
  private gitStatsRerunWanted = false;
  private gitBusy = false;
  private gitStatsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private upstreamSeq = 0;
  private footerVcsPromise: Promise<{ svn: boolean; gitRoot: string | null }> | null = null;
  private footerVcsPath = "";
  private readonly initialOptimistic: {
    text: string;
    attachments: PendingAttachment[];
  } | null;

  private readonly onOpenFileOverride: ((path: string) => void) | null = null;
  private readonly onToggleDevMode: (() => void) | null = null;
  private readonly onFileWritten:
    | ((files: AgentWriteFilePlan[]) => void)
    | null = null;
  private readonly onFileRead:
    | ((path: string, range: AgentReadRange) => void)
    | null = null;
  private readonly onContextPill:
    | ((snapshot: ContextPillSnapshot) => void)
    | null = null;
  private readonly onPillNotice:
    | ((text: string, durationMs?: number, spinner?: boolean) => void)
    | null = null;
  private pillUserText: string | null = null;
  private pillUserFiles: string[] | null = null;
  private pillPlan: ContextPillSnapshot["plan"] = null;
  private lastPillSnapshot: ContextPillSnapshot | null = null;
  private pillPromptVisible = false;
  private pillAnchorText: string | null = null;
  private pillAnchorFiles: string[] | null = null;
  private localPill: ContextPillController | null = null;
  private readonly pendingWriteFiles = new Map<string, AgentWriteFilePlan[]>();
  private readonly pendingFlashPlans = new Map<string, AgentWriteFilePlan[]>();
  private readonly pendingReadFiles = new Map<
    string,
    { path: string; range: AgentReadRange }
  >();

  constructor(
    private readonly view: ConversationView,
    private readonly sessionId: string,
    options?: {
      transcriptOnly?: boolean;
      historyWindowMs?: number;
      externalPrompts?: boolean;
      textOnlyMessageIds?: () => ReadonlySet<string>;
      turnStartMessageIds?: () => ReadonlySet<string>;
      quietCurrentTurn?: () => boolean;
      readOnly?: boolean;
      onPromptRestore?: (text:string) => void;
      onRetryTurnError?: (payload: TurnErrorRetryPayload) => Promise<boolean>;
      onContextUsage?: (usage: ContextUsage) => void;
      optimisticUserText?: string;
      attachments?: PendingAttachment[];
      onOpenFile?: (path: string) => void;
      onToggleDevMode?: () => void;
      onFileWritten?: (files: AgentWriteFilePlan[]) => void;
      onFileRead?: (path: string, range: AgentReadRange) => void;
      onContextPill?: (snapshot: ContextPillSnapshot) => void;
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
    this.view.onPromptVisibilityChange = (visible, promptText, messageId) => {
      this.pillPromptVisible = visible;
      this.pillAnchorText = promptText;
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
    this.view.setPlanReviewHandlers({
      onApprove: () => {
        void this.handlePlanApprove();
      },
      onDiscard: () => {
        void this.handlePlanDiscard();
      },
    });
    this.bind();
    const draft = getSessionDraft(this.sessionId);
    if (draft.length > 0) {
      this.view.composer.setPrompt(draft);
      this.syncSendEnabled();
    }
  }

  isBusy(): boolean {
    return this.sessionStatus === "running" || this.sending;
  }

  insertFileReference(path: string): boolean {
    return !this.readOnly && this.view.composer.insertFileReference(path);
  }

  refreshDisplay(): void {
    if (this.destroyed) return;
    this.scheduleStructuralRefresh();
  }

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
    this.view.gitBar.onUpdate = () => {
      void this.runSvnUpdate();
    };
    this.view.gitBar.onPull = () => {
      void this.runGitPull();
    };
    this.view.gitBar.onPush = () => {
      void this.runGitPush();
    };
    this.view.gitBar.onSubagents = () => {
      this.openSubagentsWindow();
    };
    void this.refreshUpstream();
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void this.refreshUpstream();
    };
    document.addEventListener("visibilitychange", onVisible);
    this.unsubs.push(() => document.removeEventListener("visibilitychange", onVisible));
    void this.bootstrapRunningSubagents();

    this.unsubs.push(
      bridge.onVcsChanged(({ rootPath }) => {
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
    this.devTaskExitOff?.();
    this.devTaskExitOff = undefined;
    this.devTaskProgressOff?.();
    this.devTaskProgressOff = undefined;
    this.buildCard = null;
    this.buildCardWorkspace = "";
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
    this.view.gitBar.onUpdate = null;
    this.view.gitBar.onPull = null;
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
    this.clearHistoryExpiry();
    this.pendingAsks = [];
    this.dirtyWriteStreamIds.clear();
    this.pendingWriteFiles.clear();
    this.pendingFlashPlans.clear();
    this.writeStreamPaintReady = false;
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
    this.lastMessages = [];
    this.subagentsByToolCallId.clear();
    this.demoStates.clear();
    this.pendingReadFiles.clear();
    this.cardToolCallIds.clear();
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
      case "new_task_boundary":
        this.refreshCoalesce.schedule();
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
        if (typeof event.messageId === "string" && event.messageId) {
          this.scheduleStructuralRefresh();
        }
        return;
      case "response_state":
        return;
      case "tool_call_delta": {
        this.flushPendingReasoning();
        this.isLocallyStreaming = false;
        this.foldHeldReplyAfterQueuedText(null);
        this.syncTurnProgress();
        return;
      }
      case "round_interrupted": {
        this.flushPendingReasoning();
        this.isLocallyStreaming = false;
        this.view.foldHeldReplyIntoThought();
        this.view.finalizeStreamingReasoning();
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
        const bridged = unwrapToolCallBridge(
          typeof event.name === "string" ? event.name : "",
          event.arguments,
        );
        const toolCallId = typeof event.id === "string" ? event.id : "";
        const toolMessageId =
          typeof event.messageId === "string" ? event.messageId : "";
        const argumentsRaw =
          typeof event.argumentsRaw === "string" ? event.argumentsRaw : "";
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
        if (
          toolCallId &&
          isConversationCardVisible(bridged.name, bridged.arguments)
        ) {
          this.cardToolCallIds.add(toolCallId);
        }
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
        if (typeof event.id === "string") {
          const written = this.pendingWriteFiles.get(event.id);
          if (written) {
            this.pendingWriteFiles.delete(event.id);
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
        if (isWorkingTreeWriteToolName(event.name)) {
          this.scheduleGitStatsRefresh();
        }
        this.syncTurnProgress();
        return;
      case "progress":
        if (typeof event.text === "string") {
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
          this.assistantSliceRefresh.schedule();
        }
        if (!running) {
          this.lastProgressToolName = null;
          this.cardToolCallIds.clear();
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
      case "plan_phase":
        return;
      case "subagent": {
        this.applySubagentStreamEvent(event);
        this.applySubagentRunningState(event);
        return;
      }
      case "subagent_live": {
        return;
      }
      case "prompt_queue": {
        this.applyPromptQueueSnapshot(
          Array.isArray(event.items) ? (event.items as QueuedPrompt[]) : [],
        );
        return;
      }
      case "prompt_restored": {
        void requireBridge()
          .takePromptRestore(this.sessionId)
          .catch(() => {
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
        this.scheduleStructuralRefresh();
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

  private async onTurnDone(): Promise<void> {
    await this.fetchProviderBalance();
    await this.toolRenderQueue;
    this.finalizeTurnCoalesce.schedule();
    void this.refreshGitStats();
  }

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
      if (session.status === "running") {
        this.assistantSliceRefresh.schedule();
        return;
      }
      if (this.view.predatesPendingPrompt(session.messages)) return;
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
    const patched = this.view.updateSubagentDispatchCard(parentToolCallId, {
      status,
      ...(typeof usedTokens === "number" ? { usedTokens } : {}),
    });
    if (!patched) {
      this.assistantSliceRefresh.schedule();
    }
  }

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

  private openSubagentsWindow(): void {
    const bridge = window.jellybot;
    if (!bridge?.openSubagentsWindow) return;
    bridge
      .openSubagentsWindow(this.sessionId)
      .catch((err: unknown) => {
        console.error("[conversation] open subagents window failed", err);
      });
  }

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
          const ranges = matchFlashRanges(trueRanges, file.path);
          return ranges ? { ...file, ranges } : file;
        });
      }
    }
    this.onFileWritten?.(emit);
  }

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
    void this.toolRenderQueue.then(() => {
      if (this.destroyed) return;
      this.flushPendingReasoning();
      this.isLocallyStreaming = this.view.appendStreamingText(text, messageId);
      this.syncTurnProgress();
    });
  }

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
    this.emitFlashFromFinishedTool(session, toolCallId);

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
    });
    return true;
  }

  private async startRetryContinuationTurn(): Promise<void> {
    this.sending = true;
    this.sessionStatus = "running";
    this.isLocallyStreaming = false;
    this.view.setRunning(true);
    this.syncTurnProgress("Waiting for model…");
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
        payload: { continuation: "retry" },
        onRetry: (payload) => this.retryTurnError(payload),
      });
      throw err instanceof Error ? err : new Error(message);
    }
  }

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
    const pathChanged = nextPath !== this.workspacePath;
    this.workspacePath = nextPath;
    if (pathChanged) {
      this.footerVcsPromise = null;
      this.footerVcsPath = "";
      if (!this.transcriptOnly && !this.destroyed) {
        this.view.gitBar.setSyncTargets({ svn: false, git: "none" });
        void this.refreshUpstream();
      }
    }
    this.providerId =
      typeof session.providerId === "string" ? session.providerId.trim() : "";
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
    this.view.setPromptQueueIdle(!running);

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
    this.planReviewError = null;
    this.view.dismissPlanReview();
    try {
      const result = await requireBridge().approvePlan(this.sessionId);
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
      const tail = await requireBridge().getSessionTail(this.sessionId, {
        turns: 1,
      });
      if (this.destroyed || !tail) return;
      const session = this.displaySession(tail.session);

      this.view.finalizeStreamingDisplay({
        keepReasoning: this.view.hasLiveStreamingReasoning(),
      });

      const ctx = buildMessageRenderContext(
        session.messages,
        this.renderContextOptions(session),
      );

      const assistantIndex = this.findLastAssistantIndex(session.messages);
      if (assistantIndex < 0) {
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

  private pushContextUsage(): void {
    this.view.setContextUsage(this.contextUsage);
    this.onContextUsage?.(this.contextUsage);
  }

  private emitContextPill(): void {
    const snapshot: ContextPillSnapshot = {
      running: this.sessionStatus === "running" || this.sending,
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

  private toolCardOwnsProgress(): boolean {
    if (
      this.lastProgressToolName &&
      isConversationCardVisible(this.lastProgressToolName)
    ) {
      return true;
    }
    if (this.cardToolCallIds.size > 0) return true;
    return someWriteStream(
      this.sessionId,
      (entry) => !entry.called && isConversationCardVisible(entry.name),
    );
  }

  private getPrefs(): SessionComposerPrefs {
    return getComposerPrefs(this.sessionId);
  }

  private applyComposerPrefs(prefs: SessionComposerPrefs): void {
    if (prefs.runMode === "custom" && prefs.fsmGraphId) {
      this.view.setCustomGraphSelection({
        id: prefs.fsmGraphId,
        name: prefs.fsmGraphId,
      });
      void window.jellybot?.getFsmGraph?.(prefs.fsmGraphId).then((record) => {
        const current = this.getPrefs();
        if (current.runMode !== "custom" || current.fsmGraphId !== prefs.fsmGraphId) return;
        if (!record || !record.enabled || record.validation?.valid !== true || record.draftContextId) {
          setComposerPrefsFor(this.sessionId, { fsmGraphId: null });
          this.view.setCustomGraphSelection(null);
          this.view.setComposerRunMode("custom");
          this.view.setStatusLine("The selected graph is unavailable or needs fixes. Select a validated, enabled graph.", true);
          return;
        }
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
  }

  private hydrateComposerPrefsFromSession(session: {
    composerRunMode?: "agent" | "ask" | "plan" | "custom" | null;
    composerFsmGraphId?: string | null;
    composerInfinite?: boolean | null;
    reasoningEffort?: ReasoningEffort | null;
  }): void {
    hydrateComposerPrefs(this.sessionId, {
      runMode: session.composerRunMode ?? null,
      fsmGraphId: session.composerFsmGraphId ?? null,
      infinite: session.composerInfinite ?? null,
      reasoningEffort: session.reasoningEffort ?? null,
    });
  }

  private syncSendEnabled(): void {
    const hasText = this.view.getPrompt().trim().length > 0;
    const hasAttachments =
      (this.attachmentsApi?.getAttachments().length ?? 0) > 0;
    const hasContent = hasText || hasAttachments;
    if (this.sending) {
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

    this.view.composer.setOnSlashCommand((command) => {
      void this.executeSlashCommand(command);
      return true;
    });
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

  private async runComposerSubmitAction(options?: {
    respectDisabled?: boolean;
  }): Promise<void> {
    const hasContent =
      this.view.getPrompt().trim().length > 0 ||
      (this.attachmentsApi?.getAttachments().length ?? 0) > 0;
    if (this.composerSubmitting) {
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

  private async consumePendingPromptRestore(): Promise<void> {
    if (this.destroyed) return;
    try {
      const payload = await requireBridge().takePromptRestore(
        this.sessionId,
      );
      if (!payload || this.destroyed) return;
      this.restorePromptToComposer(payload.text, payload.attachments);
    } catch {
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

  private clearHistoryExpiry(): void {
    if (this.historyTimer === undefined) return;
    clearTimeout(this.historyTimer);
    this.historyTimer = undefined;
  }

  private armHistoryExpiry(messages: Array<{ createdAt?: number }>): void {
    this.clearHistoryExpiry();
    if (!this.historyWindowMs || this.destroyed) return;
    let oldest = Number.POSITIVE_INFINITY;
    for (const message of messages) {
      if (typeof message.createdAt === "number" && message.createdAt < oldest) oldest = message.createdAt;
    }
    if (!Number.isFinite(oldest)) return;
    const delay = Math.max(1, oldest + this.historyWindowMs - Date.now());
    this.historyTimer = setTimeout(() => {
      this.historyTimer = undefined;
      if (!this.destroyed) this.refreshCoalesce.schedule();
    }, delay);
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
        this.clearHistoryExpiry();
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
        this.view.setStatusLine("Task not found", true);
        this.view.setRunning(false);
        this.sending = false;
        this.syncSendEnabled();
        this.restoreWriteStreamPreviews();
        return;
      }
      this.armHistoryExpiry(session.messages);
      const renderKey = JSON.stringify({
        messages: session.messages.map(message => [message.id, message.role, message.createdAt, message.parts]),
        asks: this.pendingAsks.map(ask => ask.requestId),
        approvals: this.pendingApprovals.map(approval => approval.requestId),
        status: session.status,
        window: tail?.window ?? null,
      });
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
      this.restoreWriteStreamPreviews();
      void this.restoreBuildCard();
    } catch (err) {
      console.error("[conversation] refresh failed", err);
      this.view.setStatusLine(
        err instanceof Error ? err.message : "Failed to load task",
        true,
      );
      this.restoreWriteStreamPreviews();
    }
  }

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

  private scheduleGitStatsRefresh(): void {
    if (this.gitStatsRefreshTimer != null) return;
    this.gitStatsRefreshTimer = setTimeout(() => {
      this.gitStatsRefreshTimer = null;
      void this.refreshGitStats();
    }, 200);
  }

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
      const targets = await this.footerTargets();
      const stats = await requireBridge().getWorkingTreeStats(path);
      if (seq !== this.gitStatsSeq) return;
      this.view.gitBar.setStats(stats);
      const gitRoot = targets.gitRoot;
      if (gitRoot && !sameDir(gitRoot, path)) {
        const behind = await requireBridge().getGitBehindCount(gitRoot);
        if (seq !== this.gitStatsSeq || this.destroyed) return;
        this.view.gitBar.setGitBehind(behind.behindCount);
      }
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

  private async refreshUpstream(): Promise<void> {
    if (this.transcriptOnly || this.destroyed) return;
    const path = this.workspacePath.trim();
    if (!path) return;
    const seq = ++this.upstreamSeq;
    try {
      const targets = await this.footerTargets();
      if (seq !== this.upstreamSeq || this.destroyed) return;
      await Promise.all([
        this.refreshGitUpstream(targets.gitRoot, seq),
        this.refreshSvnBehind(targets.svn ? path : null, seq),
      ]);
    } catch {
      if (seq !== this.upstreamSeq || this.destroyed) return;
      this.view.gitBar.setPullUncertain(false);
      this.view.gitBar.setSvnBehind(false);
    }
  }

  private async refreshGitUpstream(gitRoot: string | null, seq: number): Promise<void> {
    if (!gitRoot) {
      this.view.gitBar.setPullUncertain(false);
      return;
    }
    try {
      const res = await requireBridge().backgroundFetchWorkspace(gitRoot);
      if (seq !== this.upstreamSeq || this.destroyed) return;
      this.view.gitBar.setPullUncertain(!res.ok);
      if (res.ok) {
        void this.refreshGitStats();
      }
    } catch {
      if (seq === this.upstreamSeq && !this.destroyed) {
        this.view.gitBar.setPullUncertain(true);
      }
    }
  }

  private async refreshSvnBehind(path: string | null, seq: number): Promise<void> {
    if (!path) {
      this.view.gitBar.setSvnBehind(false);
      return;
    }
    try {
      const res = await requireBridge().svnUpdateAvailable(path);
      if (seq !== this.upstreamSeq || this.destroyed) return;
      this.view.gitBar.setSvnBehind(res.available);
    } catch {
      if (seq === this.upstreamSeq && !this.destroyed) {
        this.view.gitBar.setSvnBehind(false);
      }
    }
  }

  private footerTargets(): Promise<{ svn: boolean; gitRoot: string | null }> {
    const path = this.workspacePath.trim();
    if (!path) return Promise.resolve({ svn: false, gitRoot: null });
    if (this.footerVcsPromise && this.footerVcsPath === path) return this.footerVcsPromise;
    this.footerVcsPath = path;
    const requested = path;
    this.footerVcsPromise = requireBridge()
      .getFooterVcsTargets(path)
      .then((targets) => {
        if (!this.destroyed && this.workspacePath.trim() === requested) {
          this.view.gitBar.setSyncTargets({
            svn: targets.svn,
            git: gitTargetKind(targets.gitRoot, requested),
          });
        }
        return targets;
      })
      .catch((err) => {
        console.debug("[conversation] footer vcs targets failed", err);
        if (this.footerVcsPath === requested) {
          this.footerVcsPromise = null;
          this.footerVcsPath = "";
        }
        if (!this.destroyed && this.workspacePath.trim() === requested) {
          this.view.gitBar.setSyncTargets({ svn: false, git: "none" });
        }
        return { svn: false, gitRoot: null };
      });
    return this.footerVcsPromise;
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
      void this.refreshGitStats();
    }
  }

  onPullMergeSession: ((conflicts: string[], repoRoot: string) => void) | null = null;

  private async runSvnUpdate(): Promise<void> {
    if (this.gitBusy) return;
    const path = this.workspacePath.trim();
    if (!path) return;
    if (this.sessionStatus === "running" || this.sending) {
      void requireBridge().alertDialog?.({
        title: "Update",
        message: "Wait for the current turn to finish before updating.",
        type: "warning",
      });
      return;
    }
    this.gitBusy = true;
    this.view.gitBar.setUpdateBusy(true);
    try {
      const res = await requireBridge().runVcsAction(path, {
        kind: "svn-update",
        paths: ["."],
      });
      if (!res.ok) throw new Error(res.message ?? "Update failed");
      if (res.message && /conflict/i.test(res.message)) {
        void requireBridge().alertDialog?.({
          title: "Update",
          message: res.message,
          type: "warning",
        });
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : "Update failed";
      void requireBridge().alertDialog?.({
        title: "Update",
        message: text,
        type: "warning",
      });
      console.error("[conversation] svn update failed", err);
    } finally {
      this.gitBusy = false;
      this.view.gitBar.setUpdateBusy(false);
      void this.refreshGitStats();
      void this.refreshUpstream();
    }
  }

  private async runGitPull(): Promise<void> {
    if (this.gitBusy) return;
    const path = this.workspacePath.trim();
    if (!path) return;
    if (this.sessionStatus === "running" || this.sending) {
      void requireBridge().alertDialog?.({
        title: "Pull",
        message: "Wait for the current turn to finish before pulling.",
        type: "warning",
      });
      return;
    }
    const gitRoot = (await this.footerTargets()).gitRoot;
    if (!gitRoot || this.destroyed || this.gitBusy) return;
    this.gitBusy = true;
    this.view.gitBar.setPullBusy(true);
    try {
      const res = await requireBridge().pullWorkspace(gitRoot);
      if (Array.isArray(res.conflicts) && res.conflicts.length > 0) {
        await this.handlePullConflicts(res.conflicts, gitRoot);
      } else if (!res.ok) {
        throw new Error(res.message ?? "Pull failed");
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : "Pull failed";
      void requireBridge().alertDialog?.({
        title: "Pull",
        message: text,
        type: "warning",
      });
      console.error("[conversation] pull failed", err);
    } finally {
      this.gitBusy = false;
      this.view.gitBar.setPullBusy(false);
      void this.refreshGitStats();
    }
  }

  private async handlePullConflicts(conflicts: string[], gitRoot: string): Promise<void> {
    const bridge = requireBridge();
    const preview = conflicts.slice(0, 5).join(", ");
    const more =
      conflicts.length > 5 ? `… and ${conflicts.length - 5} more` : "";
    const resolve = await bridge.confirmDialog({
      title: "Pull",
      message: `A merge conflict stopped the pull (${conflicts.length} file${conflicts.length === 1 ? "" : "s"}).`,
      detail: `${preview}${more}\n\nCreate a task to let the LLM resolve the conflicts and complete the merge? The task is handed over to CoCo.`,
    });
    if (resolve) {
      if (this.onPullMergeSession) {
        this.onPullMergeSession(conflicts, gitRoot);
        return;
      }
      void bridge.alertDialog?.({
        title: "Pull",
        message:
          "The merge task flow is unavailable here. Resolve the conflicts manually, then pull again.",
        type: "warning",
      });
      return;
    }
    const discard = await bridge.confirmDialog({
      title: "Pull",
      message: "Discard this merge?",
      detail:
        "git merge --abort rolls the working tree back to the state before the pull. Unresolved files return to their pre-pull contents.",
    });
    if (discard) {
      const res = gitRoot
        ? await bridge.abortWorkspaceMerge(gitRoot)
        : { ok: false as const, message: "No Git repository." };
      if (!res.ok) {
        void bridge.alertDialog?.({
          title: "Pull",
          message: res.message,
          type: "warning",
        });
      }
      return;
    }
    void bridge.alertDialog?.({
      title: "Pull",
      message:
        "The merge is paused with conflicts. Resolve them manually — pulling again re-opens this choice.",
      type: "info",
    });
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

  private async executeSlashCommand(command: SlashCommand): Promise<void> {
    const hint = (text: string): void => {
      this.notifyHint(text);
    };
    if (command.name === "/opt") {
      hint("Usage: /opt <prompt>");
      return;
    }
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
          hint("Task is not paused — nothing to resume");
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
          hint("Resume the task before clearing");
        } else {
          hint("Cannot clear right now");
        }
        return;
      }
      if (command.name === "/end") {
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
          hint("Resume the task before ending");
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

  private async runManualCompact(keepRatio?: number): Promise<void> {
    const hint = (text: string): void => {
      this.notifyHint(text);
    };
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
      hint("Resume the task before compacting");
    } else {
      hint("Cannot compact right now");
    }
  }

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

  private async runWorkspaceTask(task: "build" | "run"): Promise<void> {
    const hint = (text: string, ms?: number): void => {
      this.notifyHint(text, ms);
    };
    const root = this.workspacePath.trim();
    if (!root) {
      hint("No workspace for this task — open it inside a project");
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

  private async attachBuildCard(runId: string): Promise<void> {
    const bridge = window.jellybot;
    const root = this.workspacePath.trim();
    if (!bridge?.getDevTaskState || !root) return;
    try {
      const state = await bridge.getDevTaskState(root);
      if (this.destroyed) return;
      const snap = state.active.find((s) => s.runId === runId);
      if (!snap) return;
      if (!snap.progress) return;
      this.mountBuildCard(snap);
    } catch {
    }
  }

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
        this.buildCard = null;
        this.buildCardWorkspace = "";
        this.view.setBuildStatusCard(null);
        return;
      }
      if (this.buildCard?.root.dataset.runId === active.runId) return;
      this.mountBuildCard(active);
    } catch {
    }
  }

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
    if (match.command.name !== "/opt") return false;
    if (this.optimizingPrompt) return true;
    this.optimizingPrompt = true;
    this.syncSendEnabled();
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

  private scheduleDraftSave(): void {
    if (this.draftSaveTimer != null) clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = setTimeout(() => {
      this.draftSaveTimer = null;
      setSessionDraft(this.sessionId, this.view.getPrompt());
    }, 300);
  }

  private clearDraftStash(): void {
    if (this.draftSaveTimer != null) {
      clearTimeout(this.draftSaveTimer);
      this.draftSaveTimer = null;
    }
    clearSessionDraft(this.sessionId);
  }

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

  private async enqueueComposerPrompt(): Promise<boolean> {
    if (this.view.composer.trySubmitSlashCommand()) return false;
    if (this.beginSlashCompactKeepRatio()) return false;
    this.trySlashModeSwitch();
    if (await this.tryOptimizePrompt()) return false;
    const text = this.view.getPrompt().trim();
    const attachments = this.attachmentsApi?.getAttachments() ?? [];
    if (!text && attachments.length === 0) return false;
    const pending = cloneAttachments(attachments);
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

  private async promoteQueuedPrompt(id: string): Promise<void> {
    try {
      const response = await requireBridge().promoteQueuedPrompt(
        this.sessionId,
        id,
      );
      this.applyPromptQueueSnapshot(response.items);
      if (response.started) {
        this.scheduleStructuralRefresh();
      }
    } catch (err) {
      console.error("[conversation] promoteQueuedPrompt failed", err);
    }
  }

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

  private applyPromptQueueSnapshot(items: QueuedPrompt[]): void {
    const demoQueueChanged = demoQueueFingerprint(this.promptQueue.map((item) => item.text)) !== demoQueueFingerprint(items.map((item) => item.userText));
    this.promptQueue = items.map(queuedPromptToViewItem);
    this.renderPromptQueue();
    this.syncSendEnabled();
    if (demoQueueChanged) this.scheduleStructuralRefresh();
  }

  private renderPromptQueue(): void {
    this.view.setPromptQueue(this.promptQueue);
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
    const pending = cloneAttachments(attachments);
    this.refreshCoalesce.clearPending();
    this.view.appendOptimisticUserMessage(text, pending);
    this.syncTurnProgress("Waiting for model…");
    this.syncSendEnabled();
    try {
      const prefs = this.getPrefs();
      const customGraphId =
        prefs.runMode === "custom" &&
        typeof prefs.fsmGraphId === "string" &&
        prefs.fsmGraphId.length > 0
          ? prefs.fsmGraphId
          : undefined;
      const editorContext = currentEditorContext();
      await requireBridge().startTurn({
        sessionId: this.sessionId,
        userText: text,
        fullPermissions: isFullPermissionsEnabled(),
        autoSkillSummarize: isAutoSkillSummarizeEnabled(),
        runMode: prefs.runMode,
        ...(customGraphId !== undefined ? { fsmGraphId: customGraphId } : {}),
        reasoningEffort: prefs.reasoningEffort,
        ...(editorContext ? { editorContext } : {}),
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
