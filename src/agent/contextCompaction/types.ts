import type { chatCompletionOnce } from "../../llm/openaiCompatibleClient.js";
import type { StreamEvent } from "../../llm/streamEvents.js";
import type {
  OpenAiCompatibleClientConfig,
  OpenAiChatMessage,
  OpenAiToolDefinition,
} from "../../llm/types.js";
import type { Message, Session, SessionPlan } from "../../session/types.js";

export type CompactionStrategyId = "iterationProtectV1";

export const DEFAULT_COMPACTION_STRATEGY_ID: CompactionStrategyId = "iterationProtectV1";

export type CompactionBuildConfig = {
  reasoningScope?: string;
  contextLimitTokens?: number;
  iterationProtectRawIterationCount?: number;
  iterationProtectTokenRatio?: number;
  imageUrls?: boolean;
  toolRoleImages?: boolean;
  activePlan?: SessionPlan | null;
};

export type CompactBeforeIterationInput = {
  session: Session;
  client: OpenAiCompatibleClientConfig;
  createId: () => string;
  contextLimitTokens: number;
  compactTriggerRatio?: number;
  force?: boolean;
  tools?: OpenAiToolDefinition[];
  windowEstimateTokens?: number;
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
  summarize?: typeof chatCompletionOnce;
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
