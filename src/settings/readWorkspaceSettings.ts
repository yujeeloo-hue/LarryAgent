import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  WORKSPACE_SETTINGS_FILE,
  IMAGEGEN_PROVIDER_ID,
  createDefaultProvider,
  normalizeRemoteRelaySettings,
  normalizeAccentColorValue,
  normalizeFontScale,
  type ImageGenProvider,
  normalizeEnvironmentContextFlags,
  normalizeObjectStorageConfig,
  LLM_REQUEST_TIMEOUT_MIN_MS,
  LLM_REQUEST_TIMEOUT_MAX_MS,
  type LlmProvider,
  type WorkspaceSettings,
} from "./types.js";
import { isReasoningEffort } from "../llm/reasoningEffort.js";
import { resolveSettingsDir } from "./settingsRoot.js";
import { normalizeLlmBaseUrl, normalizeLlmProviderOptions } from "../llm/apiProtocol.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProvider(value: unknown): LlmProvider | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id.trim()) return null;
  if (typeof value.name !== "string" || !value.name.trim()) return null;
  if (typeof value.baseUrl !== "string" || !value.baseUrl.trim()) return null;
  if (typeof value.modelId !== "string" || !value.modelId.trim()) return null;
  const provider: LlmProvider = {
    ...normalizeLlmProviderOptions(value),
    id: value.id.trim(),
    name: value.name.trim(),
    baseUrl: normalizeLlmBaseUrl(value.baseUrl, value.rawEndpoint === true),
    modelId: value.modelId.trim(),
  };
  if (value.supportsMultimodal === true) {
    provider.supportsMultimodal = true;
  }
  if (value.rawEndpoint === true) {
    provider.rawEndpoint = true;
  }
  if (value.imageInput === "base64" || value.imageInput === "file") {
    provider.imageInput = value.imageInput;
  }
  if (typeof value.toolRoleImages === "boolean") {
    provider.toolRoleImages = value.toolRoleImages;
  }
  return provider;
}

/** Parse one image-gen profile entry; id falls back to the stable legacy id. */
function parseImageGenProviderItem(value: unknown): ImageGenProvider | null {
  if (!isRecord(value)) return null;
  if (typeof value.name !== "string" || !value.name.trim()) return null;
  if (typeof value.baseUrl !== "string" || !value.baseUrl.trim()) return null;
  if (typeof value.modelId !== "string" || !value.modelId.trim()) return null;
  const provider: ImageGenProvider = {
    id:
      typeof value.id === "string" && value.id.trim()
        ? value.id.trim()
        : IMAGEGEN_PROVIDER_ID,
    name: value.name.trim(),
    baseUrl: normalizeLlmBaseUrl(value.baseUrl, value.rawEndpoint === true),
    modelId: value.modelId.trim(),
  };
  if (value.rawEndpoint === true) {
    provider.rawEndpoint = true;
  }
  if (value.watermark === true || value.watermark === false) {
    provider.watermark = value.watermark;
  }
  if (value.imageInput === "base64" || value.imageInput === "url") {
    provider.imageInput = value.imageInput;
  }
  return provider;
}

/** Migrate the legacy single image-gen profile into a one-entry list. */
function parseLegacyImageGenProvider(value: unknown): ImageGenProvider[] {
  if (value === null || value === undefined) return [];
  // Legacy shape is an LlmProvider written with the fixed id `imagegen`;
  // keep that id so the stored credential (key store account
  // `api-key:imagegen`) keeps resolving without any key migration.
  const legacy = parseProvider(value);
  if (!legacy) return [];
  return [
    {
      id: IMAGEGEN_PROVIDER_ID,
      name: legacy.name,
      baseUrl: legacy.baseUrl,
      modelId: legacy.modelId,
      ...(legacy.rawEndpoint === true ? { rawEndpoint: true } : {}),
    },
  ];
}

function parseSharedFields(
  data: Record<string, unknown>,
  settings: WorkspaceSettings,
): void {
  const remote = normalizeRemoteRelaySettings(data.remote);
  if (remote) settings.remote = remote;
  if (typeof data.fullPermissionsDefault === "boolean") {
    settings.fullPermissionsDefault = data.fullPermissionsDefault;
  }
  if (typeof data.autoSkillSummarizeDefault === "boolean") {
    settings.autoSkillSummarizeDefault = data.autoSkillSummarizeDefault;
  }
  if (data.composerRunMode === "infinite") {
    // Legacy 4th mode → plan + Infinite switch on (explicit field wins below).
    settings.composerRunMode = "plan";
    if (typeof data.composerInfinite !== "boolean") {
      settings.composerInfinite = true;
    }
  } else if (
    data.composerRunMode === "agent" ||
    data.composerRunMode === "ask" ||
    data.composerRunMode === "plan"
  ) {
    settings.composerRunMode = data.composerRunMode;
  }
  if (typeof data.composerInfinite === "boolean") {
    settings.composerInfinite = data.composerInfinite;
  }
  if (typeof data.composerVoiceMode === "boolean") {
    settings.composerVoiceMode = data.composerVoiceMode;
  }
  // Dial level; legacy Max boolean migrates (true → "max", false → "low").
  if (isReasoningEffort(data.reasoningEffort)) {
    settings.reasoningEffort = data.reasoningEffort;
  } else if (typeof data.reasoningEffortMax === "boolean") {
    settings.reasoningEffort = data.reasoningEffortMax ? "max" : "low";
  }
  if (
    typeof data.contextLimitTokens === "number" &&
    Number.isFinite(data.contextLimitTokens) &&
    data.contextLimitTokens > 0
  ) {
    settings.contextLimitTokens = data.contextLimitTokens;
  }
  if (
    typeof data.compactTriggerRatio === "number" &&
    Number.isFinite(data.compactTriggerRatio) &&
    data.compactTriggerRatio >= 0.5 &&
    data.compactTriggerRatio <= 0.95
  ) {
    settings.compactTriggerRatio = data.compactTriggerRatio;
  }
  if (
    typeof data.iterationProtectRawIterationCount === "number" &&
    Number.isFinite(data.iterationProtectRawIterationCount) &&
    data.iterationProtectRawIterationCount >= 1
  ) {
    settings.iterationProtectRawIterationCount = Math.floor(
      data.iterationProtectRawIterationCount,
    );
  }
  if (
    typeof data.iterationProtectTokenRatio === "number" &&
    Number.isFinite(data.iterationProtectTokenRatio) &&
    data.iterationProtectTokenRatio > 0 &&
    data.iterationProtectTokenRatio <= 0.9
  ) {
    settings.iterationProtectTokenRatio = data.iterationProtectTokenRatio;
  }
  if (
    typeof data.maxModelIterations === "number" &&
    Number.isFinite(data.maxModelIterations) &&
    data.maxModelIterations > 0
  ) {
    settings.maxModelIterations = Math.floor(data.maxModelIterations);
  }
  if (
    typeof data.maxTurnTokens === "number" &&
    Number.isFinite(data.maxTurnTokens) &&
    data.maxTurnTokens > 0
  ) {
    settings.maxTurnTokens = Math.floor(data.maxTurnTokens);
  }
  if (
    typeof data.llmRequestTimeoutMs === "number" &&
    Number.isFinite(data.llmRequestTimeoutMs) &&
    data.llmRequestTimeoutMs >= LLM_REQUEST_TIMEOUT_MIN_MS &&
    data.llmRequestTimeoutMs <= LLM_REQUEST_TIMEOUT_MAX_MS
  ) {
    settings.llmRequestTimeoutMs = Math.floor(data.llmRequestTimeoutMs);
  }
  if (
    typeof data.activeWorkspaceId === "string" &&
    data.activeWorkspaceId.trim()
  ) {
    settings.activeWorkspaceId = data.activeWorkspaceId.trim();
  }
  if (
    typeof data.debugAdapterPath === "string" &&
    data.debugAdapterPath.trim()
  ) {
    settings.debugAdapterPath = data.debugAdapterPath.trim();
  }
  // Legacy identityPrompt / soulPrompt / agentSystemPrompt keys are ignored.
  // Legacy `summaryProvider` key is ignored (summary profile was removed).
  if ("environmentContext" in data) {
    settings.environmentContext = normalizeEnvironmentContextFlags(
      data.environmentContext,
    );
  }
  // Vision fallback references a chat provider id (Multimodal required at
  // resolve time). Legacy dedicated `visionProvider` object is ignored.
  if (typeof data.visionProviderId === "string" && data.visionProviderId.trim()) {
    const visionProviderId = data.visionProviderId.trim();
    if (settings.providers.some((p) => p.id === visionProviderId)) {
      settings.visionProviderId = visionProviderId;
    }
  }
  if (
    typeof data.inlineCompletionProviderId === "string" &&
    data.inlineCompletionProviderId.trim()
  ) {
    const inlineCompletionProviderId = data.inlineCompletionProviderId.trim();
    if (settings.providers.some((p) => p.id === inlineCompletionProviderId)) {
      settings.inlineCompletionProviderId = inlineCompletionProviderId;
    }
  }
  if (Array.isArray(data.imageGenProviders)) {
    const imageGenProviders: ImageGenProvider[] = [];
    for (const item of data.imageGenProviders) {
      const provider = parseImageGenProviderItem(item);
      if (provider) imageGenProviders.push(provider);
    }
    settings.imageGenProviders = imageGenProviders;
  } else if (data.imageGenProvider !== undefined) {
    // Legacy single-profile shape → one-entry list (stable `imagegen` id).
    settings.imageGenProviders = parseLegacyImageGenProvider(
      data.imageGenProvider,
    );
  }
  if (
    typeof data.activeImageGenProviderId === "string" &&
    data.activeImageGenProviderId.trim() &&
    (settings.imageGenProviders ?? []).some(
      (p) => p.id === data.activeImageGenProviderId,
    )
  ) {
    settings.activeImageGenProviderId = data.activeImageGenProviderId.trim();
  }
  if (data.objectStorage === null) {
    settings.objectStorage = null;
  } else if (data.objectStorage !== undefined) {
    const objectStorage = normalizeObjectStorageConfig(data.objectStorage);
    if (objectStorage) settings.objectStorage = objectStorage;
  }
  if (typeof data.userMemoryAutoExtract === "boolean") {
    settings.userMemoryAutoExtract = data.userMemoryAutoExtract;
  }
  if (typeof data.projectMemoryAutoExtract === "boolean") {
    settings.projectMemoryAutoExtract = data.projectMemoryAutoExtract;
  }
  if (typeof data.toolStatsEnabled === "boolean") {
    settings.toolStatsEnabled = data.toolStatsEnabled;
  }
  // Legacy "graphite" ids are dropped here; resolveThemeId lands them on dark.
  if (data.themeId === "dark" || data.themeId === "light") {
    settings.themeId = data.themeId;
  }
  const accentColor = normalizeAccentColorValue(data.accentColor);
  if (accentColor) settings.accentColor = accentColor;
  // Font scales: clamped to the resolver ranges; default (1) / invalid omit.
  const uiFontScale = normalizeFontScale(data.uiFontScale, 1, 0.8, 1.5);
  if (uiFontScale !== 1) settings.uiFontScale = uiFontScale;
  const chatFontScale = normalizeFontScale(data.chatFontScale, 1, 0.8, 1.6);
  if (chatFontScale !== 1) settings.chatFontScale = chatFontScale;
}

/**
 * Parse settings JSON; missing/invalid file → null (caller applies defaults).
 * Migrates legacy flat `{ baseUrl, defaultModelId }` into a single provider.
 */
export function parseWorkspaceSettings(raw: string): WorkspaceSettings | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (!isRecord(data)) return null;

    if (Array.isArray(data.providers) && data.providers.length > 0) {
      const providers: LlmProvider[] = [];
      for (const item of data.providers) {
        const provider = parseProvider(item);
        if (provider) providers.push(provider);
      }
      if (providers.length === 0) return null;

      const activeProviderId =
        typeof data.activeProviderId === "string" &&
        providers.some((p) => p.id === data.activeProviderId)
          ? data.activeProviderId
          : providers[0]!.id;

      const settings: WorkspaceSettings = { providers, activeProviderId };
      parseSharedFields(data, settings);
      return settings;
    }

    // Legacy flat shape
    if (
      typeof data.baseUrl === "string" &&
      data.baseUrl.trim() &&
      typeof data.defaultModelId === "string" &&
      data.defaultModelId.trim()
    ) {
      const provider = createDefaultProvider({
        baseUrl: data.baseUrl,
        modelId: data.defaultModelId,
      });
      const settings: WorkspaceSettings = {
        providers: [provider],
        activeProviderId: provider.id,
      };
      parseSharedFields(data, settings);
      return settings;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Read app-level settings from `{appDataRoot}/settings.json`.
 */
export async function readWorkspaceSettings(
  appDataRoot: string,
): Promise<WorkspaceSettings | null> {
  const filePath = join(resolveSettingsDir(appDataRoot), WORKSPACE_SETTINGS_FILE);
  try {
    const raw = await readFile(filePath, "utf8");
    return parseWorkspaceSettings(raw);
  } catch {
    return null;
  }
}

/** Stable id for a newly added provider profile. */
export function newProviderId(): string {
  return randomUUID();
}
