import { countTokens } from "gpt-tokenizer";
import type {
  OpenAiChatMessage,
  OpenAiToolDefinition,
} from "../llm/types.js";
import type { MessagePart } from "../session/types.js";
import { formatAttachmentWireStub } from "./attachmentWireText.js";

/**
 * Default `gpt-tokenizer` encoding is `o200k_base` (GPT-4o / modern OpenAI).
 * Third-party OpenAI-compatible models may differ slightly; provider
 * `prompt_tokens` remains the authority once available.
 */

/** Per-message framing used by OpenAI chat completions (cl100k / o200k). */
const MESSAGE_TOKEN_OVERHEAD = 3;
/** Priming tokens for the assistant reply slot. */
const REPLY_PRIMING_TOKENS = 3;

/**
 * Every model iteration re-estimates the whole window, and almost all of it is
 * transcript text already counted on earlier iterations. BPE runs synchronously
 * on the main process, so long bodies are memoized by content (LRU, bounded by
 * total cached characters).
 */
const TOKEN_CACHE_MIN_CHARS = 256;
const TOKEN_CACHE_MAX_CHARS = 8_000_000;
const tokenCache = new Map<string, number>();
let tokenCacheChars = 0;

/** Count BPE tokens for a UTF-8 string (`o200k_base`). */
export function estimateTokensFromText(text: string): number {
  if (text.length === 0) return 0;
  if (text.length < TOKEN_CACHE_MIN_CHARS) return countTokens(text);
  const cached = tokenCache.get(text);
  if (cached !== undefined) {
    tokenCache.delete(text);
    tokenCache.set(text, cached);
    return cached;
  }
  const tokens = countTokens(text);
  if (text.length > TOKEN_CACHE_MAX_CHARS / 4) return tokens;
  tokenCache.set(text, tokens);
  tokenCacheChars += text.length;
  for (const [key] of tokenCache) {
    if (tokenCacheChars <= TOKEN_CACHE_MAX_CHARS) break;
    tokenCache.delete(key);
    tokenCacheChars -= key.length;
  }
  return tokens;
}

/**
 * Estimate tokens for a user message's parts (text + attachment path stubs),
 * matching the model-facing attachment wording in `messagesToOpenAi`.
 */
export function estimateTokensForUserParts(parts: MessagePart[]): number {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      chunks.push(part.text);
    } else if (part.type === "attachment") {
      chunks.push(formatAttachmentWireStub(part));
    }
  }
  return estimateTokensFromText(chunks.join("\n"));
}

function contentToText(
  content: OpenAiChatMessage["content"],
): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  // Multimodal parts: count text only (images are path stubs in our wire format).
  const chunks: string[] = [];
  for (const part of content) {
    if (part.type === "text") chunks.push(part.text);
  }
  return chunks.join("\n");
}

/**
 * Native Responses items replace the visible assistant body on the wire.
 * Visible `message` items are already counted via `content`; the rest
 * (encrypted reasoning, hosted outputs, base64 images) use ~4 chars/token.
 */
export function estimateNativeResponseTokens(message: OpenAiChatMessage): number {
  const native = message.responsesOutput;
  if (!native) return 0;
  let chars = 0;
  for (const item of [...native.output, ...(native.continuationInput ?? [])]) {
    if (item.type === "message") continue;
    try { chars += JSON.stringify(item).length; } catch { /* Non-serializable items are not sent. */ }
  }
  return Math.ceil(chars / 4);
}

/** Estimate tokens for OpenAI-compatible chat messages (BPE + chat framing). */
export function estimateTokensForMessages(
  messages: OpenAiChatMessage[],
): number {
  if (messages.length === 0) return 0;
  let tokens = REPLY_PRIMING_TOKENS;
  for (const message of messages) {
    tokens += MESSAGE_TOKEN_OVERHEAD;
    tokens += estimateTokensFromText(message.role);
    const body = contentToText(message.content);
    if (body.length > 0) {
      tokens += estimateTokensFromText(body);
    }
    if (message.name) {
      tokens += estimateTokensFromText(message.name) + 1;
    }
    if (message.tool_call_id) {
      tokens += estimateTokensFromText(message.tool_call_id);
    }
    if (message.tool_calls) {
      for (const call of message.tool_calls) {
        tokens += estimateTokensFromText(call.id);
        tokens += estimateTokensFromText(call.type ?? "function");
        tokens += estimateTokensFromText(call.function.name);
        if (call.function.arguments.length > 0) {
          tokens += estimateTokensFromText(call.function.arguments);
        }
      }
    }
    if (
      typeof message.reasoning_content === "string" &&
      message.reasoning_content.length > 0
    ) {
      tokens += estimateTokensFromText(message.reasoning_content);
    }
    tokens += estimateNativeResponseTokens(message);
  }
  return tokens;
}

/** Estimate tokens for the tools array sent with chat/completions. */
export function estimateTokensForTools(
  tools: readonly unknown[] | undefined,
): number {
  if (!tools || tools.length === 0) return 0;
  try {
    return estimateTokensFromText(JSON.stringify(tools));
  } catch {
    return 0;
  }
}

export type RequestTokenEstimate = {
  /** Total BPE estimate for messages + tools. */
  raw: number;
  messages: number;
  tools: number;
  /** Same as `raw` — used for compact trigger when no provider usage yet. */
  decision: number;
};

/**
 * Estimate model-facing request size via `gpt-tokenizer` (`o200k_base`).
 * Prefer provider `prompt_tokens` for compact triggers once available.
 */
export function estimateTokensForRequest(
  messages: OpenAiChatMessage[],
  tools?: readonly unknown[],
): RequestTokenEstimate {
  const messageTokens = estimateTokensForMessages(messages);
  const toolTokens = estimateTokensForTools(tools);
  const raw = messageTokens + toolTokens;
  return {
    raw,
    messages: messageTokens,
    tools: toolTokens,
    decision: raw,
  };
}

export type DecisionTokenSource = "provider" | "estimate";

/** Local o200k overcounts third-party tokenizers by up to ~1.6×; beyond 2× the reading is from a smaller window. */
const LEGACY_PROVIDER_DRIFT_RATIO = 2;

export type DecisionTokens = {
  /** Value used to gate compact / hard-truncate. */
  decisionTokens: number;
  source: DecisionTokenSource;
};

/**
 * Shared gate for compaction and hard-truncate.
 *
 * Prefer the last provider `prompt_tokens` once available — local o200k_base
 * estimates can diverge substantially from third-party tokenizers (e.g. GLM
 * often ~1.2–1.6× lower than our estimate). Fall back to `estimateTokens`
 * (full model-facing window: system + conversation + overlay + tools) only
 * before the first provider usage, or right after a compact that resets the
 * session to an estimate.
 *
 * The provider reading measured one specific request. When the current window
 * is larger (that request was hard-truncated / turn-limited, or a large tool
 * result arrived since), the estimated growth is added on top. Legacy readings
 * without `requestEstimateTokens` fall back to the estimate once it exceeds
 * the reading by more than tokenizer drift can explain.
 */
export function resolveDecisionTokens(
  contextUsage: {
    usedTokens: number;
    source?: "provider" | "estimate";
    requestEstimateTokens?: number;
  },
  estimateTokens: number,
): DecisionTokens {
  if (contextUsage.source === "provider" && contextUsage.usedTokens > 0) {
    const base = contextUsage.requestEstimateTokens;
    if (typeof base === "number" && base > 0) {
      return {
        decisionTokens: contextUsage.usedTokens + Math.max(0, estimateTokens - base),
        source: "provider",
      };
    }
    if (estimateTokens > contextUsage.usedTokens * LEGACY_PROVIDER_DRIFT_RATIO) {
      return { decisionTokens: estimateTokens, source: "estimate" };
    }
    return {
      decisionTokens: contextUsage.usedTokens,
      source: "provider",
    };
  }
  return {
    decisionTokens: estimateTokens,
    source: "estimate",
  };
}

