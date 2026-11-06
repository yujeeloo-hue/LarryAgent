import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ImageGenProvider,
  WORKSPACE_SETTINGS_FILE,
  normalizeRemoteRelaySettings,
  normalizeAccentColorValue,
  normalizeFontScale,
  normalizeEnvironmentContextFlags,
  normalizeObjectStorageConfig,
  withSettingsDefaults,
  LLM_REQUEST_TIMEOUT_MIN_MS,
  LLM_REQUEST_TIMEOUT_MAX_MS,
  type LlmProvider,
  type WorkspaceSettings,
} from "./types.js";
import { isReasoningEffort } from "../llm/reasoningEffort.js";
import { resolveSettingsDir } from "./settingsRoot.js";
import { normalizeLlmBaseUrl, normalizeLlmProviderOptions } from "../llm/apiProtocol.js";

let writeChain: Promise<unknown> = Promise.resolve();

/** Serialize settings.json mutations (prevents Cmd+Shift+M double-write races). */
export function withSettingsWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

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

/** Parse one image-gen profile entry for persistence; id is required. */
function parseImageGenProviderItem(value: unknown): ImageGenProvider | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id.trim()) return null;
  if (typeof value.name !== "string" || !value.name.trim()) return null;
  if (typeof value.baseUrl !== "string" || !value.baseUrl.trim()) return null;
  if (typeof value.modelId !== "string" || !value.modelId.trim()) return null;
  const provider: ImageGenProvider = {
    id: value.id.trim(),
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

/** Validate and normalize a settings object for persistence (providers shape). */
export function normalizeWorkspaceSettings(
  input: unknown,
): WorkspaceSettings | null {
  if (!isRecord(input)) return null;

  let providers: LlmProvider[] = [];
  if (Array.isArray(input.providers)) {
    for (const item of input.providers) {
      const provider = parseProvider(item);
      if (provider) providers.push(provider);
    }
  }

  // Accept legacy patch shapes during transition (single baseUrl/model).
  if (
    providers.length === 0 &&
    typeof input.baseUrl === "string" &&
    typeof input.defaultModelId === "string"
  ) {
    const resolved = withSettingsDefaults(null);
    providers = [
      {
        ...resolved.providers[0]!,
        baseUrl: normalizeLlmBaseUrl(input.baseUrl, input.rawEndpoint === true),
        modelId: input.defaultModelId.trim(),
      },
    ];
  }

  if (providers.length === 0) return null;

  const activeProviderId =
    typeof input.activeProviderId === "string" &&
    providers.some((p) => p.id === input.activeProviderId)
      ? input.activeProviderId
      : providers[0]!.id;

  const settings: WorkspaceSettings = {
    providers,
    activeProviderId,
  };

  if ("visionProviderId" in input) {
    // Must reference an existing chat provider (Multimodal is enforced at
    // resolve time so the flag can be toggled later without rewriting).
    settings.visionProviderId =
      typeof input.visionProviderId === "string" &&
      providers.some((p) => p.id === input.visionProviderId)
        ? input.visionProviderId
        : null;
  }

  const imageGenProviders: ImageGenProvider[] = [];
  if (Array.isArray(input.imageGenProviders)) {
    for (const item of input.imageGenProviders) {
      const provider = parseImageGenProviderItem(item);
      if (provider) imageGenProviders.push(provider);
    }
    settings.imageGenProviders = imageGenProviders;
  } else if ("imageGenProvider" in input) {
    // Legacy single-profile patch shape (renderer preload older than main).
    settings.imageGenProviders =
      input.imageGenProvider == null
        ? []
        : [input.imageGenProvider]
            .map(parseImageGenProviderItem)
            .filter((p): p is ImageGenProvider => p !== null);
  }
  if ("activeImageGenProviderId" in input) {
    const activeId =
      typeof input.activeImageGenProviderId === "string"
        ? input.activeImageGenProviderId.trim()
        : "";
    settings.activeImageGenProviderId = imageGenProviders.some(
      (p) => p.id === activeId,
    )
      ? activeId
      : (imageGenProviders[0]?.id ?? "");
  }

  if ("objectStorage" in input) {
    if (input.objectStorage === null) {
      settings.objectStorage = null;
    } else {
      const objectStorage = normalizeObjectStorageConfig(input.objectStorage);
      if (objectStorage) settings.objectStorage = objectStorage;
    }
  }

  if (typeof input.fullPermissionsDefault === "boolean") {
    settings.fullPermissionsDefault = input.fullPermissionsDefault;
  }
  if (
    input.composerRunMode === "agent" ||
    input.composerRunMode === "ask" ||
    input.composerRunMode === "plan"
  ) {
    settings.composerRunMode = input.composerRunMode;
  }
  if (typeof input.composerInfinite === "boolean") {
    settings.composerInfinite = input.composerInfinite;
  }
  if (typeof input.composerVoiceMode === "boolean") {
    settings.composerVoiceMode = input.composerVoiceMode;
  }
  if (isReasoningEffort(input.reasoningEffort)) {
    settings.reasoningEffort = input.reasoningEffort;
  }

  if (
    typeof input.contextLimitTokens === "number" &&
    Number.isFinite(input.contextLimitTokens) &&
    input.contextLimitTokens > 0
  ) {
    settings.contextLimitTokens = Math.floor(input.contextLimitTokens);
  }

  if (
    typeof input.compactTriggerRatio === "number" &&
    Number.isFinite(input.compactTriggerRatio) &&
    input.compactTriggerRatio >= 0.5 &&
    input.compactTriggerRatio <= 0.95
  ) {
    settings.compactTriggerRatio = input.compactTriggerRatio;
  }

  if (
    typeof input.iterationProtectRawIterationCount === "number" &&
    Number.isFinite(input.iterationProtectRawIterationCount) &&
    input.iterationProtectRawIterationCount >= 1
  ) {
    settings.iterationProtectRawIterationCount = Math.floor(
      input.iterationProtectRawIterationCount,
    );
  }

  if (
    typeof input.iterationProtectTokenRatio === "number" &&
    Number.isFinite(input.iterationProtectTokenRatio) &&
    input.iterationProtectTokenRatio > 0 &&
    input.iterationProtectTokenRatio <= 0.9
  ) {
    settings.iterationProtectTokenRatio = input.iterationProtectTokenRatio;
  }

  if (
    typeof input.maxModelIterations === "number" &&
    Number.isFinite(input.maxModelIterations) &&
    input.maxModelIterations > 0
  ) {
    settings.maxModelIterations = Math.floor(input.maxModelIterations);
  }

  if (
    typeof input.maxTurnTokens === "number" &&
    Number.isFinite(input.maxTurnTokens) &&
    input.maxTurnTokens > 0
  ) {
    settings.maxTurnTokens = Math.floor(input.maxTurnTokens);
  }

  if (
    typeof input.llmRequestTimeoutMs === "number" &&
    Number.isFinite(input.llmRequestTimeoutMs) &&
    input.llmRequestTimeoutMs >= LLM_REQUEST_TIMEOUT_MIN_MS &&
    input.llmRequestTimeoutMs <= LLM_REQUEST_TIMEOUT_MAX_MS
  ) {
    settings.llmRequestTimeoutMs = Math.floor(input.llmRequestTimeoutMs);
  }

  if (
    typeof input.activeWorkspaceId === "string" &&
    input.activeWorkspaceId.trim()
  ) {
    settings.activeWorkspaceId = input.activeWorkspaceId.trim();
  } else if (input.activeWorkspaceId === null) {
    settings.activeWorkspaceId = null;
  }

  if (
    typeof input.debugAdapterPath === "string" &&
    input.debugAdapterPath.trim()
  ) {
    settings.debugAdapterPath = input.debugAdapterPath.trim();
  }

  if ("environmentContext" in input) {
    settings.environmentContext = normalizeEnvironmentContextFlags(
      input.environmentContext,
    );
  }

  if (typeof input.userMemoryAutoExtract === "boolean") {
    settings.userMemoryAutoExtract = input.userMemoryAutoExtract;
  }

  if (typeof input.projectMemoryAutoExtract === "boolean") {
    settings.projectMemoryAutoExtract = input.projectMemoryAutoExtract;
  }

  if (typeof input.toolStatsEnabled === "boolean") {
    settings.toolStatsEnabled = input.toolStatsEnabled;
  }

  if (input.themeId === "dark" || input.themeId === "light") {
    settings.themeId = input.themeId;
  }
  if ("accentColor" in input) {
    // null / "auto" / invalid → key omitted (Auto = not written).
    const accent = normalizeAccentColorValue(input.accentColor);
    if (accent) settings.accentColor = accent;
    else delete settings.accentColor;
  }
  // Font scales: clamp to the resolver ranges; the default (1) and invalid
  // values stay out of the file (sparse settings.json).
  const uiFontScale = normalizeFontScale(input.uiFontScale, 1, 0.8, 1.5);
  if (uiFontScale !== 1) settings.uiFontScale = uiFontScale;
  const chatFontScale = normalizeFontScale(input.chatFontScale, 1, 0.8, 1.6);
  if (chatFontScale !== 1) settings.chatFontScale = chatFontScale;

  const remote = normalizeRemoteRelaySettings(input.remote);
  if (remote) settings.remote = remote;

  return settings;
}


/** Write settings.json via temp file + rename (no lock). */
export async function writeWorkspaceSettingsUnlocked(
  appDataRoot: string,
  settings: WorkspaceSettings,
): Promise<WorkspaceSettings> {
  const normalized = normalizeWorkspaceSettings(settings);
  if (!normalized) {
    throw new Error("Invalid settings");
  }

  const settingsDir = resolveSettingsDir(appDataRoot);
  await mkdir(settingsDir, { recursive: true });
  const filePath = join(settingsDir, WORKSPACE_SETTINGS_FILE);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(normalized, null, 2)}\n`;
  await writeFile(tmpPath, body, "utf8");
  await rename(tmpPath, filePath);
  return normalized;
}

/** Write non-secret settings to `{appDataRoot}/settings.json` (serialized). */
export async function writeWorkspaceSettings(
  appDataRoot: string,
  settings: WorkspaceSettings,
): Promise<WorkspaceSettings> {
  return withSettingsWriteLock(() =>
    writeWorkspaceSettingsUnlocked(appDataRoot, settings),
  );
}
