import type { chatCompletionOnce } from "../../llm/openaiCompatibleClient.js";
import type { StreamEvent } from "../../llm/streamEvents.js";
import type {
  OpenAiCompatibleClientConfig,
  OpenAiChatMessage,
  OpenAiToolDefinition,
} from "../../llm/types.js";
import type { Message, Session } from "../../session/types.js";

export type CompactionStrategyId = "iterationProtectV1";

export const DEFAULT_COMPACTION_STRATEGY_ID: CompactionStrategyId = "iterationProtectV1";

/** Shared knobs passed into build / refresh / compact. */
export type CompactionBuildConfig = {
  /** Only this binding's reasoning may be echoed on the wire. */
  reasoningScope?: string;
  /** Used by protect-zone walks when assembling the wire window. */
  contextLimitTokens?: number;
  /** iterationProtectV1: newest raw model iterations to protect. */
  iterationProtectRawIterationCount?: number;
  /** iterationProtectV1: protect while cumulative tokens < limit * ratio. */
  iterationProtectTokenRatio?: number;
  /**
   * When true, user messages with S3-uploaded image attachments render as
   * multimodal `image_url` content parts (chat provider accepts URL images).
   */
  imageUrls?: boolean;
  /**
   * When true, tool results carrying image attachments with `s3.url` render
   * as multimodal `image_url` parts inside the tool message content array
   * (read_image direct — chat provider accepts tool-role images).
   */
  toolRoleImages?: boolean;
};

export type CompactBeforeIterationInput = {
  session: Session;
  client: OpenAiCompatibleClientConfig;
  createId: () => string;
  contextLimitTokens: number;
  compactTriggerRatio?: number;
  /**
   * Manual /compact: skip the compactTriggerRatio threshold gate. Strategy
   * guards that reject when there is nothing new to summarize still apply.
   */
  force?: boolean;
  tools?: OpenAiToolDefinition[];
  /**
   * Full model-facing BPE estimate (system prefix + conversation + trailing
   * overlay + tools). Host computes this once so compact and hard-truncate
   * share the same estimate fallback when no provider usage is available.
   */
  windowEstimateTokens?: number;
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
  summarize?: typeof chatCompletionOnce;
  /** iterationProtectV1 */
  iterationProtectRawIterationCount?: number;
  iterationProtectTokenRatio?: number;
  iterationProtectSummarizePrompt?: string;
};

export type CompactContextResult =
  | { compacted: false; estimatedTokens: number }
  | { compacted: true; estimatedTokens: number }
  | { compacted: false; estimatedTokens: number; error: string };

export type ContextCompactionStrategy = {
  id: CompactionStrategyId;
  maybeCompactBeforeIteration(
    input: CompactBeforeIterationInput,
  ): Promise<CompactContextResult>;
  buildModelMessages(
    messages: Message[],
    config?: CompactionBuildConfig,
  ): OpenAiChatMessage[];
  refreshSessionCompactionState(
    session: Session,
    config?: CompactionBuildConfig,
  ): void;
};
