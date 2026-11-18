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

export interface LlmApiAdapter {
  readonly id: ResolvedLlmApiProtocol;
  hostedTools(client: OpenAiCompatibleClientConfig): readonly JsonObject[];
  messagesForBinding(
    messages: readonly OpenAiChatMessage[],
    builtScope: string | undefined,
    client: OpenAiCompatibleClientConfig,
  ): OpenAiChatMessage[];
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
  prepareServerContext(
    messages: readonly OpenAiChatMessage[],
    client: OpenAiCompatibleClientConfig,
  ): ServerContinuation | undefined;
  matchesReplayScope(client: OpenAiCompatibleClientConfig, scope: string): boolean;
}
