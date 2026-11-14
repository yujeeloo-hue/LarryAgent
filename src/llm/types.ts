import type { JsonObject, ModelResponsePart } from "../session/types.js";
import type { LlmApiProtocol } from "./apiProtocol.js";
import type { ReasoningEffort } from "./reasoningEffort.js";

/**
 * Per-attempt wall-clock timeout for chat LLM requests (headers wait).
 * Canonical default lives here (type-level leaf module) so settings can
 * reference it without importing the fetch client.
 */
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 30_000;

/** OpenAI multimodal content parts (vision / image_url). */
export type OpenAiTextContentPart = {
  type: "text";
  text: string;
};

export type OpenAiImageUrlContentPart = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type OpenAiContentPart =
  | OpenAiTextContentPart
  | OpenAiImageUrlContentPart;

/** OpenAI-compatible chat message (wire format). */
export type OpenAiChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAiContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
  /**
   * Thinking / CoT from providers that require echo (e.g. DeepSeek thinking mode).
   * Must be passed back on assistant messages that originally returned it —
   * especially when those messages include `tool_calls`.
   */
  reasoning_content?: string;
  /** Local metadata; the Chat adapter strips it before sending messages. */
  responsesOutput?: Omit<ModelResponsePart, "type">;
};

export type OpenAiToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

/** OpenAI tools array item (function tool). */
export type OpenAiToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: JsonObject;
    /** Structured Outputs: default false for gateway compatibility. */
    strict?: boolean;
  };
};

/**
 * Chat Completions Structured Outputs `response_format`.
 * @see https://platform.openai.com/docs/guides/structured-outputs
 */
export type JsonSchemaResponseFormat = {
  type: "json_schema";
  json_schema: {
    name: string;
    /** Default false; set true only when the provider supports strict Structured Outputs. */
    strict: boolean;
    schema: JsonObject;
  };
};

/**
 * JSON mode without server-side schema (DeepSeek and many gateways).
 * Prefer this when `json_schema` is rejected; validate client-side.
 */
export type JsonObjectResponseFormat = {
  type: "json_object";
};

export type ChatResponseFormat =
  | JsonSchemaResponseFormat
  | JsonObjectResponseFormat;

export type OpenAiCompatibleClientConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  apiProtocol?: LlmApiProtocol;
  /** Hosted tools are offered only by the chat Host after Graph policy filtering. */
  responsesTools?: JsonObject[];
  /** Opt-in stored Responses with safe previous_response_id continuation. Default false. */
  responsesStateful?: boolean;
  /** Internal runtime persistence hook; never serialized into a provider request. */
  onResponsesStatefulDisabled?: (
    reason: "store_rejected" | "previous_response_id_rejected",
  ) => void | Promise<void>;
  /**
   * When true, `baseUrl` is the full chat endpoint — request it as-is
   * without appending `chat/completions`.
   */
  rawEndpoint?: boolean;
  /**
   * Composer reasoning-effort dial level. Chat requests get host-mapped
   * fields via `reasoningEffortExtraBody` ("off" reuses the disable
   * switches; Kimi/GLM hosts clamp "medium" → "high"). sessionRuntime
   * always resolves a concrete level for chat turns, so the field is never
   * left to the provider default. Title / memory / compact paths that call
   * the client directly should ignore this.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Ask mode: disable reasoning for faster responses. Chat requests get
   * provider-specific disable fields via `reasoningDisableExtraBody`
   * (e.g. DeepSeek `thinking: {type: "disabled"}`) + `reasoning_effort: "low"`.
   * TokenLink hosts instead get only `reasoning_effort: "no_think"`.
   * Takes precedence over `reasoningEffort` in the role binding.
   */
  disableReasoning?: boolean;
  /**
   * Per-attempt wall-clock timeout (ms) for chat requests — wait for the
   * request to be accepted (connect + response headers). Streaming bodies are
   * never cut off by this timer. Resolution order: per-request
   * `options.timeoutMs` → this config value → {@link DEFAULT_LLM_REQUEST_TIMEOUT_MS}.
   * Context compaction always passes its own 120s budget.
   */
  requestTimeoutMs?: number;
};

/** Optional correlation fields for diagnostic logs (never includes secrets). */
export type LlmRequestMeta = {
  sessionId?: string;
  iteration?: number;
  purpose?:
    | "chat"
    | "compact"
    | "compact-warm"
    | "compact-iteration-protect"
    | "session_archive_summarize"
    | "vision"
    | "image_generation"
    | "user_memory_extract"
    | "project_memory_extract"
    | "project_memory_summarize"
    | "skill_curation"
    | "plan_task_extract"
    | "session_title"
    | "commit_message"
    | "prompt_optimize"
    | "inline_completion";
};

export type StreamChatOptions = {
  messages: OpenAiChatMessage[];
  tools?: OpenAiToolDefinition[];
  nativeTools?: JsonObject[];
  responses?: {
    input?: JsonObject[];
    previousResponseId?: string;
    /** Internal: a Host recovery attempt must submit at most once. */
    noRetry?: boolean;
  };
  signal?: AbortSignal;
  /**
   * Per-attempt headers-wait timeout (ms). Falls back to
   * `config.requestTimeoutMs`, then DEFAULT_LLM_REQUEST_TIMEOUT_MS (30s).
   * Pass `0` to disable the wall-clock timer.
   */
  timeoutMs?: number;
  /** Extra body fields merged into the request (provider-specific). */
  extraBody?: JsonObject;
  /** Extra HTTP headers merged into the request (provider-specific). */
  extraHeaders?: Record<string, string>;
  /**
   * TokenHUB / OpenAI-compatible prompt cache key. When omitted, falls back to
   * `meta.sessionId` so multi-iteration turns can reuse KV cache.
   */
  promptCacheKey?: string;
  /** Correlation for agent file logs. */
  meta?: LlmRequestMeta;
  /**
   * Transport / HTTP retries. Default 3. Inline completion passes 1 —
   * a backoff retry is slower than typing the code.
   */
  maxAttempts?: number;
};
