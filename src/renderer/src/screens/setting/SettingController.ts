import {
  getProvidersState,
  setProvidersState,
} from "../../state/activeProviderState.js";
import {
  formatBytes,
  type SettingCardId,
  type SettingFormState,
  type SettingProviderForm,
  type SettingImageGenForm,
  type SettingObjectStorageForm,
  type SettingView,
} from "./SettingView.js";
import { applyAccentOverride, applyTheme } from "../../state/themeManager.js";
import { applyFontScales } from "../../state/fontScale.js";
import { showTextPromptDialog } from "../../ui/TextPromptDialogView.js";
import {
  providerDisplayName,
  showProviderWizard,
  type ProviderWizardPick,
} from "../../ui/ProviderWizardView.js";
import { getTheme, type ThemeId } from "../../state/theme.js";
import { seedComposerPrefsDefaults } from "../../state/sessionComposerPrefs.js";
import { normalizeLlmProviderOptions, type LlmProviderApiOptions } from "../../../../llm/apiProtocol.js";

const OBJECT_STORAGE_CREDENTIAL_ID = "object-storage";
const AUTO_SAVE_DEBOUNCE_MS = 450;

const DEFAULT_FORM: SettingFormState = {
  providers: [
    {
      id: "default",
      name: "Default",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4o-mini",
      supportsMultimodal: false,
      imageInput: "url",
      rawEndpoint: false,
    },
  ],
  activeProviderId: "default",
  selectedProviderId: "default",
  apiKeyConfiguredByProviderId: {},
  visionProviderId: null,
  inlineCompletionProviderId: null,
  imageGenProviders: [],
  activeImageGenProviderId: "",
  selectedImageGenProviderId: "",
  imageGenApiKeyConfiguredByProviderId: {},
  objectStorage: null,
  objectStorageSecretConfigured: false,
  fullPermissionsDefault: false,
  autoSkillSummarizeDefault: false,
  composerInfinite: false,
  reasoningEffort: "low" as ReasoningEffort,
  contextLimitTokens: 128_000,
  compactTriggerRatio: 0.55,
  iterationProtectRawIterationCount: 20,
  iterationProtectTokenRatio: 0.2,
  maxModelIterations: 128,
  maxTurnTokens: 3_000_000,
  llmRequestTimeoutMs: 30_000,
  toolStatsEnabled: true,
  environmentContext: {
    workspace: true,
    timezone: true,
    locale: true,
    location: true,
    repository: true,
  },
  userMemoryAutoExtract: true,
  userMemoryProfile: "",
  userMemoryUpdatedAt: 0,
  themeId: "dark",
  accentColor: "auto",
  uiFontScale: 1,
  chatFontScale: 1,
};

function toProviderForm(p: LlmProviderApiOptions & {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  rawEndpoint?: boolean;
  supportsMultimodal?: boolean;
  imageInput?: "url" | "base64" | "file";
  toolRoleImages?: boolean;
}): SettingProviderForm {
  return {
    ...normalizeLlmProviderOptions(p),
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    modelId: p.modelId,
    supportsMultimodal: p.supportsMultimodal === true,
    imageInput:
      p.imageInput === "base64" || p.imageInput === "file"
        ? p.imageInput
        : "url",
    ...(typeof p.toolRoleImages === "boolean"
      ? { toolRoleImages: p.toolRoleImages }
      : {}),
    rawEndpoint: p.rawEndpoint === true,
  };
}

function requireBridge(): NonNullable<Window["jellybot"]> {
  const bridge = window.jellybot;
  if (!bridge) {
    throw new Error("jellybot bridge is unavailable");
  }
  return bridge;
}

function newLocalId(): string {
  return crypto.randomUUID();
}

type PersistOptions = {
  /** Skip disabling controls (background auto-save). */
  quiet?: boolean;
  /** Surface validation errors (default true for immediate saves). */
  reportValidation?: boolean;
  /** Call setForm after save (destructive to focus; default false). */
  refreshForm?: boolean;
};

/**
 * Setting screen logic — multi-provider profiles + vision + encrypted key store + agent prefs.
 * Changes auto-persist; cards have no Save buttons.
 */
export class SettingController {
  private current: SettingFormState = structuredClone(DEFAULT_FORM);
  private promptDefaults = {
    userPrompt: "",
  };
  /** Not shown in Setting UI; preserved when rewriting settings.json. */
  private projectMemoryAutoExtract = true;
  private readonly debounceTimers = new Map<
    SettingCardId,
    ReturnType<typeof setTimeout>
  >();
  private persistChain: Promise<void> = Promise.resolve();
  private disposed = false;
  private unsubProvidersChanged: (() => void) | null = null;
  /**
   * False until the first successful snapshot load. Prevents autosave from
   * writing the placeholder DEFAULT_FORM providers over real settings.json.
   */
  private hydrated = false;

  constructor(private readonly view: SettingView) {
    this.bind();
  }

  mount(): HTMLElement {
    this.hydrated = false;
    this.view.setForm(this.current);
    void this.refresh();
    void this.refreshStorageUsage();
    this.unsubProvidersChanged?.();
    this.unsubProvidersChanged =
      window.jellybot?.onLlmProvidersChanged?.(() => {
        if (this.disposed || !this.hydrated) return;
        if (this.debounceTimers.size > 0) return;
        void this.refresh();
      }) ?? null;
    return this.view.root;
  }

  destroy(): void {
    this.disposed = true;
    this.hydrated = false;
    this.unsubProvidersChanged?.();
    this.unsubProvidersChanged = null;
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.view.setOnSelectProvider(null);
    this.view.setOnProviderOrderChange(null);
    this.view.setOnSelectImageGenProvider(null);
    this.view.root.remove();
  }

  private bind(): void {
    this.view.setOnSelectProvider(() => {
      this.view.setCardStatus("providers", null);
    });
    this.view.setOnSelectImageGenProvider(() => {
      this.view.setCardStatus("imagegen", null);
    });

    // Drag-reorder commits to settings.providers array order; the composer
    // switcher + New Task menus follow the same order.
    this.view.setOnProviderOrderChange(() => {
      this.syncCurrentProvidersFromView();
      this.enqueuePersist(() => this.saveProviders());
    });

    this.view.addProviderButton.addEventListener("click", () => {
      this.addProvider();
    });
    this.view.deleteProviderButton.addEventListener("click", () => {
      this.deleteSelectedProvider();
    });
    this.view.setDefaultProviderButton.addEventListener("click", () => {
      void this.setSelectedAsDefaultProvider();
    });
    this.view.clearApiKeyButton.addEventListener("click", () => {
      void this.clearApiKey();
    });
    this.view.addImageGenProviderButton.addEventListener("click", () => {
      this.addImageGenProvider();
    });
    this.view.deleteImageGenProviderButton.addEventListener("click", () => {
      this.deleteSelectedImageGenProvider();
    });
    this.view.setActiveImageGenProviderButton.addEventListener("click", () => {
      void this.setActiveImageGenProvider();
    });
    this.view.clearImageGenApiKeyButton.addEventListener("click", () => {
      void this.clearImageGenApiKey();
    });
    this.view.clearObjectStorageButton.addEventListener("click", () => {
      void this.clearObjectStorage();
    });
    this.view.clearObjectStorageSecretButton.addEventListener("click", () => {
      void this.clearObjectStorageSecret();
    });
    this.view.objectStorageTestButton.addEventListener("click", () => {
      void this.testObjectStorage();
    });
    this.view.clearMemoryButton.addEventListener("click", () => {
      void this.clearMemory();
    });
    this.view.cleanupButton.addEventListener("click", () => {
      void this.cleanupStorage();
    });
    this.view.exportBackupButton.addEventListener("click", () => {
      void this.exportBackup();
    });
    this.view.chooseBackupButton.addEventListener("click", () => {
      void this.chooseBackupFile();
    });
    this.view.applyBackupButton.addEventListener("click", () => {
      void this.applyBackup();
    });
    this.view.resetUserPromptButton.addEventListener("click", () => {
      if (!this.promptDefaults.userPrompt.trim()) {
        this.view.setCardStatus(
          "user",
          "Default USER.md is unavailable (missing markdown file)",
          "error",
        );
        return;
      }
      this.view.setUserMemoryProfile(this.promptDefaults.userPrompt);
      this.enqueuePersist(() => this.saveMemory({ quiet: true }));
    });

    this.bindProviderAutoSave();
    this.bindVisionSave();
    this.bindCompletionSave();
    this.bindImageGenAutoSave();
    this.bindObjectStorageAutoSave();
    this.bindPermissionsAutoSave();
    this.bindComposerDefaultsAutoSave();
    this.bindShellSafety();
    this.bindAgentAutoSave();
    this.bindAppearanceAutoSave();
    this.bindMemoryAutoSave();
  }

  private syncCurrentProvidersFromView(): void {
    if (!this.hydrated) return;
    this.current.providers = this.view.getProvidersDraft();
    this.current.activeProviderId = this.view.getActiveProviderId();
    this.current.selectedProviderId = this.view.getSelectedProviderId();
  }

  private bindProviderAutoSave(): void {
    const schedule = (): void => {
      this.view.commitSelectedDetailToModel();
      this.view.refreshProviderList();
      this.view.setCompletionOptions(this.view.getProvidersDraft());
      this.syncCurrentProvidersFromView();
      this.scheduleCardSave("providers", () => this.saveProviders());
    };
    for (const el of [
      this.view.nameInput,
      this.view.baseUrlInput,
      this.view.modelIdInput,
    ]) {
      el.addEventListener("input", schedule);
    }
    this.view.multimodalToggle.addEventListener("change", () => {
      // Multimodal toggling changes the Vision dropdown's option set.
      this.view.commitSelectedDetailToModel();
      this.view.setVisionOptions(this.view.getProvidersDraft());
      this.enqueuePersist(() => this.saveProviders());
    });
    this.view.imageInputSelect.addEventListener("change", () => {
      this.enqueuePersist(() => this.saveProviders());
    });
    this.view.rawEndpointToggle.addEventListener("change", () => {
      this.enqueuePersist(() => this.saveProviders());
    });
    for (const el of [this.view.apiProtocolSelect, this.view.responsesStatefulToggle]) {
      el.addEventListener("change", () => this.enqueuePersist(() => this.saveProviders()));
    }
    this.view.responsesToolsInput.addEventListener("input", () => {
      if (this.view.validateResponsesTools()) this.scheduleCardSave("providers", () => this.saveProviders());
      else this.view.setCardStatus("providers", this.view.responsesToolsInput.validationMessage, "error");
    });
    this.view.apiKeyInput.addEventListener("blur", () => {
      if (this.view.getApiKeyDraft().trim()) {
        this.enqueuePersist(() => this.saveApiKey());
      }
    });
    this.view.apiKeyInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        (event.target as HTMLInputElement).blur();
      }
    });
  }

  private bindVisionSave(): void {
    this.view.visionProviderSelect.addEventListener("change", () => {
      this.enqueuePersist(() => this.saveVision());
    });
  }

  private bindCompletionSave(): void {
    this.view.completionProviderSelect.addEventListener("change", () => {
      this.enqueuePersist(() => this.saveCompletion());
    });
  }

  private bindImageGenAutoSave(): void {
    const schedule = (): void => {
      this.view.commitSelectedImageGenDetailToModel();
      this.view.refreshImageGenProviderList();
      this.scheduleCardSave("imagegen", () => this.saveImageGen());
    };
    for (const el of [
      this.view.imageGenNameInput,
      this.view.imageGenBaseUrlInput,
      this.view.imageGenModelIdInput,
    ]) {
      el.addEventListener("input", schedule);
    }
    this.view.imageGenRawEndpointToggle.addEventListener("change", schedule);
    this.view.imageGenWatermarkSelect.addEventListener("change", schedule);
    this.view.imageGenImageInputSelect.addEventListener("change", schedule);
    this.view.imageGenApiKeyInput.addEventListener("blur", () => {
      if (this.view.getImageGenApiKeyDraft().trim()) {
        this.enqueuePersist(() => this.saveImageGenApiKey());
      }
    });
    this.view.imageGenApiKeyInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        (event.target as HTMLInputElement).blur();
      }
    });
  }

  private bindPermissionsAutoSave(): void {
    for (const toggle of [
      this.view.fullPermissionsToggle,
      this.view.autoSkillSummarizeToggle,
    ]) {
      toggle.addEventListener("change", () => {
        this.enqueuePersist(() => this.savePermissions());
      });
    }
  }

  private bindComposerDefaultsAutoSave(): void {
    // Same card as Bypass permissions now — both flows save the merged
    // permissions patch, so each toggle persists all three fields.
    const schedule = (): void => {
      this.enqueuePersist(() => this.saveComposerDefaults());
    };
    this.view.newTaskInfiniteToggle.addEventListener("change", schedule);
    this.view.onReasoningEffortChange = () => schedule();
  }

  private bindAppearanceAutoSave(): void {
    this.view.themeSelect.addEventListener("change", () => {
      // Apply instantly for live preview (presets swap to the new theme's
      // variant), then persist.
      const { themeId, accentColor } = this.view.getAppearanceValues();
      applyTheme(themeId, accentColor === "auto" ? null : accentColor);
      this.view.accentPicker.refresh();
      this.enqueuePersist(() => this.saveAppearance());
    });
    this.view.accentPicker.addEventListener("change", () => {
      const { accentColor } = this.view.getAppearanceValues();
      applyAccentOverride(accentColor === "auto" ? null : accentColor);
      this.enqueuePersist(() => this.saveAppearance());
    });
    this.view.uiFontScaleSelect.addEventListener("change", () => {
      applyFontScales({ ui: this.view.getAppearanceValues().uiFontScale });
      this.enqueuePersist(() => this.saveAppearance());
    });
    this.view.chatFontScaleSelect.addEventListener("change", () => {
      applyFontScales({ chat: this.view.getAppearanceValues().chatFontScale });
      this.enqueuePersist(() => this.saveAppearance());
    });
  }

  /**
   * Shell Safe Mode card — persisted in tools.json through its own IPC
   * (tools:setShellSafety), not via saveWorkspaceSettings patches.
   */
  private bindShellSafety(): void {
    const save = (): void => {
      this.enqueuePersist(() => this.saveShellSafety());
    };
    this.view.shellSafetyToggle.addEventListener("change", save);
    this.view.shellSafetyPolicySelect.addEventListener("change", save);
  }

  private async saveShellSafety(): Promise<void> {
    const bridge = requireBridge();
    if (typeof bridge.setShellSafety !== "function") {
      this.view.setCardStatus(
        "safety",
        "Restart the app to update Shell Safe Mode (preload outdated)",
        "error",
      );
      return;
    }
    this.view.setBusy("safety");
    this.view.setCardStatus("safety", null);
    try {
      const updated = await bridge.setShellSafety(
        this.view.getShellSafetyValues(),
      );
      if (this.disposed) return;
      this.view.setShellSafety(updated);
    } catch (err) {
      if (this.disposed) return;
      const message = err instanceof Error ? err.message : String(err);
      this.view.setCardStatus("safety", message, "error");
    } finally {
      if (!this.disposed) this.view.setBusy(null);
    }
  }

  private bindAgentAutoSave(): void {
    const schedule = (): void => {
      this.scheduleCardSave("agent", () => this.saveAgent());
    };
    const immediate = (): void => {
      this.enqueuePersist(() => this.saveAgent());
    };
    for (const el of [
      this.view.contextLimitInput,
      this.view.compactTriggerRatioInput,
      this.view.iterationProtectRawIterationCountInput,
      this.view.iterationProtectTokenRatioInput,
      this.view.maxRoundsInput,
      this.view.maxTurnTokensInput,
      this.view.llmRequestTimeoutInput,
    ]) {
      el.addEventListener("input", schedule);
      el.addEventListener("change", immediate);
    }
    for (const el of [
      this.view.toolStatsEnabledToggle,
      this.view.envWorkspaceToggle,
      this.view.envTimezoneToggle,
      this.view.envLocaleToggle,
      this.view.envLocationToggle,
      this.view.envRepositoryToggle,
    ]) {
      el.addEventListener("change", immediate);
    }
  }

  private bindMemoryAutoSave(): void {
    this.view.userMemoryAutoExtractToggle.addEventListener("change", () => {
      this.enqueuePersist(() => this.saveMemory({ quiet: true }));
    });
    this.view.userMemoryProfileInput.addEventListener("input", () => {
      this.scheduleCardSave("user", () => this.saveMemory({ quiet: true }));
    });
  }

  private cancelCardSave(card: SettingCardId): void {
    const existing = this.debounceTimers.get(card);
    if (existing) clearTimeout(existing);
    this.debounceTimers.delete(card);
  }

  private scheduleCardSave(
    card: SettingCardId,
    run: () => Promise<void>,
  ): void {
    this.cancelCardSave(card);
    this.debounceTimers.set(
      card,
      setTimeout(() => {
        this.debounceTimers.delete(card);
        if (this.disposed) return;
        this.enqueuePersist(run);
      }, AUTO_SAVE_DEBOUNCE_MS),
    );
  }

  private enqueuePersist(run: () => Promise<void>): void {
    this.persistChain = this.persistChain
      .then(async () => {
        if (this.disposed) return;
        await run();
      })
      .catch(() => {
        // Errors are surfaced via card status inside run().
      });
  }

  private async refresh(): Promise<void> {
    try {
      const bridge = requireBridge();
      const snapshot = await bridge.getSettingsSnapshot();
      if (this.disposed) return;
      this.view.setAppVersion(snapshot.appVersion ?? "");
      const imageGenProviders = snapshot.settings.imageGenProviders ?? [];
      const activeImageGenProviderId =
        snapshot.settings.activeImageGenProviderId ||
        imageGenProviders[0]?.id ||
        "";
      this.promptDefaults = {
        userPrompt: snapshot.promptDefaults.userPrompt,
      };
      this.projectMemoryAutoExtract =
        snapshot.settings.projectMemoryAutoExtract !== false;
      this.current = {
        providers: snapshot.settings.providers.map(toProviderForm),
        activeProviderId: snapshot.settings.activeProviderId,
        selectedProviderId: snapshot.settings.activeProviderId,
        apiKeyConfiguredByProviderId: {
          ...snapshot.apiKeyConfiguredByProviderId,
        },
        visionProviderId: snapshot.settings.visionProviderId ?? null,
        inlineCompletionProviderId:
          snapshot.settings.inlineCompletionProviderId ?? null,
        imageGenProviders: imageGenProviders.map((p) => ({
          id: p.id,
          name: p.name,
          baseUrl: p.baseUrl,
          modelId: p.modelId,
          rawEndpoint: p.rawEndpoint === true,
          ...(typeof p.watermark === "boolean"
            ? { watermark: p.watermark }
            : {}),
          ...(p.imageInput === "base64" || p.imageInput === "url"
            ? { imageInput: p.imageInput }
            : {}),
        })),
        activeImageGenProviderId,
        selectedImageGenProviderId: activeImageGenProviderId,
        imageGenApiKeyConfiguredByProviderId: Object.fromEntries(
          imageGenProviders
            .map((p) => [
              p.id,
              snapshot.apiKeyConfiguredByProviderId[p.id] === true,
            ] as const),
        ),
        objectStorage: snapshot.settings.objectStorage
          ? {
              provider: snapshot.settings.objectStorage.provider,
              region: snapshot.settings.objectStorage.region,
              bucket: snapshot.settings.objectStorage.bucket,
              accessKeyId: snapshot.settings.objectStorage.accessKeyId,
              endpoint: snapshot.settings.objectStorage.endpoint ?? "",
              keyPrefix: snapshot.settings.objectStorage.keyPrefix ?? "",
              urlMode:
                snapshot.settings.objectStorage.urlMode === "public"
                  ? "public"
                  : "presigned",
              enabled: snapshot.settings.objectStorage.enabled !== false,
            }
          : null,
        objectStorageSecretConfigured:
          snapshot.apiKeyConfiguredByProviderId[
            OBJECT_STORAGE_CREDENTIAL_ID
          ] === true,
        fullPermissionsDefault: snapshot.settings.fullPermissionsDefault,
        autoSkillSummarizeDefault: snapshot.settings.autoSkillSummarizeDefault,
        composerInfinite: snapshot.settings.composerInfinite,
        reasoningEffort: snapshot.settings.reasoningEffort ?? "low",
        contextLimitTokens: snapshot.settings.contextLimitTokens,
        compactTriggerRatio: snapshot.settings.compactTriggerRatio,
        iterationProtectRawIterationCount: snapshot.settings.iterationProtectRawIterationCount,
        iterationProtectTokenRatio: snapshot.settings.iterationProtectTokenRatio,
        maxModelIterations: snapshot.settings.maxModelIterations,
        maxTurnTokens: snapshot.settings.maxTurnTokens,
        llmRequestTimeoutMs: snapshot.settings.llmRequestTimeoutMs,
        toolStatsEnabled: snapshot.settings.toolStatsEnabled,
        environmentContext: {
          workspace: snapshot.settings.environmentContext.workspace,
          timezone: snapshot.settings.environmentContext.timezone,
          locale: snapshot.settings.environmentContext.locale,
          location: snapshot.settings.environmentContext.location,
          repository: snapshot.settings.environmentContext.repository !== false,
        },
        userMemoryAutoExtract: snapshot.settings.userMemoryAutoExtract,
        userMemoryProfile: "",
        userMemoryUpdatedAt: 0,
        themeId: snapshot.settings.themeId,
        accentColor: snapshot.settings.accentColor ?? "auto",
        uiFontScale: snapshot.settings.uiFontScale ?? 1,
        chatFontScale: snapshot.settings.chatFontScale ?? 1,
      };
      // Mark hydrated before setForm so any change handlers that fire while
      // applying the form persist the real snapshot, not DEFAULT_FORM.
      this.hydrated = true;
      this.view.setForm(this.current);
      this.view.setCardStatus("providers", null);
      this.view.setCardStatus("vision", null);
      this.view.setCardStatus("imagegen", null);
      setProvidersState({
        providers: this.current.providers,
        activeProviderId: this.current.activeProviderId,
      });
      // Shell Safe Mode persists in tools.json (not settings.json) — load it
      // alongside the snapshot; failure keeps the safe view defaults.
      try {
        const shellSafety = await bridge.getShellSafety();
        if (!this.disposed) this.view.setShellSafety(shellSafety);
      } catch {
        // keep defaults (enabled / ask)
      }
      const memory = await bridge.getUserMemory();
      if (this.disposed) return;
      this.current.userMemoryProfile = memory.profile;
      this.current.userMemoryUpdatedAt = memory.updatedAt;
      this.view.setUserMemoryProfile(memory.profile);
      this.view.userMemoryAutoExtractToggle.checked =
        this.current.userMemoryAutoExtract;
    } catch (err) {
      this.hydrated = false;
      this.view.setForm(this.current);
      const message = err instanceof Error ? err.message : String(err);
      this.view.setCardStatus("providers", message, "error");
    }
  }

  private addProvider(): void {
    const drafts = this.view.getProvidersDraft();
    void showProviderWizard({
      existingProviders: drafts.map((p) => ({
        baseUrl: p.baseUrl,
        modelId: p.modelId,
      })),
    }).then((pick) => {
      if (this.disposed || !pick) return;
      this.applyProviderWizardPick(pick);
    });
  }

  /** Batch-add one profile per picked model (wizard: one model = one
   * profile), then persist settings before storing the shared API key. */
  private applyProviderWizardPick(pick: ProviderWizardPick): void {
    const drafts = this.view.getProvidersDraft();
    const keyed: Array<{ id: string; apiKey: string }> = [];
    for (const modelId of pick.models) {
      const id = newLocalId();
      drafts.push({
        id,
        name: providerDisplayName(modelId),
        baseUrl: pick.baseUrl,
        modelId,
        supportsMultimodal: false,
        imageInput: "url",
        rawEndpoint: pick.rawEndpoint === true,
        apiProtocol: pick.apiProtocol,
      });
      keyed.push({ id, apiKey: pick.apiKey.trim() });
    }
    const firstNewId = keyed[0]!.id;
    this.view.setProvidersLocal(
      drafts,
      firstNewId,
      this.view.getActiveProviderId() || firstNewId,
    );
    // New profiles may be Multimodal — refresh the Vision dropdown.
    this.view.setVisionOptions(drafts);
    this.view.setCompletionOptions(drafts);
    this.syncCurrentProvidersFromView();
    this.enqueuePersist(async () => {
      await this.saveProviders();
      await this.storeWizardApiKeys(keyed);
    });
  }

  /** Store the wizard's API key for every added profile. settings:setApiKey
   * requires the provider to already exist in settings.json, so this only
   * runs after saveProviders() has resolved. */
  private async storeWizardApiKeys(
    entries: ReadonlyArray<{ id: string; apiKey: string }>,
  ): Promise<void> {
    const keyed = entries.filter((entry) => entry.apiKey);
    if (keyed.length === 0) return;
    const bridge = requireBridge();
    if (typeof bridge.setApiKey !== "function") {
      this.view.setCardStatus(
        "providers",
        "Cannot store API keys in this build",
        "error",
      );
      return;
    }
    let stored = 0;
    for (const entry of keyed) {
      try {
        const result = await bridge.setApiKey({
          providerId: entry.id,
          apiKey: entry.apiKey,
        });
        this.current.apiKeyConfiguredByProviderId[entry.id] =
          result.apiKeyConfigured;
        if (result.apiKeyConfigured) stored += 1;
      } catch {
        // Provider profiles are already saved; report the key failure below.
      }
    }
    const selectedId = this.view.getSelectedProviderId();
    if (selectedId) {
      this.view.setApiKeyConfigured(
        this.current.apiKeyConfiguredByProviderId[selectedId] === true,
      );
    }
    if (stored < keyed.length) {
      this.view.setCardStatus(
        "providers",
        `Stored ${stored}/${keyed.length} API keys`,
        "error",
      );
    }
  }

  private deleteSelectedProvider(): void {
    const drafts = this.view.getProvidersDraft();
    if (drafts.length <= 1) {
      this.view.setCardStatus(
        "providers",
        "Keep at least one provider profile",
        "error",
      );
      return;
    }
    const selectedId = this.view.getSelectedProviderId();
    const next = drafts.filter((p) => p.id !== selectedId);
    let activeId = this.view.getActiveProviderId();
    if (activeId === selectedId) {
      activeId = next[0]!.id;
    }
    this.view.setProvidersLocal(next, next[0]!.id, activeId);
    // Removing a referenced provider invalidates Vision and Completion.
    this.view.setVisionOptions(next);
    this.view.setCompletionOptions(next);
    this.syncCurrentProvidersFromView();
    this.enqueuePersist(() => this.saveProviders());
  }

  /** Persist settings.activeProviderId as the default for new tasks only. */
  private async setSelectedAsDefaultProvider(): Promise<void> {
    const providerId = this.view.getSelectedProviderId();
    if (!providerId) return;
    if (providerId === this.view.getActiveProviderId()) return;
    const bridge = requireBridge();
    if (typeof bridge.setActiveProvider !== "function") {
      this.view.setCardStatus(
        "providers",
        "Cannot update default provider",
        "error",
      );
      return;
    }
    this.view.setBusy("providers");
    try {
      const saved = await bridge.setActiveProvider(providerId);
      this.current.activeProviderId = saved.activeProviderId;
      this.view.setProvidersLocal(
        this.view.getProvidersDraft(),
        this.view.getSelectedProviderId(),
        saved.activeProviderId,
      );
      setProvidersState({
        providers: saved.providers,
        activeProviderId: saved.activeProviderId,
      });
      this.view.setCardStatus(
        "providers",
        "Default for new tasks updated",
        "ok",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.setCardStatus("providers", message, "error");
    } finally {
      this.view.setBusy(null);
    }
  }

  private mapProvidersForSave(
    providers: SettingProviderForm[],
  ): Array<LlmProviderApiOptions & {
    id: string;
    name: string;
    baseUrl: string;
    modelId: string;
    rawEndpoint?: boolean;
    supportsMultimodal?: boolean;
    imageInput?: "url" | "base64" | "file";
    toolRoleImages?: boolean;
  }> {
    return providers.map((p) => {
      const out: LlmProviderApiOptions & {
        id: string;
        name: string;
        baseUrl: string;
        modelId: string;
        rawEndpoint?: boolean;
        supportsMultimodal?: boolean;
        imageInput?: "url" | "base64" | "file";
        toolRoleImages?: boolean;
      } = {
        ...normalizeLlmProviderOptions(p),
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        modelId: p.modelId,
      };
      if (p.rawEndpoint) out.rawEndpoint = true;
      if (p.supportsMultimodal) out.supportsMultimodal = true;
      if (p.imageInput === "base64" || p.imageInput === "file") {
        out.imageInput = p.imageInput;
      }
      if (typeof p.toolRoleImages === "boolean") {
        out.toolRoleImages = p.toolRoleImages;
      }
      return out;
    });
  }

  /**
   * Sparse patch for one Setting card. Main merges onto disk settings — each
   * autosave may only touch fields owned by that card.
   */
  private buildCardPatch(
    card: SettingCardId,
    patch?: {
      providers?: SettingProviderForm[];
      activeProviderId?: string;
      visionProviderId?: string | null;
      inlineCompletionProviderId?: string | null;
      imageGenProviders?: SettingImageGenForm[];
      activeImageGenProviderId?: string;
      objectStorage?: SettingObjectStorageForm | null;
      fullPermissionsDefault?: boolean;
      autoSkillSummarizeDefault?: boolean;
      composerInfinite?: boolean;
      reasoningEffort?: ReasoningEffort;
      contextLimitTokens?: number;
      compactTriggerRatio?: number;
      iterationProtectRawIterationCount?: number;
      iterationProtectTokenRatio?: number;
      maxModelIterations?: number;
      maxTurnTokens?: number;
      llmRequestTimeoutMs?: number;
      toolStatsEnabled?: boolean;
      environmentContext?: SettingFormState["environmentContext"];
      userMemoryAutoExtract?: boolean;
      projectMemoryAutoExtract?: boolean;
      themeId?: ThemeId;
      accentColor?: string;
      uiFontScale?: number;
      chatFontScale?: number;
    },
  ): Record<string, unknown> | null {
    switch (card) {
      case "coco": return null;
      case "providers": {
        const providers = this.mapProvidersForSave(
          patch?.providers ?? this.view.getProvidersDraft(),
        );
        let activeProviderId =
          patch?.activeProviderId ?? this.view.getActiveProviderId();
        if (!providers.some((p) => p.id === activeProviderId)) {
          activeProviderId = providers[0]?.id ?? "";
        }
        return { providers, activeProviderId };
      }
      case "vision": {
        const visionProviderId =
          patch && "visionProviderId" in patch
            ? patch.visionProviderId
            : this.view.getVisionSelectedId() || null;
        return { visionProviderId };
      }
      case "completion": {
        const inlineCompletionProviderId =
          patch && "inlineCompletionProviderId" in patch
            ? patch.inlineCompletionProviderId
            : this.view.getCompletionSelectedId() || null;
        return { inlineCompletionProviderId };
      }
      case "imagegen": {
        const imageGenProviders =
          patch && "imageGenProviders" in patch
            ? patch.imageGenProviders
            : this.view.getImageGenProvidersDraft();
        const activeId =
          patch?.activeImageGenProviderId ??
          this.view.getActiveImageGenProviderId();
        return {
          imageGenProviders: imageGenProviders.map((p) => ({
            id: p.id,
            name: p.name.trim() || "ImageGen",
            baseUrl: p.baseUrl,
            modelId: p.modelId,
            ...(p.rawEndpoint ? { rawEndpoint: true } : {}),
            ...(typeof p.watermark === "boolean"
              ? { watermark: p.watermark }
              : {}),
            ...(p.imageInput === "base64" || p.imageInput === "url"
              ? { imageInput: p.imageInput }
              : {}),
          })),
          activeImageGenProviderId: imageGenProviders.some(
            (p) => p.id === activeId,
          )
            ? activeId
            : (imageGenProviders[0]?.id ?? ""),
        };
      }
      case "objectstorage": {
        if (patch && "objectStorage" in patch) {
          return { objectStorage: patch.objectStorage ?? null };
        }
        const draft = this.view.getObjectStorageDraft();
        return {
          objectStorage: draft
            ? {
                provider: draft.provider,
                region: draft.region,
                bucket: draft.bucket,
                accessKeyId: draft.accessKeyId,
                ...(draft.endpoint ? { endpoint: draft.endpoint } : {}),
                ...(draft.keyPrefix ? { keyPrefix: draft.keyPrefix } : {}),
                urlMode: draft.urlMode,
                enabled: draft.enabled,
              }
            : null,
        };
      }
      case "permissions": {
        const composerValues = this.view.getComposerDefaultsValues();
        return {
          fullPermissionsDefault:
            patch?.fullPermissionsDefault ??
            this.view.getPermissionsValues().fullPermissionsDefault,
          autoSkillSummarizeDefault:
            patch?.autoSkillSummarizeDefault ??
            this.view.getPermissionsValues().autoSkillSummarizeDefault,
          composerInfinite:
            patch?.composerInfinite ?? composerValues.composerInfinite,
          reasoningEffort:
            patch?.reasoningEffort ?? composerValues.reasoningEffort,
        };
      }
      case "appearance": {
        const appearance = this.view.getAppearanceValues();
        return {
          themeId: patch?.themeId ?? appearance.themeId,
          accentColor: patch?.accentColor ?? appearance.accentColor,
          uiFontScale: patch?.uiFontScale ?? appearance.uiFontScale,
          chatFontScale: patch?.chatFontScale ?? appearance.chatFontScale,
        };
      }
      case "agent": {
        const agentValues = this.view.getAgentValues();
        return {
          contextLimitTokens:
            patch?.contextLimitTokens ?? agentValues.contextLimitTokens,
          compactTriggerRatio:
            patch?.compactTriggerRatio ?? agentValues.compactTriggerRatio,
          iterationProtectRawIterationCount:
            patch?.iterationProtectRawIterationCount ??
            agentValues.iterationProtectRawIterationCount,
          iterationProtectTokenRatio:
            patch?.iterationProtectTokenRatio ?? agentValues.iterationProtectTokenRatio,
          maxModelIterations: patch?.maxModelIterations ?? agentValues.maxModelIterations,
          maxTurnTokens: patch?.maxTurnTokens ?? agentValues.maxTurnTokens,
          llmRequestTimeoutMs:
            patch?.llmRequestTimeoutMs ?? agentValues.llmRequestTimeoutMs,
          toolStatsEnabled:
            patch?.toolStatsEnabled ?? agentValues.toolStatsEnabled,
          environmentContext:
            patch?.environmentContext ?? agentValues.environmentContext,
        };
      }
      case "user":
        return {
          userMemoryAutoExtract:
            patch?.userMemoryAutoExtract ??
            this.view.getMemoryValues().userMemoryAutoExtract,
        };
      case "safety":
        // Action-driven card — persists via the tools:setShellSafety IPC.
        return null;
      case "remote":
        // Action-driven card (Save & Connect IPC) — no autosave fields.
        return null;
      case "update":
        // Action-driven card (check / run IPC) — no autosave fields.
        return null;
      case "storage":
        return null;
      case "backup":
        // Action-driven card (export / import) — no autosave fields.
        return null;
    }
  }

  private applySaved(
    saved: Awaited<
      ReturnType<NonNullable<Window["jellybot"]>["saveWorkspaceSettings"]>
    >,
    card: SettingCardId,
    options: PersistOptions = {},
  ): void {
    const selectedStill = saved.providers.some(
      (p) => p.id === this.view.getSelectedProviderId(),
    )
      ? this.view.getSelectedProviderId()
      : saved.activeProviderId;
    const imageGenProviders = saved.imageGenProviders ?? [];
    const activeImageGenProviderId =
      saved.activeImageGenProviderId || imageGenProviders[0]?.id || "";
    this.current = {
      providers: saved.providers.map(toProviderForm),
      activeProviderId: saved.activeProviderId,
      selectedProviderId: selectedStill,
      apiKeyConfiguredByProviderId: {
        ...this.current.apiKeyConfiguredByProviderId,
      },
      visionProviderId: saved.visionProviderId ?? null,
      inlineCompletionProviderId: saved.inlineCompletionProviderId ?? null,
      imageGenProviders: imageGenProviders.map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        modelId: p.modelId,
        rawEndpoint: p.rawEndpoint === true,
        ...(typeof p.watermark === "boolean"
          ? { watermark: p.watermark }
          : {}),
        ...(p.imageInput === "base64" || p.imageInput === "url"
          ? { imageInput: p.imageInput }
          : {}),
      })),
      activeImageGenProviderId,
      selectedImageGenProviderId:
        imageGenProviders.some(
          (p) => p.id === this.view.getSelectedImageGenProviderId(),
        )
          ? this.view.getSelectedImageGenProviderId()
          : activeImageGenProviderId,
      imageGenApiKeyConfiguredByProviderId: {
        ...this.current.imageGenApiKeyConfiguredByProviderId,
      },
      objectStorage: saved.objectStorage
        ? {
            provider: saved.objectStorage.provider,
            region: saved.objectStorage.region,
            bucket: saved.objectStorage.bucket,
            accessKeyId: saved.objectStorage.accessKeyId,
            endpoint: saved.objectStorage.endpoint ?? "",
            keyPrefix: saved.objectStorage.keyPrefix ?? "",
            urlMode:
              saved.objectStorage.urlMode === "public"
                ? "public"
                : "presigned",
            enabled: saved.objectStorage.enabled !== false,
          }
        : null,
      objectStorageSecretConfigured: this.current.objectStorageSecretConfigured,
      fullPermissionsDefault: saved.fullPermissionsDefault,
      autoSkillSummarizeDefault: saved.autoSkillSummarizeDefault,
      composerInfinite: saved.composerInfinite,
      reasoningEffort: saved.reasoningEffort ?? "low",
      contextLimitTokens: saved.contextLimitTokens,
      compactTriggerRatio: saved.compactTriggerRatio,
      iterationProtectRawIterationCount: saved.iterationProtectRawIterationCount,
      iterationProtectTokenRatio: saved.iterationProtectTokenRatio,
      maxModelIterations: saved.maxModelIterations,
      maxTurnTokens: saved.maxTurnTokens,
      llmRequestTimeoutMs: saved.llmRequestTimeoutMs,
      toolStatsEnabled: saved.toolStatsEnabled,
      environmentContext: {
        workspace: saved.environmentContext.workspace,
        timezone: saved.environmentContext.timezone,
        locale: saved.environmentContext.locale,
        location: saved.environmentContext.location,
        repository: saved.environmentContext.repository !== false,
      },
      userMemoryAutoExtract: saved.userMemoryAutoExtract,
      userMemoryProfile: this.current.userMemoryProfile,
      userMemoryUpdatedAt: this.current.userMemoryUpdatedAt,
      themeId: saved.themeId,
      accentColor: saved.accentColor ?? "auto",
      uiFontScale: saved.uiFontScale ?? 1,
      chatFontScale: saved.chatFontScale ?? 1,
    };
    this.projectMemoryAutoExtract = saved.projectMemoryAutoExtract !== false;
    if (options.refreshForm) {
      this.view.setForm(this.current);
    } else if (card === "providers") {
      this.view.refreshProviderList();
    } else if (card === "imagegen") {
      this.view.syncImageGenState(
        this.current.imageGenProviders,
        this.current.activeImageGenProviderId,
        this.current.selectedImageGenProviderId,
      );
    }
    this.view.setCardStatus(card, "Saved", "ok");
    if (card === "providers") {
      setProvidersState({
        providers: this.current.providers,
        activeProviderId: this.current.activeProviderId,
      });
    }
  }

  private async persistWorkspace(
    card: SettingCardId,
    patch?: Parameters<SettingController["buildCardPatch"]>[1],
    options: PersistOptions = {},
  ): Promise<boolean> {
    const quiet = options.quiet === true;
    const reportValidation = options.reportValidation !== false;
    if (!this.hydrated) {
      // Autosave raced ahead of snapshot load — skip so we never persist
      // the placeholder DEFAULT_FORM providers.
      return false;
    }
    const bridge = requireBridge();
    if (typeof bridge.saveWorkspaceSettings !== "function") {
      this.view.setCardStatus(
        card,
        "Restart the app to enable saving settings (preload outdated)",
        "error",
      );
      return false;
    }

    const next = this.buildCardPatch(card, patch);
    if (!next) return false;

    if (card === "providers") {
      const providers = next.providers as Array<{
        name: string;
        baseUrl: string;
        modelId: string;
      }>;
      if (!Array.isArray(providers) || providers.length === 0) {
        if (reportValidation) {
          this.view.setCardStatus(card, "Keep at least one provider", "error");
        }
        return false;
      }
      for (const p of providers) {
        if (!p.name.trim() || !p.baseUrl.trim() || !p.modelId.trim()) {
          if (reportValidation) {
            this.view.setCardStatus(
              card,
              "Each provider needs name, base URL, and model ID",
              "error",
            );
          }
          return false;
        }
      }
    }
    if (card === "imagegen") {
      const providers = next.imageGenProviders as Array<{
        name?: string;
        baseUrl?: string;
        modelId?: string;
      }>;
      for (const imageGen of providers ?? []) {
        if (
          !imageGen.name?.trim() ||
          !imageGen.baseUrl?.trim() ||
          !imageGen.modelId?.trim()
        ) {
        if (reportValidation) {
          this.view.setCardStatus(
            card,
            "Each image profile needs name, base URL, and model ID",
            "error",
          );
        }
        return false;
        }
      }
    }

    if (!quiet) this.view.setBusy(card);
    this.view.setCardStatus(card, null);
    try {
      const saved = await bridge.saveWorkspaceSettings(
        next as Parameters<
          NonNullable<Window["jellybot"]>["saveWorkspaceSettings"]
        >[0],
      );
      try {
        const snap = await bridge.getSettingsSnapshot();
        this.current.apiKeyConfiguredByProviderId = {
          ...snap.apiKeyConfiguredByProviderId,
        };
        for (const provider of saved.imageGenProviders ?? []) {
          this.current.imageGenApiKeyConfiguredByProviderId[provider.id] =
            snap.apiKeyConfiguredByProviderId[provider.id] === true;
        }
      } catch {
        // keep local flags
      }
      this.applySaved(saved, card, options);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.setCardStatus(card, message, "error");
      return false;
    } finally {
      if (!quiet) this.view.setBusy(null);
    }
  }

  private async saveProviders(): Promise<void> {
    if (!this.view.validateResponsesTools()) {
      this.view.setCardStatus("providers", this.view.responsesToolsInput.validationMessage, "error");
      return;
    }
    await this.persistWorkspace(
      "providers",
      {
        providers: this.view.getProvidersDraft(),
        activeProviderId: this.view.getActiveProviderId(),
      },
      { quiet: true, reportValidation: false },
    );
  }

  private async saveVision(): Promise<void> {
    const visionProviderId = this.view.getVisionSelectedId() || null;
    this.current.visionProviderId = visionProviderId;
    await this.persistWorkspace(
      "vision",
      { visionProviderId },
      { quiet: true, reportValidation: false },
    );
  }

  private async saveCompletion(): Promise<void> {
    const inlineCompletionProviderId =
      this.view.getCompletionSelectedId() || null;
    this.current.inlineCompletionProviderId = inlineCompletionProviderId;
    await this.persistWorkspace(
      "completion",
      { inlineCompletionProviderId },
      { quiet: true, reportValidation: false },
    );
  }

  private async saveImageGen(): Promise<void> {
    const drafts = this.view.getImageGenProvidersDraft();
    // An empty list is valid (feature disabled); a partially typed profile
    // would be dropped by main-side normalization, so block the save.
    for (const draft of drafts) {
      if (!draft.baseUrl.trim() || !draft.modelId.trim()) {
        this.view.setCardStatus(
          "imagegen",
          "Each image profile needs a base URL and model ID",
          "error",
        );
        return;
      }
    }
    this.current.imageGenProviders = drafts;
    await this.persistWorkspace(
      "imagegen",
      {
        imageGenProviders: drafts,
        activeImageGenProviderId: this.view.getActiveImageGenProviderId(),
      },
      { quiet: true, reportValidation: false },
    );
  }

  private addImageGenProvider(): void {
    const drafts = this.view.getImageGenProvidersDraft();
    const id = newLocalId();
    drafts.push({
      id,
      name: `ImageGen ${drafts.length + 1}`,
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      modelId: "cogview-4-250304",
      rawEndpoint: false,
    });
    this.view.setImageGenProvidersLocal(
      drafts,
      id,
      this.view.getActiveImageGenProviderId() || id,
    );
    this.enqueuePersist(() => this.saveImageGen());
  }

  private deleteSelectedImageGenProvider(): void {
    const selectedId = this.view.getSelectedImageGenProviderId();
    if (!selectedId) return;
    this.cancelCardSave("imagegen");
    const drafts = this.view
      .getImageGenProvidersDraft()
      .filter((p) => p.id !== selectedId);
    let activeId = this.view.getActiveImageGenProviderId();
    if (activeId === selectedId) {
      activeId = drafts[0]?.id ?? "";
    }
    this.view.setImageGenProvidersLocal(
      drafts,
      drafts[0]?.id ?? "",
      activeId,
    );
    this.enqueuePersist(() => this.saveImageGen());
  }

  /** Switch the profile generate_image resolves; effective on the next turn. */
  private async setActiveImageGenProvider(): Promise<void> {
    const providerId = this.view.getSelectedImageGenProviderId();
    if (!providerId) return;
    if (providerId === this.view.getActiveImageGenProviderId()) return;
    const drafts = this.view.getImageGenProvidersDraft();
    if (!drafts.some((p) => p.id === providerId)) return;
    const ok = await this.persistWorkspace(
      "imagegen",
      {
        imageGenProviders: drafts,
        activeImageGenProviderId: providerId,
      },
      { quiet: true },
    );
    if (ok) {
      this.view.setCardStatus("imagegen", "Active profile updated", "ok");
    }
  }

  private bindObjectStorageAutoSave(): void {
    const schedule = (): void => {
      this.scheduleCardSave("objectstorage", () => this.saveObjectStorage());
    };
    for (const el of [
      this.view.objectStorageRegionInput,
      this.view.objectStorageBucketInput,
      this.view.objectStorageAccessKeyIdInput,
      this.view.objectStorageEndpointInput,
      this.view.objectStorageKeyPrefixInput,
    ]) {
      el.addEventListener("input", schedule);
    }
    this.view.objectStorageProviderSelect.addEventListener("change", schedule);
    this.view.objectStorageUrlModeSelect.addEventListener("change", schedule);
    this.view.objectStorageEnabledToggle.addEventListener("change", schedule);
    this.view.objectStorageSecretInput.addEventListener("blur", () => {
      if (this.view.getObjectStorageSecretDraft().trim()) {
        this.enqueuePersist(() => this.saveObjectStorageSecret());
      }
    });
    this.view.objectStorageSecretInput.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          (event.target as HTMLInputElement).blur();
        }
      },
    );
  }

  /** Map the form draft to a settings.json objectStorage patch payload. */
  private toObjectStoragePayload(
    draft: SettingObjectStorageForm,
  ): ObjectStorageConfig {
    return {
      provider: draft.provider,
      region: draft.region,
      bucket: draft.bucket,
      accessKeyId: draft.accessKeyId,
      ...(draft.endpoint ? { endpoint: draft.endpoint } : {}),
      ...(draft.keyPrefix ? { keyPrefix: draft.keyPrefix } : {}),
      urlMode: draft.urlMode,
      enabled: draft.enabled,
    };
  }

  private async saveObjectStorage(): Promise<void> {
    const draft = this.view.getObjectStorageDraft();
    if (!draft) {
      // Distinguish "user wiped the form" (persist null) from an incomplete
      // draft (never silently skip — the old code made typed fields vanish
      // on reopen with zero feedback).
      const wiped =
        !this.view.objectStorageRegionInput.value.trim() &&
        !this.view.objectStorageBucketInput.value.trim() &&
        !this.view.objectStorageAccessKeyIdInput.value.trim();
      if (wiped) {
        await this.persistWorkspace(
          "objectstorage",
          { objectStorage: null },
          { quiet: true, reportValidation: false },
        );
        return;
      }
      this.view.setCardStatus(
        "objectstorage",
        "Region, Bucket, and Access Key ID are all required before the config is saved",
        "error",
      );
      return;
    }
    await this.persistWorkspace(
      "objectstorage",
      { objectStorage: draft },
      { quiet: true, reportValidation: false },
    );
    this.view.setCardStatus("objectstorage", null);
  }

  private async clearObjectStorage(): Promise<void> {
    this.cancelCardSave("objectstorage");
    const ok = await this.persistWorkspace(
      "objectstorage",
      { objectStorage: null },
      { quiet: true },
    );
    if (ok) {
      this.view.fillObjectStorageDetail(null);
    }
  }

  private async saveObjectStorageSecret(): Promise<void> {
    const draft = this.view.getObjectStorageSecretDraft().trim();
    if (!draft) return;
    const bridge = requireBridge();
    if (typeof bridge.setApiKey !== "function") {
      this.view.setCardStatus(
        "objectstorage",
        "Restart the app to enable Secret save (preload outdated)",
        "error",
      );
      return;
    }
    this.view.setBusy("objectstorage");
    this.view.setCardStatus("objectstorage", null);
    try {
      const result = await bridge.setApiKey({
        providerId: OBJECT_STORAGE_CREDENTIAL_ID,
        apiKey: draft,
      });
      this.current.objectStorageSecretConfigured = result.apiKeyConfigured;
      this.view.clearObjectStorageSecretDraft();
      this.view.setObjectStorageSecretConfigured(result.apiKeyConfigured);
      if (!this.view.getObjectStorageDraft()) {
        // The secret lives in the encrypted store, but the non-secret config
        // (region/bucket/accessKeyId) is a separate autosave — call it out so
        // the user does not assume everything is stored.
        this.view.setCardStatus(
          "objectstorage",
          "Secret saved, but Region / Bucket / Access Key ID are still required to save the config",
          "error",
        );
      } else {
        this.view.setCardStatus(
          "objectstorage",
          "Secret key saved securely",
          "ok",
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.setCardStatus("objectstorage", message, "error");
    } finally {
      this.view.setBusy(null);
    }
  }

  private async clearObjectStorageSecret(): Promise<void> {
    const bridge = requireBridge();
    this.view.setBusy("objectstorage");
    this.view.setCardStatus("objectstorage", null);
    try {
      const result = await bridge.setApiKey({
        providerId: OBJECT_STORAGE_CREDENTIAL_ID,
        clear: true,
      });
      this.current.objectStorageSecretConfigured = result.apiKeyConfigured;
      this.view.clearObjectStorageSecretDraft();
      this.view.setObjectStorageSecretConfigured(result.apiKeyConfigured);
      this.view.setCardStatus("objectstorage", "Secret key removed", "ok");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.setCardStatus("objectstorage", message, "error");
    } finally {
      this.view.setBusy(null);
    }
  }

  private async testObjectStorage(): Promise<void> {
    const bridge = requireBridge();
    if (typeof bridge.testObjectStorage !== "function") {
      this.view.setCardStatus(
        "objectstorage",
        "Restart the app to enable Test connection (preload outdated)",
        "error",
      );
      return;
    }
    // Save the current draft first so the probe tests what is on screen
    // (falls back to the last saved config when the draft is incomplete).
    const draft = this.view.getObjectStorageDraft();
    if (draft) {
      await this.persistWorkspace(
        "objectstorage",
        { objectStorage: draft },
        { quiet: true, reportValidation: false },
      );
    }
    this.view.setBusy("objectstorage");
    this.view.setCardStatus("objectstorage", "Testing connection…", "info");
    try {
      const result = await bridge.testObjectStorage(
        draft ? { objectStorage: this.toObjectStoragePayload(draft) } : undefined,
      );
      if (result.ok) {
        this.view.setCardStatus("objectstorage", result.message, "ok");
      } else {
        this.view.setCardStatus("objectstorage", result.message, "error");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.setCardStatus("objectstorage", message, "error");
    } finally {
      this.view.setBusy(null);
    }
  }

  private async exportBackup(): Promise<void> {
    const bridge = requireBridge();
    if (typeof bridge.exportSettingsBackup !== "function") {
      this.view.setCardStatus(
        "backup",
        "Restart the app to enable backup export (preload outdated)",
        "error",
      );
      return;
    }
    const passphrase = await showTextPromptDialog({
      title: "Export backup",
      message:
        "Encrypts providers, API keys, tools & MCP servers, CoCo settings, skills, user memory, and FSM graphs into one file. Keep the passphrase safe — it cannot be recovered.",
      password: true,
      confirm: true,
      confirmLabel: "Export…",
      validate: (value) =>
        value.length < 6 ? "Passphrase must be at least 6 characters" : null,
    });
    if (!passphrase) {
      return; // canceled — stay quiet
    }
    this.view.setBusy("backup");
    this.view.setCardStatus("backup", null);
    this.view.setBackupWorking(true);
    try {
      const result = await bridge.exportSettingsBackup(passphrase);
      if (result.ok) {
        this.view.setCardStatus(
          "backup",
          `Backup exported to ${result.path ?? ""}`,
          "ok",
        );
      } else if (result.canceled) {
        this.view.setCardStatus("backup", null);
      } else {
        this.view.setCardStatus(
          "backup",
          result.error ?? "Export failed",
          "error",
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.setCardStatus("backup", message, "error");
    } finally {
      this.view.setBackupWorking(false);
      this.view.setBusy(null);
    }
  }

  private async chooseBackupFile(): Promise<void> {
    const bridge = requireBridge();
    if (typeof bridge.importBackupSummary !== "function") {
      this.view.setCardStatus(
        "backup",
        "Restart the app to enable backup import (preload outdated)",
        "error",
      );
      return;
    }
    this.view.setBusy("backup");
    try {
      const result = await bridge.importBackupSummary();
      if (result.ok && result.path) {
        this.view.setBackupSummary({
          path: result.path,
          sections: result.sections ?? [],
          exportedAt: result.exportedAt ?? "",
          appVersion: result.appVersion ?? "",
        });
      } else if (!result.canceled) {
        this.view.setBackupSummary(null);
        this.view.setCardStatus(
          "backup",
          result.error ?? "Could not read backup file",
          "error",
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.setCardStatus("backup", message, "error");
    } finally {
      this.view.setBusy(null);
    }
  }

  private async applyBackup(): Promise<void> {
    const bridge = requireBridge();
    if (typeof bridge.applySettingsBackup !== "function") {
      this.view.setCardStatus(
        "backup",
        "Restart the app to enable backup import (preload outdated)",
        "error",
      );
      return;
    }
    const path = this.view.getBackupImportPath();
    if (!path) {
      this.view.setCardStatus("backup", "Choose a backup file first", "error");
      return;
    }
    const passphrase = await showTextPromptDialog({
      title: "Apply backup",
      message:
        "This replaces the current settings; existing files are backed up first. Restart the app afterwards to reconnect MCP servers.",
      password: true,
      confirmLabel: "Apply",
      validate: (value) => (value ? null : "Enter the passphrase"),
    });
    if (!passphrase) {
      return; // canceled — stay quiet
    }
    this.view.setBusy("backup");
    this.view.setCardStatus("backup", null);
    this.view.setBackupWorking(true);
    try {
      const result = await bridge.applySettingsBackup(path, passphrase);
      if (result.ok) {
        const notes = [
          `Backup applied (${result.applied?.length ?? 0} sections). Restart the app to reconnect MCP servers.`,
        ];
        if (result.warnings?.length) {
          notes.push(result.warnings.join("; "));
        }
        this.view.setCardStatus("backup", notes.join(" "), "ok");
        // Re-hydrate the whole form from the replaced settings + re-theme.
        await this.refresh();
        const appearance = this.view.getAppearanceValues();
        applyTheme(
          appearance.themeId,
          appearance.accentColor === "auto" ? null : appearance.accentColor,
        );
        applyFontScales({
          ui: appearance.uiFontScale,
          chat: appearance.chatFontScale,
        });
        this.view.accentPicker.refresh();
      } else {
        this.view.setCardStatus(
          "backup",
          result.error ?? "Import failed",
          "error",
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.setCardStatus("backup", message, "error");
    } finally {
      this.view.setBackupWorking(false);
      this.view.setBusy(null);
    }
  }

  private async saveApiKey(): Promise<void> {
    const providerId = this.view.getSelectedProviderId();
    const draft = this.view.getApiKeyDraft().trim();
    if (!providerId) {
      this.view.setCardStatus("providers", "Select a provider first", "error");
      return;
    }
    if (!draft) {
      return;
    }
    const bridge = requireBridge();
    if (typeof bridge.setApiKey !== "function") {
      this.view.setCardStatus(
        "providers",
        "Restart the app to enable API key save (preload outdated)",
        "error",
      );
      return;
    }
    this.view.setBusy("providers");
    this.view.setCardStatus("providers", null);
    try {
      const result = await bridge.setApiKey({ providerId, apiKey: draft });
      this.current.apiKeyConfiguredByProviderId[providerId] =
        result.apiKeyConfigured;
      this.view.clearApiKeyDraft();
      this.view.setApiKeyConfigured(result.apiKeyConfigured);
      this.view.setCardStatus("providers", "API key saved securely", "ok");
      setProvidersState(getProvidersState());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.setCardStatus("providers", message, "error");
    } finally {
      this.view.setBusy(null);
    }
  }

  private async clearApiKey(): Promise<void> {
    const providerId = this.view.getSelectedProviderId();
    if (!providerId) return;
    const bridge = requireBridge();
    if (typeof bridge.setApiKey !== "function") {
      this.view.setCardStatus(
        "providers",
        "Restart the app to enable API key clear (preload outdated)",
        "error",
      );
      return;
    }
    this.view.setBusy("providers");
    this.view.setCardStatus("providers", null);
    try {
      const result = await bridge.setApiKey({ providerId, clear: true });
      this.current.apiKeyConfiguredByProviderId[providerId] =
        result.apiKeyConfigured;
      this.view.clearApiKeyDraft();
      this.view.setApiKeyConfigured(result.apiKeyConfigured);
      this.view.setCardStatus(
        "providers",
        "API key removed",
        "ok",
      );
      setProvidersState(getProvidersState());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.setCardStatus("providers", message, "error");
    } finally {
      this.view.setBusy(null);
    }
  }

  private async saveImageGenApiKey(): Promise<void> {
    const draft = this.view.getImageGenApiKeyDraft().trim();
    if (!draft) {
      return;
    }
    const providerId = this.view.getSelectedImageGenProviderId();
    if (!providerId) {
      this.view.setCardStatus(
        "imagegen",
        "Select an image profile first",
        "error",
      );
      return;
    }
    const bridge = requireBridge();
    if (typeof bridge.setApiKey !== "function") {
      this.view.setCardStatus(
        "imagegen",
        "Restart the app to enable API key save (preload outdated)",
        "error",
      );
      return;
    }
    this.view.setBusy("imagegen");
    this.view.setCardStatus("imagegen", null);
    try {
      const result = await bridge.setApiKey({
        providerId,
        apiKey: draft,
      });
      this.current.imageGenApiKeyConfiguredByProviderId[providerId] =
        result.apiKeyConfigured;
      this.view.clearImageGenApiKeyDraft();
      this.view.setImageGenApiKeyConfigured(
        providerId,
        result.apiKeyConfigured,
      );
      this.view.setCardStatus("imagegen", "API key saved securely", "ok");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.setCardStatus("imagegen", message, "error");
    } finally {
      this.view.setBusy(null);
    }
  }

  private async clearImageGenApiKey(): Promise<void> {
    const providerId = this.view.getSelectedImageGenProviderId();
    if (!providerId) return;
    const bridge = requireBridge();
    if (typeof bridge.setApiKey !== "function") {
      this.view.setCardStatus(
        "imagegen",
        "Restart the app to enable API key clear (preload outdated)",
        "error",
      );
      return;
    }
    this.view.setBusy("imagegen");
    this.view.setCardStatus("imagegen", null);
    try {
      const result = await bridge.setApiKey({
        providerId,
        clear: true,
      });
      this.current.imageGenApiKeyConfiguredByProviderId[providerId] =
        result.apiKeyConfigured;
      this.view.clearImageGenApiKeyDraft();
      this.view.setImageGenApiKeyConfigured(
        providerId,
        result.apiKeyConfigured,
      );
      this.view.setCardStatus(
        "imagegen",
        "API key removed",
        "ok",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.setCardStatus("imagegen", message, "error");
    } finally {
      this.view.setBusy(null);
    }
  }

  private async savePermissions(): Promise<void> {
    const { fullPermissionsDefault, autoSkillSummarizeDefault } =
      this.view.getPermissionsValues();
    const composer = this.view.getComposerDefaultsValues();
    await this.persistWorkspace(
      "permissions",
      {
        fullPermissionsDefault,
        autoSkillSummarizeDefault,
        composerInfinite: composer.composerInfinite,
        reasoningEffort: composer.reasoningEffort,
      },
      { quiet: true },
    );
  }

  /**
   * Composer defaults (settings.json) — one card with Bypass permissions,
   * so this saves all three fields. These seed the draft on app start;
   * conversations keep their own per-session values. Also re-seed the
   * live process defaults so this session's New Task composer follows
   * immediately.
   */
  private async saveComposerDefaults(): Promise<void> {
    const values = this.view.getComposerDefaultsValues();
    const { fullPermissionsDefault, autoSkillSummarizeDefault } =
      this.view.getPermissionsValues();
    const ok = await this.persistWorkspace(
      "permissions",
      {
        fullPermissionsDefault,
        autoSkillSummarizeDefault,
        composerInfinite: values.composerInfinite,
        reasoningEffort: values.reasoningEffort,
      },
      { quiet: true },
    );
    if (ok) {
      seedComposerPrefsDefaults({
        infinite: values.composerInfinite,
        reasoningEffort: values.reasoningEffort,
      });
    }
  }

  private async saveAppearance(): Promise<void> {
    const { themeId, accentColor, uiFontScale, chatFontScale } =
      this.view.getAppearanceValues();
    const ok = await this.persistWorkspace(
      "appearance",
      { themeId, accentColor, uiFontScale, chatFontScale },
      { quiet: true },
    );
    if (!ok) {
      // Roll the preview back to the persisted theme/scales on save failure.
      applyTheme(
        getTheme(this.current.themeId).id,
        this.current.accentColor === "auto" ? null : this.current.accentColor,
      );
      applyFontScales({
        ui: this.current.uiFontScale,
        chat: this.current.chatFontScale,
      });
      this.view.setForm(this.current);
      this.view.accentPicker.refresh();
    }
  }

  private async saveAgent(): Promise<void> {
    const {
      contextLimitTokens,
      compactTriggerRatio,
      iterationProtectRawIterationCount,
      iterationProtectTokenRatio,
      maxModelIterations,
      maxTurnTokens,
      llmRequestTimeoutMs,
      toolStatsEnabled,
      environmentContext,
    } = this.view.getAgentValues();
    if (!Number.isFinite(contextLimitTokens) || contextLimitTokens < 1024) {
      return;
    }
    if (
      !Number.isFinite(iterationProtectRawIterationCount) ||
      iterationProtectRawIterationCount < 1
    ) {
      return;
    }
    if (
      !Number.isFinite(iterationProtectTokenRatio) ||
      iterationProtectTokenRatio <= 0 ||
      iterationProtectTokenRatio > 0.9
    ) {
      return;
    }
    if (
      !Number.isFinite(compactTriggerRatio) ||
      compactTriggerRatio < 0.5 ||
      compactTriggerRatio > 0.95
    ) {
      return;
    }
    if (!Number.isFinite(maxModelIterations) || maxModelIterations < 1) {
      return;
    }
    if (!Number.isFinite(maxTurnTokens) || maxTurnTokens < 1) {
      return;
    }
    if (
      !Number.isFinite(llmRequestTimeoutMs) ||
      llmRequestTimeoutMs < 1_000 ||
      llmRequestTimeoutMs > 600_000
    ) {
      return;
    }
    await this.persistWorkspace(
      "agent",
      {
        contextLimitTokens: Math.floor(contextLimitTokens),
        compactTriggerRatio,
        iterationProtectRawIterationCount: Math.floor(iterationProtectRawIterationCount),
        iterationProtectTokenRatio,
        maxModelIterations: Math.floor(maxModelIterations),
        maxTurnTokens: Math.floor(maxTurnTokens),
        llmRequestTimeoutMs: Math.round(llmRequestTimeoutMs),
        toolStatsEnabled,
        environmentContext,
      },
      { quiet: true },
    );
  }

  private async saveMemory(options: PersistOptions = {}): Promise<void> {
    const bridge = requireBridge();
    const values = this.view.getMemoryValues();
    const autoOk = await this.persistWorkspace(
      "user",
      {
        userMemoryAutoExtract: values.userMemoryAutoExtract,
      },
      { quiet: true, ...options },
    );
    if (!autoOk) return;

    if (typeof bridge.saveUserMemory !== "function") {
      this.view.setCardStatus(
        "user",
        "Restart the app to enable saving memory (preload outdated)",
        "error",
      );
      return;
    }

    try {
      const saved = await bridge.saveUserMemory({
        profile: values.userMemoryProfile,
      });
      this.current.userMemoryProfile = saved.profile;
      this.current.userMemoryUpdatedAt = saved.updatedAt;
      this.current.userMemoryAutoExtract = values.userMemoryAutoExtract;
      this.view.setCardStatus("user", "Saved", "ok");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.setCardStatus("user", message, "error");
    }
  }

  private async refreshStorageUsage(): Promise<void> {
    const bridge = requireBridge();
    try {
      if (typeof bridge.getStorageUsage !== "function") return;
      const usage = await bridge.getStorageUsage();
      this.view.setStorageUsage(usage);
    } catch {
      this.view.setStorageUsage(null);
    }
  }

  private async cleanupStorage(): Promise<void> {
    const bridge = requireBridge();
    this.view.setBusy("storage");
    this.view.setCardStatus("storage", null);
    try {
      if (
        typeof bridge.getStorageUsage !== "function" ||
        typeof bridge.cleanupStorage !== "function"
      ) {
        this.view.setCardStatus(
          "storage",
          "Restart the app to enable cleanup (preload outdated)",
          "error",
        );
        return;
      }
      const usage = await bridge.getStorageUsage();
      if (usage.totalBytes <= 0) {
        this.view.setCardStatus("storage", "Nothing to clean", "info");
        return;
      }
      const confirmed = await bridge.confirmDialog({
        title: "Clean up storage",
        message: `Delete ${formatBytes(usage.totalBytes)} of logs, caches, backups, and temp files?`,
        detail: [
          `Logs (older than 7 days): ${formatBytes(usage.logs.bytes)}`,
          `Chromium caches: ${formatBytes(usage.caches.bytes)}`,
          `Task backups: ${formatBytes(usage.backup.bytes)}`,
          `Temp leftovers: ${formatBytes(usage.tmp.bytes)}`,
          "",
          "Tasks, settings, skills, and memory are kept.",
        ].join("\n"),
      });
      if (!confirmed) return;

      const result = await bridge.cleanupStorage();
      this.view.setStorageUsage(await bridge.getStorageUsage());
      this.view.setCardStatus(
        "storage",
        `Freed ${formatBytes(result.freedBytes)}`,
        "ok",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.setCardStatus("storage", message, "error");
    } finally {
      this.view.setBusy(null);
    }
  }

  private async clearMemory(): Promise<void> {
    const bridge = requireBridge();
    const confirmed = await bridge.confirmDialog({
      title: "Clear USER.md",
      message: "Clear the durable user profile?",
      detail: "This cannot be undone. Auto-extract settings are kept.",
    });
    if (!confirmed) return;

    this.cancelCardSave("user");
    this.view.setBusy("user");
    this.view.setCardStatus("user", null);
    try {
      if (typeof bridge.clearUserMemory !== "function") {
        this.view.setCardStatus(
          "user",
          "Restart the app to enable clearing memory (preload outdated)",
          "error",
        );
        return;
      }
      const cleared = await bridge.clearUserMemory();
      this.current.userMemoryProfile = cleared.profile;
      this.current.userMemoryUpdatedAt = cleared.updatedAt;
      this.view.setUserMemoryProfile(cleared.profile);
      this.view.setCardStatus("user", "Cleared", "ok");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.setCardStatus("user", message, "error");
    } finally {
      this.view.setBusy(null);
    }
  }

}
