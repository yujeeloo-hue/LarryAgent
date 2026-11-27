import { countTokens } from "gpt-tokenizer";
import type {
  OpenAiChatMessage,
  OpenAiToolDefinition,
} from "../llm/types.js";
import type { MessagePart } from "../session/types.js";
import type { ContextUsageBreakdown, ContextUsageCategory } from "../shared/contextUsageBreakdown.js";
import { formatAttachmentWireStub } from "./attachmentWireText.js";
import { contextMessageCategories } from "./contextMessageCategory.js";
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
  return estimateNativeResponseCosts(message).total;
}

function estimateNativeResponseCosts(message: OpenAiChatMessage): { total: number; tools: number } {
  const native = message.responsesOutput;
  let chars = 0;
  let toolChars = 0;
  if (native) {
    for (const item of [...native.output, ...(native.continuationInput ?? [])]) {
      if (item.type === "message") continue;
      try {
        const length = JSON.stringify(item).length;
        chars += length;
        if (item.type !== "reasoning") toolChars += length;
      } catch { }
    }
  }
  return { total: Math.ceil(chars / 4), tools: Math.ceil(toolChars / 4) };
}

function addContextTokens(breakdown: ContextUsageBreakdown, category: ContextUsageCategory, tokens: number): void {
  if (tokens > 0) breakdown[category] = (breakdown[category] ?? 0) + tokens;
}

export function estimateTokensForMessages(
  messages: OpenAiChatMessage[],
  breakdown?: ContextUsageBreakdown,
): number {
  if (messages.length === 0) return 0;
  let tokens = REPLY_PRIMING_TOKENS;
  if (breakdown) addContextTokens(breakdown, "conversation", REPLY_PRIMING_TOKENS);
  for (const message of messages) {
    let body = MESSAGE_TOKEN_OVERHEAD + estimateTokensFromText(message.role);
    body += estimateTokensFromText(contentToText(message.content));
    if (message.name) body += estimateTokensFromText(message.name) + 1;
    if (message.tool_call_id) body += estimateTokensFromText(message.tool_call_id);

    let calls = 0;
    for (const call of message.tool_calls ?? []) {
      calls += estimateTokensFromText(call.id);
      calls += estimateTokensFromText(call.type ?? "function");
      calls += estimateTokensFromText(call.function.name);
      calls += estimateTokensFromText(call.function.arguments);
    }
    const reasoning = typeof message.reasoning_content === "string"
      ? estimateTokensFromText(message.reasoning_content)
      : 0;
    const native = estimateNativeResponseCosts(message);
    tokens += body + calls + reasoning + native.total;

    if (breakdown) {
      const category = contextMessageCategories.get(message) ??
        (message.role === "system" ? "systemPrefix" : message.role === "tool" ? "toolActivity" : "conversation");
      // Native Responses replay can carry the same call and reasoning already represented in the transcript.
      addContextTokens(breakdown, category, body + Math.max(reasoning, native.total - native.tools));
      addContextTokens(breakdown, "toolActivity", Math.max(calls, native.tools));
    }
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
  breakdown?: ContextUsageBreakdown;
};

export function estimateTokensForRequest(
  messages: OpenAiChatMessage[],
  tools?: readonly unknown[],
  includeBreakdown = false,
): RequestTokenEstimate {
  const breakdown = includeBreakdown ? {} : undefined;
  const messageTokens = estimateTokensForMessages(messages, breakdown);
  const toolTokens = estimateTokensForTools(tools);
  if (breakdown) addContextTokens(breakdown, "toolDefinitions", toolTokens);
  const raw = messageTokens + toolTokens;
  return {
    raw,
    messages: messageTokens,
    tools: toolTokens,
    decision: raw,
    ...(breakdown ? { breakdown } : {}),
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

