import {
  DEFAULT_JEV_BASE_URL,
  DEFAULT_JEV_MODEL_ID,
  DEFAULT_JEV_PROVIDER_NAME,
  JEV_PROVIDER_ID,
} from "../../../../shared/jevDefaults.js";
import type { JevModelForm, JevModelSettingsView } from "./JevModelSettingsView.js";

const SAVE_DEBOUNCE_MS = 500;

type JevBridge = Pick<
  NonNullable<Window["jellybot"]>,
  "getSettingsSnapshot" | "saveWorkspaceSettings" | "setApiKey" | "testJevModel"
>;

export class JevModelSettingsController {
  private profile: JevModelForm | null = null;
  private keyConfigured = false;
  private busy = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly view: JevModelSettingsView,
    private readonly bridge: () => JevBridge | undefined = () => window.jellybot,
  ) {
    view.addButton.addEventListener("click", () => this.add());
    view.deleteButton.addEventListener("click", () => this.remove());
    view.clearKeyButton.addEventListener("click", () => this.clearKey());
    view.testButton.addEventListener("click", () => this.test());
    view.onFieldsChange(() => this.scheduleSave());
    view.onApiKeyCommit(() => {
      if (view.hasApiKeyDraft()) this.enqueue(() => this.saveKey());
    });
    this.render();
  }

  async refresh(): Promise<void> {
    const bridge = this.bridge();
    if (!bridge) return;
    try {
      const snapshot = await bridge.getSettingsSnapshot();
      if (this.disposed) return;
      const saved = snapshot.settings.jevProvider;
      this.profile = saved ? { name: saved.name, baseUrl: saved.baseUrl, modelId: saved.modelId } : null;
      this.keyConfigured = snapshot.apiKeyConfiguredByProviderId[JEV_PROVIDER_ID] === true;
      this.render();
    } catch (error) {
      if (!this.disposed) this.view.setStatus(this.message(error), "error");
    }
  }

  currentModel(): { baseUrl: string; modelId: string } | null {
    return this.profile ? { baseUrl: this.profile.baseUrl, modelId: this.profile.modelId } : null;
  }

  applyDetected(input: { name: string; baseUrl: string; modelId: string; apiKey: string }): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const replaced = this.profile && this.profile.modelId !== input.modelId ? this.profile.modelId : null;
    this.profile = { name: input.name, baseUrl: input.baseUrl, modelId: input.modelId };
    this.render();
    this.enqueue(async () => {
      await this.persist();
      const bridge = this.bridge();
      if (bridge && input.apiKey.trim()) {
        const result = await bridge.setApiKey({ providerId: JEV_PROVIDER_ID, apiKey: input.apiKey.trim() });
        this.keyConfigured = result.apiKeyConfigured;
      }
      this.view.setStatus(
        replaced ? `Decision model set to ${input.modelId} (replaced ${replaced}).` : `Decision model set to ${input.modelId}.`,
        "ok",
      );
    });
  }

  destroy(): void {
    this.disposed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  private render(): void {
    this.view.render({ profile: this.profile, keyConfigured: this.keyConfigured, busy: this.busy });
  }

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(async () => {
      if (this.disposed) return;
      this.busy = true;
      this.render();
      try {
        await task();
      } catch (error) {
        if (!this.disposed) this.view.setStatus(this.message(error), "error");
      } finally {
        this.busy = false;
        if (!this.disposed) this.render();
      }
    });
  }

  private add(): void {
    if (this.profile) return;
    this.profile = { name: DEFAULT_JEV_PROVIDER_NAME, baseUrl: DEFAULT_JEV_BASE_URL, modelId: DEFAULT_JEV_MODEL_ID };
    this.view.setStatus(null);
    this.render();
    this.enqueue(() => this.persist());
    this.view.apiKeyInput.focus();
  }

  private scheduleSave(): void {
    if (!this.profile) return;
    this.profile = this.view.readForm();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.enqueue(() => this.persist());
    }, SAVE_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    const bridge = this.bridge();
    if (!bridge || !this.profile) return;
    const baseUrl = this.profile.baseUrl.trim();
    const modelId = this.profile.modelId.trim();
    if (!baseUrl || !modelId) {
      this.view.setStatus("Base URL and model ID are required.", "error");
      return;
    }
    const saved = await bridge.saveWorkspaceSettings({
      jevProvider: {
        id: JEV_PROVIDER_ID,
        name: this.profile.name.trim() || DEFAULT_JEV_PROVIDER_NAME,
        baseUrl,
        modelId,
      },
    });
    if (this.disposed) return;
    const next = saved.jevProvider;
    if (next && !this.saveTimer) this.profile = { name: next.name, baseUrl: next.baseUrl, modelId: next.modelId };
    this.view.setStatus("Saved", "ok");
  }

  private async saveKey(): Promise<void> {
    const bridge = this.bridge();
    const draft = this.view.takeApiKeyDraft();
    if (!bridge || !draft) return;
    const result = await bridge.setApiKey({ providerId: JEV_PROVIDER_ID, apiKey: draft });
    this.keyConfigured = result.apiKeyConfigured;
    this.view.setStatus("API key saved", "ok");
  }

  private clearKey(): void {
    this.enqueue(async () => {
      const bridge = this.bridge();
      if (!bridge) return;
      const result = await bridge.setApiKey({ providerId: JEV_PROVIDER_ID, clear: true });
      this.keyConfigured = result.apiKeyConfigured;
      this.view.setStatus("API key cleared", "info");
    });
  }

  private remove(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.enqueue(async () => {
      const bridge = this.bridge();
      if (!bridge) return;
      await bridge.saveWorkspaceSettings({ jevProvider: null });
      const result = await bridge.setApiKey({ providerId: JEV_PROVIDER_ID, clear: true });
      this.profile = null;
      this.keyConfigured = result.apiKeyConfigured;
      this.view.setStatus("Decision model removed. Computer Use is back to the default path.", "info");
    });
  }

  private test(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.enqueue(() => this.persist());
    }
    this.enqueue(async () => {
      const bridge = this.bridge();
      if (!bridge) return;
      this.view.setStatus("Testing…", "info");
      const result = await bridge.testJevModel();
      this.view.setStatus(result.message, result.ok ? "ok" : "error");
    });
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
