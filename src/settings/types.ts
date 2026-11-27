
import {
  clampSystemPrompt,
  getDefaultProjectPrompt,
  getDefaultUserPrompt,
} from "./promptDefaults.js";
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS } from "../llm/types.js";
import { normalizeLlmBaseUrl, normalizeLlmProviderOptions, type LlmProviderApiOptions } from "../llm/apiProtocol.js";
import { isValidProtectTokenRatio } from "../shared/protectTokenRatio.js";
import { DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL_ID, DEFAULT_JEV_PROVIDER_NAME, JEV_PROVIDER_ID } from "../shared/jevDefaults.js";
import { normalizeDevModePreferences, type DevModePreferences } from "./devModePreferences.js";
import {
  normalizeReasoningEffort,
  type ReasoningEffort,
} from "../llm/reasoningEffort.js";

export { DEFAULT_LLM_REQUEST_TIMEOUT_MS };

export const LLM_REQUEST_TIMEOUT_MIN_MS = 1_000;
export const LLM_REQUEST_TIMEOUT_MAX_MS = 600_000;

export type LlmProvider = LlmProviderApiOptions & {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  rawEndpoint?: boolean;
  supportsMultimodal?: boolean;
  imageInput?: "url" | "base64" | "file";
  toolRoleImages?: boolean;
};

export type ImageGenProvider = {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  rawEndpoint?: boolean;
  watermark?: boolean;
  imageInput?: "base64" | "url";
};

export type JevProvider = {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
};

export type WorkspaceSettings = {
  providers: LlmProvider[];
  activeProviderId: string;
  visionProviderId?: string | null;
  inlineCompletionProviderId?: string | null;
  imageGenProviders?: ImageGenProvider[];
  activeImageGenProviderId?: string;
  jevProvider?: JevProvider | null;
  objectStorage?: ObjectStorageConfig | null;
  fullPermissionsDefault?: boolean;
  autoSkillSummarizeDefault?: boolean;
  composerRunMode?: "agent" | "ask" | "plan";
  composerInfinite?: boolean;
  reasoningEffort?: ReasoningEffort;
  composerVoiceMode?: boolean;
  contextLimitTokens?: number;
  compactTriggerRatio?: number;
  iterationProtectRawIterationCount?: number;
  iterationProtectTokenRatio?: number;
  maxModelIterations?: number;
  maxTurnTokens?: number;
  llmRequestTimeoutMs?: number;
  activeWorkspaceId?: string | null;
  debugAdapterPath?: string | null;
  environmentContext?: Partial<EnvironmentContextFlags>;
  userMemoryAutoExtract?: boolean;
  projectMemoryAutoExtract?: boolean;
  topicBoundaryEnabled?: boolean;
  toolStatsEnabled?: boolean;
  virtualCursorEnabled?: boolean;
  devMode?: DevModePreferences;
  themeId?: "dark" | "light";
  accentColor?: string | null;
  uiFontScale?: number;
  chatFontScale?: number;
  remote?: RemoteRelaySettings;
};

export type RemoteRelaySettings = {
  enabled: boolean;
  serverUrl: string;
  deviceId: string;
  deviceName: string;
  mode: "readonly" | "full";
  pushActivity: "all" | "active" | "off";
  memorySync?: MemorySyncSettings | undefined;
};

export type MemorySyncSettings = {
  enabled: boolean;
  sessionArchive: boolean;
  projectDocs: boolean;
};

export function normalizeRemoteRelaySettings(
  input: unknown,
): RemoteRelaySettings | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const r = input as Record<string, unknown>;
  const ms = r.memorySync;
  return {
    enabled: r.enabled === true,
    serverUrl: typeof r.serverUrl === "string" ? r.serverUrl.trim() : "",
    deviceId: typeof r.deviceId === "string" ? r.deviceId : "",
    deviceName: typeof r.deviceName === "string" ? r.deviceName : "",
    mode: r.mode === "full" ? "full" : "readonly",
    pushActivity:
      r.pushActivity === "active" || r.pushActivity === "off"
        ? r.pushActivity
        : "all",
    memorySync:
      typeof ms === "object" && ms !== null
        ? {
            enabled: (ms as Record<string, unknown>).enabled === true,
            sessionArchive: (ms as Record<string, unknown>).sessionArchive !== false,
            projectDocs: (ms as Record<string, unknown>).projectDocs === true,
          }
        : undefined,
  };
}

export type EnvironmentContextFlags = {
  workspace: boolean;
  timezone: boolean;
  locale: boolean;
  location: boolean;
  repository: boolean;
};

export const DEFAULT_ENVIRONMENT_CONTEXT_FLAGS: EnvironmentContextFlags = {
  workspace: true,
  timezone: true,
  locale: true,
  location: true,
  repository: true,
};

export const WORKSPACE_SETTINGS_DIR = ".jellybot";
export const WORKSPACE_SETTINGS_FILE = "settings.json";

export const DEFAULT_CONTEXT_LIMIT_TOKENS = 128_000;
export const DEFAULT_MAX_MODEL_ITERATIONS = 128;
export const DEFAULT_MAX_TURN_TOKENS = 3_000_000;

export function isMoonshotProviderBaseUrl(
  baseUrl: string | null | undefined,
): boolean {
  const trimmed = (baseUrl ?? "").trim();
  if (!trimmed) return false;
  try {
    const host = new URL(trimmed).hostname.toLowerCase();
    return (
      host === "api.moonshot.cn" ||
      host.endsWith(".moonshot.cn") ||
      host === "api.moonshot.ai" ||
      host.endsWith(".moonshot.ai") ||
      host === "api.kimi.com" ||
      host.endsWith(".kimi.com")
    );
  } catch {
    return false;
  }
}

export function chatProviderAcceptsImageUrls(
  settings: WorkspaceSettings | null | undefined,
  providerId: string | null | undefined,
): boolean {
  if (!settings || !providerId) return false;
  const provider = settings.providers.find((p) => p.id === providerId);
  if (provider?.supportsMultimodal !== true) return false;
  if (provider.imageInput === "base64" || provider.imageInput === "file") {
    return false;
  }
  return !isMoonshotProviderBaseUrl(provider.baseUrl);
}

export function chatProviderUsesBase64Images(
  settings: WorkspaceSettings | null | undefined,
  providerId: string | null | undefined,
): boolean {
  if (!settings || !providerId) return false;
  const provider = settings.providers.find((p) => p.id === providerId);
  return (
    provider?.supportsMultimodal === true && provider.imageInput === "base64"
  );
}

export function chatProviderUsesProviderFiles(
  settings: WorkspaceSettings | null | undefined,
  providerId: string | null | undefined,
): boolean {
  if (!settings || !providerId) return false;
  const provider = settings.providers.find((p) => p.id === providerId);
  return (
    provider?.supportsMultimodal === true &&
    provider.imageInput === "file" &&
    isMoonshotProviderBaseUrl(provider.baseUrl)
  );
}

export const DEFAULT_COMPACT_TRIGGER_RATIO = 0.55;
export const DEFAULT_ITERATION_PROTECT_RAW_ITERATION_COUNT = 20;
export const DEFAULT_ITERATION_PROTECT_TOKEN_RATIO = 0.2;
export const DEFAULT_HARD_TRUNCATE_RATIO = 0.8;
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL_ID = "gpt-4o-mini";
export const DEFAULT_PROVIDER_ID = "default";
export const DEFAULT_PROVIDER_NAME = "Default";

export const IMAGEGEN_PROVIDER_ID = "imagegen";

export const OBJECT_STORAGE_CREDENTIAL_ID = "object-storage";

export type ObjectStorageProviderKind = "amazon" | "tencent";

export type ObjectStorageUrlMode = "presigned" | "public";

export type ObjectStorageConfig = {
  provider: ObjectStorageProviderKind;
  region: string;
  bucket: string;
  accessKeyId: string;
  endpoint?: string;
  keyPrefix?: string;
  urlMode?: ObjectStorageUrlMode;
  enabled?: boolean;
};
export const DEFAULT_IMAGEGEN_PROVIDER_NAME = "ImageGen";
export const DEFAULT_IMAGEGEN_BASE_URL =
  "https://open.bigmodel.cn/api/paas/v4";
export const DEFAULT_IMAGEGEN_MODEL_ID = "cogview-4-250304";

export { JEV_PROVIDER_ID, DEFAULT_JEV_PROVIDER_NAME, DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL_ID };

export function normalizeJevProvider(value: unknown): JevProvider | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const text = (key: string): string => typeof raw[key] === "string" ? (raw[key] as string).trim() : "";
  const baseUrl = text("baseUrl").replace(/\/+$/, "");
  const modelId = text("modelId");
  if (!baseUrl || !modelId) return null;
  return {
    id: JEV_PROVIDER_ID,
    name: text("name") || DEFAULT_JEV_PROVIDER_NAME,
    baseUrl,
    modelId,
  };
}

export function resolveJevProvider(
  settings: WorkspaceSettings | null | undefined,
): JevProvider | null {
  return normalizeJevProvider(settings?.jevProvider);
}

export {
  configurePromptDefaults,
  getDefaultCompactIterationProtectPrompt,
  getDefaultSessionArchiveSummarizePrompt,
  getDefaultTopicBoundaryPrompt,
  getPromptDefaults,

} from "./promptDefaults.js";
export type { PromptDefaults } from "./promptDefaults.js";

export function createDefaultProvider(
  overrides?: Partial<Pick<LlmProvider, "baseUrl" | "modelId" | "name">>,
): LlmProvider {
  return {
    id: DEFAULT_PROVIDER_ID,
    name: overrides?.name?.trim() || DEFAULT_PROVIDER_NAME,
    baseUrl: normalizeLlmBaseUrl(overrides?.baseUrl?.trim() || DEFAULT_BASE_URL),
    modelId: overrides?.modelId?.trim() || DEFAULT_MODEL_ID,
  };
}

export function resolveContextLimitTokens(
  settings: WorkspaceSettings | null | undefined,
): number {
  const value = settings?.contextLimitTokens;
  return typeof value === "number" && value > 0
    ? value
    : DEFAULT_CONTEXT_LIMIT_TOKENS;
}

export function resolveCompactTriggerRatio(
  settings: WorkspaceSettings | null | undefined,
): number {
  const value = settings?.compactTriggerRatio;
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0.5 &&
    value <= 0.95
  ) {
    return value;
  }
  return DEFAULT_COMPACT_TRIGGER_RATIO;
}

export function resolveIterationProtectRawIterationCount(
  settings: WorkspaceSettings | null | undefined,
): number {
  const value = settings?.iterationProtectRawIterationCount;
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return Math.floor(value);
  }
  return DEFAULT_ITERATION_PROTECT_RAW_ITERATION_COUNT;
}

export function resolveIterationProtectTokenRatio(
  settings: WorkspaceSettings | null | undefined,
): number {
  const value = settings?.iterationProtectTokenRatio;
  if (isValidProtectTokenRatio(value)) {
    return value;
  }
  return DEFAULT_ITERATION_PROTECT_TOKEN_RATIO;
}

export function resolveMaxModelIterations(
  settings: WorkspaceSettings | null | undefined,
): number {
  const value = settings?.maxModelIterations;
  return typeof value === "number" && value > 0
    ? Math.floor(value)
    : DEFAULT_MAX_MODEL_ITERATIONS;
}

export function resolveMaxTurnTokens(
  settings: WorkspaceSettings | null | undefined,
): number {
  const value = settings?.maxTurnTokens;
  return typeof value === "number" && value > 0
    ? Math.floor(value)
    : DEFAULT_MAX_TURN_TOKENS;
}

export function resolveLlmRequestTimeoutMs(
  settings: WorkspaceSettings | null | undefined,
): number {
  const value = settings?.llmRequestTimeoutMs;
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= LLM_REQUEST_TIMEOUT_MIN_MS &&
    value <= LLM_REQUEST_TIMEOUT_MAX_MS
  ) {
    return Math.floor(value);
  }
  return DEFAULT_LLM_REQUEST_TIMEOUT_MS;
}

export function resolveUserPrompt(
  profile: string | null | undefined,
): string {
  const trimmed = typeof profile === "string" ? profile.trim() : "";
  if (trimmed.length > 0) {
    return clampSystemPrompt(trimmed);
  }
  return getDefaultUserPrompt();
}

export function resolveProjectPrompt(
  body: string | null | undefined,
): string {
  const trimmed = typeof body === "string" ? body.trim() : "";
  if (trimmed.length > 0) {
    return clampSystemPrompt(trimmed);
  }
  return getDefaultProjectPrompt();
}

function flagOrDefault(
  value: boolean | undefined,
  fallback: boolean,
): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function resolveEnvironmentContextFlags(
  settings: WorkspaceSettings | null | undefined,
): EnvironmentContextFlags {
  const raw = settings?.environmentContext;
  return {
    workspace: flagOrDefault(
      raw?.workspace,
      DEFAULT_ENVIRONMENT_CONTEXT_FLAGS.workspace,
    ),
    timezone: flagOrDefault(
      raw?.timezone,
      DEFAULT_ENVIRONMENT_CONTEXT_FLAGS.timezone,
    ),
    locale: flagOrDefault(raw?.locale, DEFAULT_ENVIRONMENT_CONTEXT_FLAGS.locale),
    location: flagOrDefault(
      raw?.location,
      DEFAULT_ENVIRONMENT_CONTEXT_FLAGS.location,
    ),
    repository: flagOrDefault(
      raw?.repository,
      DEFAULT_ENVIRONMENT_CONTEXT_FLAGS.repository,
    ),
  };
}

export function normalizeEnvironmentContextFlags(
  value: unknown,
): EnvironmentContextFlags {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_ENVIRONMENT_CONTEXT_FLAGS };
  }
  const raw = value as Partial<EnvironmentContextFlags>;
  return {
    workspace: flagOrDefault(
      raw.workspace,
      DEFAULT_ENVIRONMENT_CONTEXT_FLAGS.workspace,
    ),
    timezone: flagOrDefault(
      raw.timezone,
      DEFAULT_ENVIRONMENT_CONTEXT_FLAGS.timezone,
    ),
    locale: flagOrDefault(raw.locale, DEFAULT_ENVIRONMENT_CONTEXT_FLAGS.locale),
    location: flagOrDefault(
      raw.location,
      DEFAULT_ENVIRONMENT_CONTEXT_FLAGS.location,
    ),
    repository: flagOrDefault(
      raw.repository,
      DEFAULT_ENVIRONMENT_CONTEXT_FLAGS.repository,
    ),
  };
}

export function resolveActiveProvider(
  settings: WorkspaceSettings | null | undefined,
): LlmProvider {
  const normalized = withSettingsDefaults(settings);
  const found = normalized.providers.find(
    (p) => p.id === normalized.activeProviderId,
  );
  return found ?? normalized.providers[0]!;
}

export function resolveVisionProvider(
  settings: WorkspaceSettings | null | undefined,
): LlmProvider | null {
  const resolved = withSettingsDefaults(settings);
  const id = resolved.visionProviderId;
  if (!id) return null;
  const provider = resolved.providers.find((p) => p.id === id);
  return provider?.supportsMultimodal === true ? provider : null;
}

export function resolveImageGenProvider(
  settings: WorkspaceSettings | null | undefined,
): ImageGenProvider | null {
  const resolved = withSettingsDefaults(settings);
  return (
    resolved.imageGenProviders.find(
      (p) => p.id === resolved.activeImageGenProviderId,
    ) ??
    resolved.imageGenProviders[0] ??
    null
  );
}

function normalizeKnownProviderId(
  value: unknown,
  providers: LlmProvider[],
): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return providers.some((p) => p.id === id) ? id : null;
}

function normalizeImageGenProviders(
  value: ImageGenProvider[] | undefined,
): ImageGenProvider[] {
  if (!Array.isArray(value)) return [];
  const out: ImageGenProvider[] = [];
  for (const entry of value) {
    if (!entry) continue;
    const id = entry.id.trim();
    const name = entry.name.trim();
    const baseUrl = normalizeLlmBaseUrl(entry.baseUrl, entry.rawEndpoint === true);
    const modelId = entry.modelId.trim();
    if (!id || !name || !baseUrl || !modelId) continue;
    out.push({
      id,
      name,
      baseUrl,
      modelId,
      ...(entry.rawEndpoint === true ? { rawEndpoint: true } : {}),
      ...(typeof entry.watermark === "boolean"
        ? { watermark: entry.watermark }
        : {}),
      ...(entry.imageInput === "base64" || entry.imageInput === "url"
        ? { imageInput: entry.imageInput }
        : {}),
    });
  }
  return out;
}

export function normalizeObjectStorageConfig(
  value: unknown,
): ObjectStorageConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const provider: ObjectStorageProviderKind =
    raw.provider === "amazon" || raw.provider === "tencent"
      ? raw.provider
      : "amazon";
  const region = typeof raw.region === "string" ? raw.region.trim() : "";
  const bucket = typeof raw.bucket === "string" ? raw.bucket.trim() : "";
  const accessKeyId =
    typeof raw.accessKeyId === "string" ? raw.accessKeyId.trim() : "";
  if (!region || !bucket || !accessKeyId) return null;
  const config: ObjectStorageConfig = {
    provider,
    region,
    bucket,
    accessKeyId,
  };
  const endpoint =
    typeof raw.endpoint === "string" ? raw.endpoint.trim() : "";
  if (endpoint) {
    config.endpoint = endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
  const keyPrefix = typeof raw.keyPrefix === "string" ? raw.keyPrefix : "";
  const trimmedPrefix = keyPrefix.trim().replace(/^\/+/, "");
  if (trimmedPrefix) {
    config.keyPrefix = trimmedPrefix.endsWith("/")
      ? trimmedPrefix
      : `${trimmedPrefix}/`;
  }
  if (raw.urlMode === "public") {
    config.urlMode = "public";
  } else {
    config.urlMode = "presigned";
  }
  config.enabled = raw.enabled !== false;
  return config;
}

export function resolveObjectStorageConfig(
  settings: WorkspaceSettings | null | undefined,
): ObjectStorageConfig | null {
  return withSettingsDefaults(settings).objectStorage;
}

export function resolveActiveObjectStorage(
  settings: WorkspaceSettings | null | undefined,
): ObjectStorageConfig | null {
  const config = resolveObjectStorageConfig(settings);
  if (!config || config.enabled === false) return null;
  return config;
}

export type ResolvedWorkspaceSettings = {
  providers: LlmProvider[];
  activeProviderId: string;
  visionProviderId: string | null;
  inlineCompletionProviderId: string | null;
  imageGenProviders: ImageGenProvider[];
  activeImageGenProviderId: string;
  jevProvider: JevProvider | null;
  objectStorage: ObjectStorageConfig | null;
  fullPermissionsDefault: boolean;
  autoSkillSummarizeDefault: boolean;
  composerRunMode: "agent" | "ask" | "plan";
  composerInfinite: boolean;
  reasoningEffort: ReasoningEffort;
  composerVoiceMode: boolean;
  contextLimitTokens: number;
  compactTriggerRatio: number;
  iterationProtectRawIterationCount: number;
  iterationProtectTokenRatio: number;
  maxModelIterations: number;
  maxTurnTokens: number;
  llmRequestTimeoutMs: number;
  activeWorkspaceId: string | null;
  debugAdapterPath: string | null;
  environmentContext: EnvironmentContextFlags;
  userMemoryAutoExtract: boolean;
  projectMemoryAutoExtract: boolean;
  topicBoundaryEnabled: boolean;
  toolStatsEnabled: boolean;
  virtualCursorEnabled: boolean;
  devMode: DevModePreferences;
  themeId: "dark" | "light";
  accentColor: string | null;
  uiFontScale: number;
  chatFontScale: number;
  remote?: RemoteRelaySettings;
};

export function resolvedToWorkspaceSettings(
  resolved: ResolvedWorkspaceSettings,
  overrides?: Partial<WorkspaceSettings>,
): WorkspaceSettings {
  const payload: WorkspaceSettings = {
    providers: resolved.providers,
    activeProviderId: resolved.activeProviderId,
    fullPermissionsDefault: resolved.fullPermissionsDefault,
    autoSkillSummarizeDefault: resolved.autoSkillSummarizeDefault,
    composerRunMode: resolved.composerRunMode,
    composerInfinite: resolved.composerInfinite,
    reasoningEffort: resolved.reasoningEffort,
    composerVoiceMode: resolved.composerVoiceMode,
    contextLimitTokens: resolved.contextLimitTokens,
    compactTriggerRatio: resolved.compactTriggerRatio,
    iterationProtectRawIterationCount: resolved.iterationProtectRawIterationCount,
    iterationProtectTokenRatio: resolved.iterationProtectTokenRatio,
    maxModelIterations: resolved.maxModelIterations,
    maxTurnTokens: resolved.maxTurnTokens,
    llmRequestTimeoutMs: resolved.llmRequestTimeoutMs,
    activeWorkspaceId: resolved.activeWorkspaceId,
    ...(resolved.debugAdapterPath
      ? { debugAdapterPath: resolved.debugAdapterPath }
      : {}),
    environmentContext: resolved.environmentContext,
    userMemoryAutoExtract: resolved.userMemoryAutoExtract,
    projectMemoryAutoExtract: resolved.projectMemoryAutoExtract,
    topicBoundaryEnabled: resolved.topicBoundaryEnabled,
    toolStatsEnabled: resolved.toolStatsEnabled,
    virtualCursorEnabled: resolved.virtualCursorEnabled,
    devMode: resolved.devMode,
    themeId: resolved.themeId,
    ...(resolved.remote ? { remote: resolved.remote } : {}),
    ...(resolved.accentColor ? { accentColor: resolved.accentColor } : {}),
    ...(resolved.uiFontScale !== 1
      ? { uiFontScale: resolved.uiFontScale }
      : {}),
    ...(resolved.chatFontScale !== 1
      ? { chatFontScale: resolved.chatFontScale }
      : {}),
    visionProviderId: resolved.visionProviderId ?? null,
    inlineCompletionProviderId: resolved.inlineCompletionProviderId ?? null,
    imageGenProviders: resolved.imageGenProviders,
    activeImageGenProviderId: resolved.activeImageGenProviderId,
    jevProvider: resolved.jevProvider ?? null,
    objectStorage: resolved.objectStorage ?? null,
  };
  return { ...payload, ...overrides };
}

export function withSettingsDefaults(
  settings: WorkspaceSettings | null | undefined,
): ResolvedWorkspaceSettings {
  const providers =
    settings?.providers && settings.providers.length > 0
      ? settings.providers.map((p) => {
          const provider: LlmProvider = {
            ...normalizeLlmProviderOptions(p),
            id: p.id,
            name: p.name.trim() || DEFAULT_PROVIDER_NAME,
            baseUrl: normalizeLlmBaseUrl(p.baseUrl, p.rawEndpoint === true) || DEFAULT_BASE_URL,
            modelId: p.modelId.trim() || DEFAULT_MODEL_ID,
          };
          if (p.supportsMultimodal === true) {
            provider.supportsMultimodal = true;
          }
          if (p.imageInput === "base64" || p.imageInput === "file") {
            provider.imageInput = p.imageInput;
          }
          if (typeof p.toolRoleImages === "boolean") {
            provider.toolRoleImages = p.toolRoleImages;
          }
          if (p.rawEndpoint === true) {
            provider.rawEndpoint = true;
          }
          return provider;
        })
      : [createDefaultProvider()];

  const activeProviderId =
    settings?.activeProviderId &&
    providers.some((p) => p.id === settings.activeProviderId)
      ? settings.activeProviderId
      : providers[0]!.id;

  const imageGenProviders = normalizeImageGenProviders(
    settings?.imageGenProviders ?? [],
  );
  const activeImageGenProviderId =
    typeof settings?.activeImageGenProviderId === "string" &&
    imageGenProviders.some((p) => p.id === settings.activeImageGenProviderId)
      ? settings.activeImageGenProviderId
      : (imageGenProviders[0]?.id ?? "");

  const activeWorkspaceId =
    typeof settings?.activeWorkspaceId === "string" &&
    settings.activeWorkspaceId.trim()
      ? settings.activeWorkspaceId.trim()
      : null;
  const debugAdapterPath =
    typeof settings?.debugAdapterPath === "string" &&
    settings.debugAdapterPath.trim()
      ? settings.debugAdapterPath.trim()
      : null;

  const visionProviderId = normalizeKnownProviderId(
    settings?.visionProviderId,
    providers,
  );
  const inlineCompletionProviderId = normalizeKnownProviderId(
    settings?.inlineCompletionProviderId,
    providers,
  );

  return {
    providers,
    activeProviderId,
    visionProviderId,
    inlineCompletionProviderId,
    imageGenProviders,
    activeImageGenProviderId,
    jevProvider: normalizeJevProvider(settings?.jevProvider),
    objectStorage: normalizeObjectStorageConfig(
      settings?.objectStorage ?? null,
    ),
    fullPermissionsDefault: settings?.fullPermissionsDefault === true,
    autoSkillSummarizeDefault: settings?.autoSkillSummarizeDefault === true,
    composerRunMode: normalizeComposerRunMode(settings?.composerRunMode),
    composerInfinite: settings?.composerInfinite === true,
    reasoningEffort: normalizeReasoningEffort(settings?.reasoningEffort),
    composerVoiceMode: settings?.composerVoiceMode === true,
    contextLimitTokens: resolveContextLimitTokens(settings),
    compactTriggerRatio: resolveCompactTriggerRatio(settings),
    iterationProtectRawIterationCount: resolveIterationProtectRawIterationCount(settings),
    iterationProtectTokenRatio: resolveIterationProtectTokenRatio(settings),
    maxModelIterations: resolveMaxModelIterations(settings),
    maxTurnTokens: resolveMaxTurnTokens(settings),
    llmRequestTimeoutMs: resolveLlmRequestTimeoutMs(settings),
    activeWorkspaceId,
    debugAdapterPath,
    environmentContext: resolveEnvironmentContextFlags(settings),
    userMemoryAutoExtract: settings?.userMemoryAutoExtract !== false,
    projectMemoryAutoExtract: settings?.projectMemoryAutoExtract !== false,
    topicBoundaryEnabled: settings?.topicBoundaryEnabled !== false,
    toolStatsEnabled: settings?.toolStatsEnabled !== false,
    virtualCursorEnabled: settings?.virtualCursorEnabled !== false,
    devMode: normalizeDevModePreferences(settings?.devMode),
    ...(settings?.remote ? { remote: settings.remote } : {}),
    themeId: resolveThemeId(settings),
    accentColor: resolveAccentColor(settings),
    uiFontScale: resolveUiFontScale(settings),
    chatFontScale: resolveChatFontScale(settings),
  };
}

export const ACCENT_COLOR_PRESET_IDS: readonly string[] = [
  "teal",
  "blue",
  "violet",
  "rose",
  "amber",
  "sapphire",
];

export function normalizeAccentColorValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (ACCENT_COLOR_PRESET_IDS.includes(value)) return value;
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  return null;
}

export function resolveAccentColor(
  settings: WorkspaceSettings | null | undefined,
): string | null {
  return normalizeAccentColorValue(settings?.accentColor);
}

export function normalizeFontScale(
  value: unknown,
  fallback = 1,
  min = 0.8,
  max = 1.6,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function resolveUiFontScale(
  settings: WorkspaceSettings | null | undefined,
): number {
  return normalizeFontScale(settings?.uiFontScale, 1, 0.8, 1.5);
}

export function resolveChatFontScale(
  settings: WorkspaceSettings | null | undefined,
): number {
  return normalizeFontScale(settings?.chatFontScale, 1, 0.8, 1.6);
}

export function resolveThemeId(
  settings: WorkspaceSettings | null | undefined,
): "dark" | "light" {
  const value = settings?.themeId;
  if (value === "light" || value === "dark") {
    return value;
  }
  return "dark";
}

export function normalizeComposerRunMode(
  value: unknown,
): "agent" | "ask" | "plan" {
  if (value === "plan" || value === "ask" || value === "agent") {
    return value;
  }
  if (value === "infinite") return "plan";
  return "agent";
}
