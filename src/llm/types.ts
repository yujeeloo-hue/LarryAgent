import type { JsonObject, ModelResponsePart } from "../session/types.js";
import type { LlmApiProtocol } from "./apiProtocol.js";
import type { ReasoningEffort } from "./reasoningEffort.js";

export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 30_000;

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

export type OpenAiChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAiContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
  reasoning_content?: string;
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

export type OpenAiToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: JsonObject;
    strict?: boolean;
  };
};

export type JsonSchemaResponseFormat = {
  type: "json_schema";
  json_schema: {
    name: string;
    strict: boolean;
    schema: JsonObject;
  };
};

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
  responsesTools?: JsonObject[];
  responsesStateful?: boolean;
  onResponsesStatefulDisabled?: (
    reason: "store_rejected" | "previous_response_id_rejected",
  ) => void | Promise<void>;
  rawEndpoint?: boolean;
  reasoningEffort?: ReasoningEffort;
  disableReasoning?: boolean;
  requestTimeoutMs?: number;
};

export type LlmRequestMeta = {
  sessionId?: string;
  iteration?: number;
  purpose?:
    | "chat"
    | "compact"
    | "compact-warm"
    | "compact-iteration-protect"
    | "topic_boundary"
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
    | "branch_merge"
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
    noRetry?: boolean;
  };
  signal?: AbortSignal;
  timeoutMs?: number;
  extraBody?: JsonObject;
  extraHeaders?: Record<string, string>;
  promptCacheKey?: string;
  meta?: LlmRequestMeta;
  maxAttempts?: number;
};
