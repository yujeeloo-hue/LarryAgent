/**
 * Business window handed from the turn to an API adapter.
 *
 * The message shape is still the canonical chat window (`OpenAiChatMessage`).
 * Chat Completions and Responses adapters translate it at request time.
 * Graph actions consume bindings and do not choose an API.
 */
import type { JsonObject } from "../session/types.js";
import type { ResolvedLlmApiProtocol } from "./apiProtocol.js";
import type { StreamEvent } from "./streamEvents.js";
import type {
  ChatResponseFormat,
  LlmRequestMeta,
  OpenAiChatMessage,
  OpenAiCompatibleClientConfig,
  StreamChatOptions,
} from "./types.js";

export type CanonicalChatMessage = OpenAiChatMessage;

export type LlmCompleteOptions = {
  messages: OpenAiChatMessage[];
  signal?: AbortSignal;
  timeoutMs?: number;
  extraBody?: JsonObject;
  extraHeaders?: Record<string, string>;
  responseFormat?: ChatResponseFormat;
  promptCacheKey?: string;
  meta?: LlmRequestMeta;
  onProgress?: (text: string) => void;
};

export type LlmCompleteResult = {
  content: string;
};

export type ServerContinuation = {
  fullInput: JsonObject[];
  input: JsonObject[];
  previousResponseId?: string;
};

/** One provider API. Read and write of that API's wire stay inside its adapter. */
export interface LlmApiAdapter {
  readonly id: ResolvedLlmApiProtocol;
  hostedTools(client: OpenAiCompatibleClientConfig): readonly JsonObject[];
  messagesForBinding(
    messages: readonly OpenAiChatMessage[],
    builtScope: string | undefined,
    client: OpenAiCompatibleClientConfig,
  ): OpenAiChatMessage[];
  /** Provider reasoning dials. Responses maps those on its own request body. */
  requestExtraBody(
    client: OpenAiCompatibleClientConfig,
    extra?: JsonObject,
  ): JsonObject | undefined;
  stream(
    config: OpenAiCompatibleClientConfig,
    options: StreamChatOptions,
  ): AsyncGenerator<StreamEvent, void, undefined>;
  complete(
    config: OpenAiCompatibleClientConfig,
    options: LlmCompleteOptions,
  ): Promise<LlmCompleteResult>;
  /** Server-side continuation for this API. Absent when the API has none. */
  prepareServerContext(
    messages: readonly OpenAiChatMessage[],
    client: OpenAiCompatibleClientConfig,
  ): ServerContinuation | undefined;
  /** Whether this API owns a stored replay blob for the given binding scope. */
  matchesReplayScope(client: OpenAiCompatibleClientConfig, scope: string): boolean;
}
