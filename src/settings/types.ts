/**
 * Non-secret app settings (`{userData}/settings.json`).
 * API keys live in the encrypted per-provider store — never in this file.
 */

import {
  clampSystemPrompt,
  getDefaultProjectPrompt,
  getDefaultUserPrompt,
} from "./promptDefaults.js";
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS } from "../llm/types.js";
import { normalizeLlmBaseUrl, normalizeLlmProviderOptions, type LlmProviderApiOptions } from "../llm/apiProtocol.js";
import { isValidProtectTokenRatio } from "../shared/protectTokenRatio.js";
import {
  normalizeReasoningEffort,
  type ReasoningEffort,
} from "../llm/reasoningEffort.js";

/** Canonical chat-request timeout default (re-exported for settings users). */
export { DEFAULT_LLM_REQUEST_TIMEOUT_MS };

/** Lower bound for the chat request timeout setting (1s). */
export const LLM_REQUEST_TIMEOUT_MIN_MS = 1_000;
/** Upper bound for the chat request timeout setting (10min). */
export const LLM_REQUEST_TIMEOUT_MAX_MS = 600_000;

export type LlmProvider = LlmProviderApiOptions & {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  /**
   * When true, `baseUrl` is already the full model endpoint — clients use it
   * as-is and never append any path. apiProtocol selects the wire format.
   */
  rawEndpoint?: boolean;
  /**
   * When true, read_image uses this chat provider instead of the dedicated
   * Vision profile.
   */
  supportsMultimodal?: boolean;
  /**
   * How image attachments reach a multimodal provider on the wire:
   * - "url" (default): upload to object storage, send the https URL.
   * - "base64": inline a `data:image/...;base64,...` URI. Required by
   *   providers that cannot fetch external image URLs (e.g. Moonshot/Kimi).
   * - "file": upload to the provider's own files API and reference the file
   *   id on the wire (`ms://<file-id>` for Moonshot/Kimi).
   */
  imageInput?: "url" | "base64" | "file";
  /**
   * Explicit override for tool-result images (read_image direct): defined
   * values force toolRoleImages on/off regardless of the verified default
   * list (`resolveToolRoleImageSupport`). Omit to follow the list.
   */
  toolRoleImages?: boolean;
};

/**
 * Text-to-image profile (OpenAI Images-compatible). Multiple profiles can
 * coexist; the active one is what the generate_image tool resolves.
 */
export type ImageGenProvider = {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  /**
   * When true, `baseUrl` is already the full images endpoint — clients use
   * it as-is and never append `images/generations`.
   */
  rawEndpoint?: boolean;
  /**
   * Explicit watermark preference sent as `watermark` in the request body
   * (e.g. Volcano Ark doubao-seedream). Omit = provider default; the field
   * is not sent at all (Zhipu CogView rejects unknown fields).
   */
  watermark?: boolean;
  /**
   * How input images (image-to-image / reference images) reach this
   * provider's `image` body field:
   * - "base64": inline base64 strings.
   * - "url": upload to object storage (S3/COS) and send https URLs.
   * Omit = image input disabled (`image` is never sent — Zhipu CogView
   * rejects the field with HTTP 400).
   */
  imageInput?: "base64" | "url";
};

export type WorkspaceSettings = {
  providers: LlmProvider[];
  /**
   * Default chat provider for **new** sessions only.
   * Existing sessions keep their own `Session.providerId`.
   */
  activeProviderId: string;
  /**
   * Vision fallback: id of a chat provider (Multimodal enabled) used by
   * read_image when the session's chat provider is not multimodal. The
   * provider's own key slot is reused — no dedicated vision credential.
   * Omit / null when unset. Legacy dedicated `visionProvider` object
   * field is no longer read or written.
   */
  visionProviderId?: string | null;
  /**
   * OpenAI Images-compatible text-to-image profiles (generate_image tool).
   * Omit / empty when unset; never preset — the user configures them in
   * Setting. Legacy single `imageGenProvider` objects migrate into the
   * first list entry (keeping the stable `imagegen` id so the stored
   * credential keeps resolving).
   */
  imageGenProviders?: ImageGenProvider[];
  /** Which imageGenProviders entry generate_image uses; "" when unset. */
  activeImageGenProviderId?: string;
  /**
   * S3-compatible object storage (Amazon S3 / Tencent COS) for multimodal
   * image attachment uploads. Omit / null when unset. Secret Access Key is
   * NOT stored here — it lives in the encrypted key store under
   * `object-storage`.
   */
  objectStorage?: ObjectStorageConfig | null;
  fullPermissionsDefault?: boolean;
  /**
   * Composer run mode restored on app start.
   * `agent` (Auto) | `ask` (Ask, read-only Q&A) | `plan`. Default `agent`.
   * Legacy `infinite` value migrates to `plan` + `composerInfinite: true`.
   */
  composerRunMode?: "agent" | "ask" | "plan";
  /**
   * When true, turns in ANY run mode (Auto/Ask/Plan) skip the
   * `maxModelIterations` / `maxTurnTokens` turn budgets. Default false.
   */
  composerInfinite?: boolean;
  /**
   * Composer reasoning-effort dial level ("off" | "low" | "medium" |
   * "high" | "max"); chat turns always send it explicitly. Restored on
   * app start. Default "low". Legacy boolean `reasoningEffortMax`
   * migrates: true → "max", false → "low".
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * When true, composers (New Task + conversations) start in voice input
   * mode (⌥⌃). App-wide and restored on app start. Default false.
   */
  composerVoiceMode?: boolean;
  /** Model-facing context window limit. Default 128000. */
  contextLimitTokens?: number;
  /**
   * Compact when decision tokens ≥ floor(contextLimitTokens * ratio).
   * Default 0.85.
   */
  compactTriggerRatio?: number;
  /**
   * iterationProtectV1: newest model iterations kept fully raw.
   * Default 20.
   */
  iterationProtectRawIterationCount?: number;
  /**
   * iterationProtectV1: protect while cumulative protected tokens
   * < floor(contextLimitTokens * ratio). Default 0.2.
   */
  iterationProtectTokenRatio?: number;
  /** Max model→tools→model iterations per turn. Default 128. */
  maxModelIterations?: number;
  /**
   * Max billable tokens per user turn (sum of provider total_tokens per iteration).
   * Default 3_000_000. Hitting the cap prompts Continue (resume with a fresh
   * budget) / Stop via ask_user.
   */
  maxTurnTokens?: number;
  /**
   * Per-attempt wall-clock timeout (ms) for chat LLM requests — how long to
   * wait for the request to be accepted (connect + response headers).
   * Streaming bodies are never cut off. Bounds 1_000–600_000; default
   * {@link DEFAULT_LLM_REQUEST_TIMEOUT_MS}.
   */
  llmRequestTimeoutMs?: number;
  /** Process-restored active workspace for New Task. */
  activeWorkspaceId?: string | null;
  /** Optional override of the bundled Larry lldb-dap (Windows extraResources). */
  debugAdapterPath?: string | null;
  /**
   * Which live Environment fields to inject before the base system prompt.
   * Omitted fields default to true. All false → skip Environment message.
   */
  environmentContext?: Partial<EnvironmentContextFlags>;
  /**
   * When true (default), after a successful agent turn the app may run a
   * background LLM pass to merge durable user facts into user-memory.json.
   */
  userMemoryAutoExtract?: boolean;
  /**
   * When true (default), after a successful agent turn the app may run a
   * background LLM pass to update `{workspace}/PROJECT.md`.
   */
  projectMemoryAutoExtract?: boolean;
  /**
   * When true (default), persist every tool invocation to SQLite for Dev Tools
   * stats (separate from agentLog).
   */
  toolStatsEnabled?: boolean;
  /**
   * Renderer theme id. Unknown values fall back to the default theme.
   * Default `dark` (the classic look).
   */
  themeId?: "dark" | "light";
  /**
   * Highlight color override (Settings → Appearance): preset id
   * ({@link ACCENT_COLOR_PRESET_IDS}), custom `#rrggbb` hex, or unset
   * (Auto — follow the theme default accent). Invalid values read as Auto.
   */
  accentColor?: string | null;
  /**
   * Interface text scale (Settings → Appearance → Text size): whole-UI zoom
   * factor applied via webFrame. Unset/invalid = 1 (100%). Clamp 0.8–1.5.
   */
  uiFontScale?: number;
  /**
   * Conversation text scale (Settings → Appearance → Text size): extra
   * multiplier on message prose / code / diffs / composer text via the
   * `--chat-fs-scale` CSS variable. Unset/invalid = 1 (100%). Clamp 0.8–1.6.
   */
  chatFontScale?: number;
  /**
   * Remote relay bridge (web console at remote.jellybot.cloud). The shared
   * API key is NOT stored here — it lives in the macOS Keychain under the
   * JellyBot service (account `api-key:remote-relay`).
   */
  remote?: RemoteRelaySettings;
};

/** Remote relay bridge configuration (Settings → Remote Control). */
export type RemoteRelaySettings = {
  /** Master switch. Off: the app never contacts the relay server. */
  enabled: boolean;
  /** Base WS origin, e.g. `wss://your-relay-host` (no trailing slash). Empty
   *  until the user configures their own relay — never defaulted. */
  serverUrl: string;
  /** Stable device identity shown in the web console. */
  deviceId: string;
  /** Friendly device name (defaults to hostname in the bridge). */
  deviceName: string;
  /** `readonly`: view-only; `full`: remote can send messages / answer asks. */
  mode: "readonly" | "full";
  /** Which sessions stream events to the relay. Default `all`. */
  pushActivity: "all" | "active" | "off";
  /** Cross-device memory sync (default off; docs/plans/memory-sync-design.md). */
  memorySync?: MemorySyncSettings | undefined;
};

/** Memory sync toggles (M2+: archive summaries; project docs land in M3). */
export type MemorySyncSettings = {
  /** Master switch — no sync traffic while false. */
  enabled: boolean;
  /** Push/pull deleted-session archive summaries (session_history done rows). */
  sessionArchive: boolean;
  /** WORKLOG/PITFALLS/STYLE entries (reserved for M3, surfaced in UI). */
  projectDocs: boolean;
};

/**
 * Normalize a raw `remote` settings value (disk JSON or IPC patch).
 * Returns undefined when absent/invalid — callers keep the field optional.
 */
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

/** Per-field toggles for the ephemeral Environment system message. */
export type EnvironmentContextFlags = {
  workspace: boolean;
  timezone: boolean;
  locale: boolean;
  /** System timezone + region (not GPS). */
  location: boolean;
};

export const DEFAULT_ENVIRONMENT_CONTEXT_FLAGS: EnvironmentContextFlags = {
  workspace: true,
  timezone: true,
  locale: true,
  location: true,
};

/** Legacy per-folder settings/db directory (migration source only). */
export const WORKSPACE_SETTINGS_DIR = ".jellybot";
/** App-level settings filename under Electron userData. */
export const WORKSPACE_SETTINGS_FILE = "settings.json";

export const DEFAULT_CONTEXT_LIMIT_TOKENS = 128_000;
export const DEFAULT_MAX_MODEL_ITERATIONS = 128;
/** Max billable tokens (Σ total_tokens) per user turn. */
export const DEFAULT_MAX_TURN_TOKENS = 3_000_000;

/**
 * Moonshot / Kimi server hosts (api.moonshot.cn/.ai and the newer unified
 * api.kimi.com — Kimi is Moonshot's product; the coding plan lives there).
 * Vision models there reject external https image URLs — only base64 data
 * URIs and `ms://<file-id>` references work.
 */
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

/**
 * Whether the chat provider for a turn accepts URL-based image input
 * (multimodal). Only such providers get https `image_url` wire parts.
 * Moonshot/Kimi servers never qualify — they cannot fetch external images.
 */
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

/**
 * Whether the chat provider is multimodal but requires base64 data-URI
 * image input (e.g. Moonshot/Kimi cannot fetch external image URLs).
 */
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

/**
 * Whether the chat provider is multimodal and images go through the
 * provider's own files API (Moonshot/Kimi `ms://<file-id>` references).
 * Moonshot-only by design: each provider's files protocol is bespoke.
 */
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

/** Compact when estimated tokens ≥ floor(limit * ratio). */
export const DEFAULT_COMPACT_TRIGGER_RATIO = 0.55;
/** iterationProtectV1: newest raw model iterations. */
export const DEFAULT_ITERATION_PROTECT_RAW_ITERATION_COUNT = 20;
/** iterationProtectV1: protect cumulative token fraction of context limit. */
export const DEFAULT_ITERATION_PROTECT_TOKEN_RATIO = 0.2;
/** Post-compact hard-truncate keeps newest conversation within this fraction of the limit. */
export const DEFAULT_HARD_TRUNCATE_RATIO = 0.8;
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL_ID = "gpt-4o-mini";
export const DEFAULT_PROVIDER_ID = "default";
export const DEFAULT_PROVIDER_NAME = "Default";

/** Stable provider id for the image-gen profile (store + settings). */
export const IMAGEGEN_PROVIDER_ID = "imagegen";

/**
 * Stable credential id for the object-storage (S3) secret key in the
 * encrypted key store. The Access Key ID itself is non-secret and lives in
 * settings.json; only the Secret Access Key is stored encrypted.
 */
export const OBJECT_STORAGE_CREDENTIAL_ID = "object-storage";

/** Object storage provider preset. Tencent COS is AWS SigV4-compatible. */
export type ObjectStorageProviderKind = "amazon" | "tencent";

/** How image URLs are handed to the LLM. */
export type ObjectStorageUrlMode = "presigned" | "public";

/**
 * S3-compatible object storage config (Amazon S3 / Tencent COS).
 * `secretAccessKey` intentionally absent — it lives in the encrypted key
 * store under {@link OBJECT_STORAGE_CREDENTIAL_ID}, never in settings.json.
 */
export type ObjectStorageConfig = {
  provider: ObjectStorageProviderKind;
  region: string;
  bucket: string;
  /** Non-secret access key id (safe to persist). */
  accessKeyId: string;
  /**
   * Optional custom endpoint base (e.g. COS `<bucket>-<appid>.cos.<region>.myqcloud.com`
   * or a CDN domain). When omitted, the provider preset builds the endpoint.
   */
  endpoint?: string;
  /** Object key prefix, normalized to end with `/` (e.g. `jellybot/`). */
  keyPrefix?: string;
  /** `presigned` (default, 7-day signed GET) or `public` (bucket public-read). */
  urlMode?: ObjectStorageUrlMode;
  /** Master switch for the upload pipeline. Default true once configured. */
  enabled?: boolean;
};
export const DEFAULT_IMAGEGEN_PROVIDER_NAME = "ImageGen";
/** Draft/placeholder default: Zhipu OpenAI-compatible image generation. */
export const DEFAULT_IMAGEGEN_BASE_URL =
  "https://open.bigmodel.cn/api/paas/v4";
export const DEFAULT_IMAGEGEN_MODEL_ID = "cogview-4-250304";

export {
  configurePromptDefaults,
  getDefaultCompactIterationProtectPrompt,
  getDefaultSessionArchiveSummarizePrompt,
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

/**
 * Effective USER.md body for injection: non-empty user-memory profile,
 * otherwise the markdown default from resources/prompts/USER.md.
 */
export function resolveUserPrompt(
  profile: string | null | undefined,
): string {
  const trimmed = typeof profile === "string" ? profile.trim() : "";
  if (trimmed.length > 0) {
    return clampSystemPrompt(trimmed);
  }
  return getDefaultUserPrompt();
}

/**
 * Effective PROJECT.md body for injection: non-empty workspace PROJECT.md,
 * otherwise the markdown default from resources/prompts/PROJECT.md.
 */
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

/** Resolve Environment injection flags; missing keys default to true. */
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
  };
}

/** Normalize a partial / unknown object into full flags (defaults true). */
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

/**
 * Resolve the vision fallback provider: the chat provider referenced by
 * `visionProviderId`, required to have Multimodal enabled. Returns null
 * when unset, the provider is missing, or Multimodal was turned off —
 * vision simply stays disabled instead of erroring. Credentials resolve
 * by the provider's own id (shared chat key slot + `.env` fallback).
 */
export function resolveVisionProvider(
  settings: WorkspaceSettings | null | undefined,
): LlmProvider | null {
  const resolved = withSettingsDefaults(settings);
  const id = resolved.visionProviderId;
  if (!id) return null;
  const provider = resolved.providers.find((p) => p.id === id);
  return provider?.supportsMultimodal === true ? provider : null;
}

/**
 * Resolve the active image-gen profile, or null when none is configured.
 * The returned entry's `id` is the credential-lookup key in the encrypted
 * key store.
 */
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

function normalizeVisionProviderId(
  value: unknown,
  providers: LlmProvider[],
): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return providers.some((p) => p.id === id) ? id : null;
}

/** Normalize/validate image-gen profile entries; invalid ones are dropped. */
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

/**
 * Normalize a raw object-storage config object; null when required fields
 * are missing. `secretAccessKey` is never read here — it belongs to the
 * encrypted key store.
 */
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

/** Resolve the object-storage config, or null when not configured. */
export function resolveObjectStorageConfig(
  settings: WorkspaceSettings | null | undefined,
): ObjectStorageConfig | null {
  return withSettingsDefaults(settings).objectStorage;
}

/** Effective object-storage config (enabled + complete) or null. */
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
  /** Vision fallback provider id (Multimodal-required), or null when unset. */
  visionProviderId: string | null;
  /** Text-to-image profiles; empty when unset. */
  imageGenProviders: ImageGenProvider[];
  /** Active text-to-image profile id; "" when the list is empty. */
  activeImageGenProviderId: string;
  /** Object storage (S3/COS) config, or null when unset. */
  objectStorage: ObjectStorageConfig | null;
  fullPermissionsDefault: boolean;
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
  /** Chat request headers-wait timeout (ms). Default 30_000. */
  llmRequestTimeoutMs: number;
  activeWorkspaceId: string | null;
  /** Optional override of the bundled Larry lldb-dap, or null when unset. */
  debugAdapterPath: string | null;
  /** Which Environment fields to inject each model iteration. */
  environmentContext: EnvironmentContextFlags;
  /** Auto-update user-memory.json after successful turns (default true). */
  userMemoryAutoExtract: boolean;
  /** Auto-update `{workspace}/PROJECT.md` after successful turns (default true). */
  projectMemoryAutoExtract: boolean;
  /** Persist tool invocations to SQLite for Dev Tools stats (default true). */
  toolStatsEnabled: boolean;
  /** Renderer theme id. Default `dark` (the classic look). */
  themeId: "dark" | "light";
  /** Highlight color override; null = Auto (theme default accent). */
  accentColor: string | null;
  /** Interface text scale factor (whole-UI zoom); 1 = 100%. */
  uiFontScale: number;
  /** Conversation text scale factor (`--chat-fs-scale`); 1 = 100%. */
  chatFontScale: number;
  /** Remote relay bridge config, present once configured (Settings → Remote). */
  remote?: RemoteRelaySettings;
};

/**
 * Convert resolved settings back to a writable WorkspaceSettings payload.
 * Use when rewriting settings.json so sparse fields are not dropped.
 */
export function resolvedToWorkspaceSettings(
  resolved: ResolvedWorkspaceSettings,
  overrides?: Partial<WorkspaceSettings>,
): WorkspaceSettings {
  const payload: WorkspaceSettings = {
    providers: resolved.providers,
    activeProviderId: resolved.activeProviderId,
    fullPermissionsDefault: resolved.fullPermissionsDefault,
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
    toolStatsEnabled: resolved.toolStatsEnabled,
    themeId: resolved.themeId,
    ...(resolved.remote ? { remote: resolved.remote } : {}),
    ...(resolved.accentColor ? { accentColor: resolved.accentColor } : {}),
    // Font scales stay sparse at the default so settings.json stays minimal.
    ...(resolved.uiFontScale !== 1
      ? { uiFontScale: resolved.uiFontScale }
      : {}),
    ...(resolved.chatFontScale !== 1
      ? { chatFontScale: resolved.chatFontScale }
      : {}),
    visionProviderId: resolved.visionProviderId ?? null,
    imageGenProviders: resolved.imageGenProviders,
    activeImageGenProviderId: resolved.activeImageGenProviderId,
    objectStorage: resolved.objectStorage ?? null,
  };
  return { ...payload, ...overrides };
}

/** Fill missing fields for UI / runtime. Always ≥1 provider. */
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

  const visionProviderId = normalizeVisionProviderId(
    settings?.visionProviderId,
    providers,
  );

  return {
    providers,
    activeProviderId,
    visionProviderId,
    imageGenProviders,
    activeImageGenProviderId,
    objectStorage: normalizeObjectStorageConfig(
      settings?.objectStorage ?? null,
    ),
    fullPermissionsDefault: settings?.fullPermissionsDefault === true,
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
    toolStatsEnabled: settings?.toolStatsEnabled !== false,
    ...(settings?.remote ? { remote: settings.remote } : {}),
    themeId: resolveThemeId(settings),
    accentColor: resolveAccentColor(settings),
    uiFontScale: resolveUiFontScale(settings),
    chatFontScale: resolveChatFontScale(settings),
  };
}

/**
 * Persisted highlight-color preset ids. Mirrors the renderer's
 * state/theme.ts ACCENT_PRESETS (the visual source of truth — main only
 * validates ids, never resolves colors). Kept in sync by test.
 */
export const ACCENT_COLOR_PRESET_IDS: readonly string[] = [
  "teal",
  "blue",
  "violet",
  "rose",
  "amber",
  "sapphire",
];

/**
 * Validate/normalize a persisted highlight color: preset id verbatim,
 * custom hex lowercased; anything else (incl. "auto") → null (Auto).
 */
export function normalizeAccentColorValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (ACCENT_COLOR_PRESET_IDS.includes(value)) return value;
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  return null;
}

/** Effective highlight color override; null = Auto (theme default). */
export function resolveAccentColor(
  settings: WorkspaceSettings | null | undefined,
): string | null {
  return normalizeAccentColorValue(settings?.accentColor);
}

/**
 * Validate a persisted font-scale factor: finite number clamped to
 * [min, max]; anything else falls back (default 1 = 100%).
 */
export function normalizeFontScale(
  value: unknown,
  fallback = 1,
  min = 0.8,
  max = 1.6,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Interface text scale (whole-UI zoom). Presets live in 0.9–1.3. */
export function resolveUiFontScale(
  settings: WorkspaceSettings | null | undefined,
): number {
  return normalizeFontScale(settings?.uiFontScale, 1, 0.8, 1.5);
}

/** Conversation text scale (`--chat-fs-scale`). Presets live in 0.9–1.5. */
export function resolveChatFontScale(
  settings: WorkspaceSettings | null | undefined,
): number {
  return normalizeFontScale(settings?.chatFontScale, 1, 0.8, 1.6);
}

/**
 * Validate a persisted theme id; unknown values fall back to `dark`.
 * Legacy `graphite` ids land here too — the theme was removed, so its
 * settings silently migrate to dark.
 */
export function resolveThemeId(
  settings: WorkspaceSettings | null | undefined,
): "dark" | "light" {
  const value = settings?.themeId;
  if (value === "light" || value === "dark") {
    return value;
  }
  return "dark";
}

/** Normalize composer Auto / Ask / Plan mode from settings JSON. */
export function normalizeComposerRunMode(
  value: unknown,
): "agent" | "ask" | "plan" {
  if (value === "plan" || value === "ask" || value === "agent") {
    return value;
  }
  // Legacy 4th mode; readWorkspaceSettings migrates it with the switch on.
  if (value === "infinite") return "plan";
  return "agent";
}
