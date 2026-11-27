import { toggleInfiniteMaxCombo } from "../../state/composerShortcuts.js";
import {
  COMPOSER_DRAFT_KEY,
  getComposerPrefs,
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
import { showAlert } from "../../ui/messageDialogs.js";
import {
  isAutoSkillSummarizeEnabled,
  setAutoSkillSummarizeEnabled,
  subscribeAutoSkillSummarize,
} from "../../state/autoSkillSummarizeState.js";
import {
  refreshWorkspacesState,
  subscribeWorkspaces,
  type WorkspacesState,
} from "../../state/workspaceState.js";
import { isImeComposing } from "../../ui/ime.js";
import type { ContextUsage } from "../../ui/contextUsage.js";
import { openWorkspaceTemplateMenu } from "../../ui/newWorkspaceFlow.js";
import { bindComposerAttachments } from "../../ui/taskComposer/bindComposerAttachments.js";
import type { PendingAttachment } from "../../ui/taskComposer/bindComposerAttachments.js";
import {
  createVoiceInput,
  type VoiceInputHandle,
} from "../../ui/taskComposer/voiceInput.js";
import { bindComposerProviders } from "../../ui/taskComposer/bindComposerProviders.js";
import {
  matchModeSlashCommand,
  matchSlashCommandWithArgs,
  matchSlashEscape,
} from "../../ui/taskComposer/slashCommands.js";
import type { ComposerProvidersBinding } from "../../ui/taskComposer/bindComposerProviders.js";
import { getProvidersState } from "../../state/activeProviderState.js";
import type { NewTaskView } from "./NewTaskView.js";

export type NewTaskControllerOptions = {
  onSessionStarted: (
    sessionId: string,
    options?: {
      optimisticUserText?: string;
      attachments?: PendingAttachment[];
      workspaceId?: string | null;
    },
  ) => void;
  onWorkspaceChanged?: () => void;
  fixedWorkspaceId?: string | null;
  draftKey?: string | undefined;
};

function requireBridge(): NonNullable<Window["jellybot"]> {
  const bridge = window.jellybot;
  if (!bridge) {
    throw new Error("jellybot bridge is unavailable");
  }
  return bridge;
}

export class NewTaskController {
  private unsubscribePermissions: (() => void) | undefined;
  private unsubscribeAutoSkillSummarize: (() => void) | undefined;
  private unsubscribeComposerPrefs: (() => void) | undefined;
  private providersBinding: ComposerProvidersBinding | undefined;
  private voiceInput: VoiceInputHandle | undefined;
  private unbindAttachments: (() => void) | undefined;
  private attachmentsApi:
    | ReturnType<typeof bindComposerAttachments>
    | undefined;
  private unsubWorkspaces: (() => void) | undefined;
  private starting = false;
  private optimizingPrompt = false;
  private activeWorkspaceId: string | null = null;
  private draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private draftProviderId: string | null = null;
  private contextUsage: ContextUsage = {
    usedTokens: 0,
    limitTokens: 128_000,
  };

  private get draftKey(): string {
    return this.options.draftKey ?? COMPOSER_DRAFT_KEY;
  }

  constructor(
    private readonly view: NewTaskView,
    private readonly options: NewTaskControllerOptions,
  ) {
    this.view.setActionsExpanded(false);
    this.view.setContextUsage(this.contextUsage);
    this.view.setPermissionsEnabled(isFullPermissionsEnabled());
    this.view.setAutoSkillSummarizeEnabled(isAutoSkillSummarizeEnabled());
    this.applyPrefs(this.getPrefs());
    this.view.setOnInfiniteSelect((enabled) => {
      setComposerPrefsFor(this.draftKey, { infinite: enabled });
    });
    this.view.setOnRunModeSelect((mode) => {
      setComposerPrefsFor(this.draftKey, {
        runMode: mode,
        fsmGraphId: null,
      });
    });
    this.view.setOnCustomGraphSelect((graph) => {
      setComposerPrefsFor(this.draftKey, {
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
    this.view.composer.setSlashCommandScope(["/opt", "/plan", "/ask", "/auto"]);
    this.view.composer.setOnSlashCommand((command) => {
      const modeTarget = matchModeSlashCommand(command.name);
      if (modeTarget) {
        if (this.getPrefs().runMode !== modeTarget) {
          setComposerPrefsFor(this.draftKey, {
            runMode: modeTarget,
            fsmGraphId: null,
          });
        }
        return true;
      }
      return true;
    });
    this.bind();
    const draft = getSessionDraft(this.draftKey);
    if (draft.length > 0) {
      this.view.composer.setPrompt(draft);
      this.syncSendEnabled();
    }
  }

  insertFileReference(path: string): boolean {
    return this.view.composer.insertFileReference(path);
  }

  mount(): HTMLElement {
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
      this.draftKey,
      (prefs) => {
        this.applyPrefs(prefs);
      },
    );
    this.applyPrefs(this.getPrefs());
    this.providersBinding = bindComposerProviders(this.view.composer, {
      getProviderId: () =>
        this.draftProviderId?.trim() ||
        getProvidersState().activeProviderId,
      onProviderSelect: (providerId) => {
        this.draftProviderId = providerId;
      },
      onSelectionMissing: (providerId) => {
        this.draftProviderId = providerId;
      },
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
    this.unsubWorkspaces = subscribeWorkspaces((state) => {
      void this.applyWorkspacesState(state);
    });
    void this.loadContextLimit();
    queueMicrotask(() => this.view.focusInput());
    return this.view.root;
  }

  destroy(): void {
    if (this.draftSaveTimer != null) {
      clearTimeout(this.draftSaveTimer);
      this.draftSaveTimer = null;
      setSessionDraft(this.draftKey, this.view.getPrompt());
    }
    document.removeEventListener("pointerdown", this.onDocumentPointerDown);
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
    this.unsubWorkspaces?.();
    this.unsubWorkspaces = undefined;
    this.view.setOnSelectWorkspace(null);
    this.view.setOnCreateWorkspace(null);
    this.view.composer.destroy();
    this.view.root.remove();
  }

  setContextUsage(usage: ContextUsage): void {
    this.contextUsage = usage;
    this.view.setContextUsage(usage);
  }

  private getPrefs(): SessionComposerPrefs {
    return getComposerPrefs(this.draftKey);
  }

  private applyPrefs(prefs: SessionComposerPrefs): void {
    if (prefs.runMode === "custom" && prefs.fsmGraphId) {
      this.view.setCustomGraphSelection({
        id: prefs.fsmGraphId,
        name: prefs.fsmGraphId,
      });
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
  }

  private syncSendEnabled(): void {
    const hasText = this.view.getPrompt().trim().length > 0;
    const hasAttachments =
      (this.attachmentsApi?.getAttachments().length ?? 0) > 0;
    this.view.setSendEnabled(
      !this.starting && !this.optimizingPrompt && (hasText || hasAttachments),
    );
  }

  private scheduleDraftSave(): void {
    if (this.draftSaveTimer != null) clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = setTimeout(() => {
      this.draftSaveTimer = null;
      setSessionDraft(this.draftKey, this.view.getPrompt());
    }, 300);
  }

  private clearDraftStash(): void {
    if (this.draftSaveTimer != null) {
      clearTimeout(this.draftSaveTimer);
      this.draftSaveTimer = null;
    }
    clearSessionDraft(this.draftKey);
  }

  private async loadContextLimit(): Promise<void> {
    try {
      const settings = await requireBridge().getWorkspaceSettings();
      const limit =
        typeof settings?.contextLimitTokens === "number" &&
        settings.contextLimitTokens > 0
          ? settings.contextLimitTokens
          : 128_000;
      this.setContextUsage({
        ...this.contextUsage,
        limitTokens: limit,
      });
    } catch (err) {
      console.error("[new-task] load context limit failed", err);
    }
  }

  private async applyWorkspacesState(state: WorkspacesState): Promise<void> {
    const options = state.workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      path: w.path,
    }));
    const activeId = state.activeWorkspaceId;
    const fixed = this.options.fixedWorkspaceId ?? null;
    const selected = fixed
      ? (options.find((w) => w.id === fixed) ?? null)
      : (options.find((w) => w.id === activeId) ?? options[0] ?? null);
    this.activeWorkspaceId = selected?.id ?? null;
    if (selected && selected.id !== activeId) {
      try {
        await requireBridge().setActiveWorkspaceId(selected.id);
      } catch (err) {
        console.error("[new-task] sync active workspace failed", err);
      }
    }
    this.view.setWorkspaces(
      fixed && selected ? [selected] : options,
      this.activeWorkspaceId,
    );
  }

  private async loadWorkspaces(): Promise<void> {
    await refreshWorkspacesState();
  }

  private bind(): void {
    this.view.setOnSelectWorkspace((workspaceId) => {
      void this.selectWorkspace(workspaceId);
    });
    this.view.setOnCreateWorkspace(() => {
      void this.createNewWorkspace();
    });

    this.view.textarea.addEventListener("input", () => {
      this.syncSendEnabled();
      this.scheduleDraftSave();
    });

    this.view.setOnReasoningEffortSelect((level) => {
      setComposerPrefsFor(this.draftKey, { reasoningEffort: level });
    });

    this.view.workspaceButton.addEventListener("click", () => {
      this.view.setWorkspaceMenuOpen(!this.view.isWorkspaceMenuOpen());
    });

    this.view.sendButton.addEventListener("click", () => {
      void this.startNewTask();
    });

    this.view.textarea.addEventListener("keydown", (event) => {
      if (event.key.toLowerCase() === "m" && event.metaKey && event.shiftKey) {
        event.preventDefault();
        toggleInfiniteMaxCombo(this.draftKey);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !isImeComposing(event)) {
        event.preventDefault();
        if (!this.view.sendButton.disabled) {
          this.view.sendButton.click();
        }
      }
    });

    document.addEventListener("pointerdown", this.onDocumentPointerDown);
  }

  private onDocumentPointerDown = (event: PointerEvent): void => {
    if (!this.view.isWorkspaceMenuOpen()) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (
      this.view.workspaceMenu.contains(target) ||
      this.view.workspaceButton.contains(target)
    ) {
      return;
    }
    this.view.setWorkspaceMenuOpen(false);
  };

  private async selectWorkspace(workspaceId: string): Promise<void> {
    const bridge = requireBridge();
    try {
      await bridge.setActiveWorkspaceId(workspaceId);
      this.activeWorkspaceId = workspaceId;
      await this.loadWorkspaces();
      this.options.onWorkspaceChanged?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await showAlert(message, { type: "error", title: "Error" });
    }
  }

  private createNewWorkspace(): void {
    openWorkspaceTemplateMenu(this.view.workspaceButton, {
      onCreated: (workspace) => {
        this.activeWorkspaceId = workspace.id;
        void (async () => {
          await this.loadWorkspaces();
          this.view.setWorkspaceMenuOpen(false);
          this.options.onWorkspaceChanged?.();
        })();
      },
    });
  }

  private trySlashModeSwitch(): void {
    const match = matchSlashCommandWithArgs(this.view.getPrompt());
    if (!match) return;
    const modeTarget = matchModeSlashCommand(match.command.name);
    if (!modeTarget) return;
    if (this.getPrefs().runMode !== modeTarget) {
      setComposerPrefsFor(this.draftKey, {
        runMode: modeTarget,
        fsmGraphId: null,
      });
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
    const providerId =
      this.draftProviderId?.trim() || getProvidersState().activeProviderId;
    try {
      const result = await requireBridge().optimizeUserPrompt({
        text: match.args,
        ...(providerId ? { providerId } : {}),
      });
      if ("text" in result && result.text.trim()) {
        this.view.composer.setPrompt(result.text);
        return false;
      }
      return true;
    } catch (err) {
      console.error("[new-task] /opt optimization failed", err);
      return true;
    } finally {
      this.optimizingPrompt = false;
      this.syncSendEnabled();
    }
  }

  private async startNewTask(): Promise<void> {
    this.trySlashModeSwitch();
    if (await this.tryOptimizePrompt()) return;
    const text = this.view.getPrompt().trim();
    const attachments = this.attachmentsApi?.getAttachments() ?? [];
    if ((!text && attachments.length === 0) || this.starting) return;
    if (!this.activeWorkspaceId) {
      void showAlert("Create or select a workspace before starting a task.", { title: "New Task" });
      return;
    }
    this.starting = true;
    this.view.setSendEnabled(false);
    const pendingAttachments = attachments.map((item) => ({ ...item }));
    try {
      const providerId =
        this.draftProviderId?.trim() ||
        getProvidersState().activeProviderId;
      const prefs = this.getPrefs();
      const customGraphId =
        prefs.runMode === "custom" &&
        typeof prefs.fsmGraphId === "string" &&
        prefs.fsmGraphId.length > 0
          ? prefs.fsmGraphId
          : undefined;
      const editorContext = currentEditorContext();
      const { sessionId } = await requireBridge().startTurn({
        ...(editorContext ? { editorContext } : {}),
        userText: text,
        fullPermissions: isFullPermissionsEnabled(),
        autoSkillSummarize: isAutoSkillSummarizeEnabled(),
        runMode: prefs.runMode,
        ...(customGraphId !== undefined ? { fsmGraphId: customGraphId } : {}),
        composerInfinite: prefs.infinite,
        reasoningEffort: prefs.reasoningEffort,
        workspaceId: this.activeWorkspaceId,
        ...(providerId ? { providerId } : {}),
        attachments: pendingAttachments.map((item) => ({
          path: item.path,
          name: item.name,
          kind: item.kind,
          mimeType: item.mimeType,
          ...(item.sizeBytes !== undefined
            ? { sizeBytes: item.sizeBytes }
            : {}),
        })),
      });
      this.view.clearPrompt();
      this.clearDraftStash();
      this.attachmentsApi?.clear();
      this.options.onSessionStarted(sessionId, {
        optimisticUserText: text,
        attachments: pendingAttachments,
        workspaceId: this.activeWorkspaceId ?? null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void showAlert(message, { title: "New Task", type: "error" });
      this.syncSendEnabled();
    } finally {
      this.starting = false;
    }
  }
}
