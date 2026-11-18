import { countTokens } from "gpt-tokenizer";
import type {
  OpenAiChatMessage,
  OpenAiToolDefinition,
} from "../llm/types.js";
import type { MessagePart } from "../session/types.js";
import { formatAttachmentWireStub } from "./attachmentWireText.js";
import { formatTurnContextForWire } from "./turnContextWire.js";


const MESSAGE_TOKEN_OVERHEAD = 3;
const REPLY_PRIMING_TOKENS = 3;

const TOKEN_CACHE_MIN_CHARS = 256;
const TOKEN_CACHE_MAX_CHARS = 8_000_000;
const tokenCache = new Map<string, number>();
let tokenCacheChars = 0;

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

export function estimateTokensForUserParts(parts: MessagePart[]): number {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      chunks.push(part.text);
    } else if (part.type === "attachment") {
      chunks.push(formatAttachmentWireStub(part));
    } else if (part.type === "turn_context") {
      chunks.push(formatTurnContextForWire(part));
    }
  }
  return estimateTokensFromText(chunks.join("\n"));
}

function contentToText(
  content: OpenAiChatMessage["content"],
): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  const chunks: string[] = [];
  for (const part of content) {
    if (part.type === "text") chunks.push(part.text);
  }
  return chunks.join("\n");
}

export function estimateNativeResponseTokens(message: OpenAiChatMessage): number {
  const native = message.responsesOutput;
  if (!native) return 0;
  let chars = 0;
  for (const item of [...native.output, ...(native.continuationInput ?? [])]) {
    if (item.type === "message") continue;
    try { chars += JSON.stringify(item).length; } catch {  }
  }
  return Math.ceil(chars / 4);
}

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
  raw: number;
  messages: number;
  tools: number;
  decision: number;
};

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

const LEGACY_PROVIDER_DRIFT_RATIO = 2;

export type DecisionTokens = {
  decisionTokens: number;
  source: DecisionTokenSource;
};

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

