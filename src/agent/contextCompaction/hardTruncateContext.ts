import type { OpenAiChatMessage } from "../../llm/types.js";
import { estimateNativeResponseTokens, estimateTokensFromText } from "../estimateTokens.js";

const MESSAGE_TOKEN_OVERHEAD = 3;

function contentToText(content: OpenAiChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  const chunks: string[] = [];
  for (const part of content) {
    if (part.type === "text") chunks.push(part.text);
  }
  return chunks.join("\n");
}

export function estimateOpenAiMessageTokens(
  message: OpenAiChatMessage,
): number {
  let tokens = MESSAGE_TOKEN_OVERHEAD;
  tokens += estimateTokensFromText(message.role);
  const body = contentToText(message.content);
  if (body.length > 0) {
    tokens +=
      body.length > 100_000
        ? Math.ceil(body.length / 4)
        : estimateTokensFromText(body);
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
        const args = call.function.arguments;
        tokens +=
          args.length > 100_000
            ? Math.ceil(args.length / 4)
            : estimateTokensFromText(args);
      }
    }
  }
  if (
    typeof message.reasoning_content === "string" &&
    message.reasoning_content.length > 0
  ) {
    const reasoning = message.reasoning_content;
    tokens +=
      reasoning.length > 100_000
        ? Math.ceil(reasoning.length / 4)
        : estimateTokensFromText(reasoning);
  }
  return tokens + estimateNativeResponseTokens(message);
}

function clipTextToApproxTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0 || text.length === 0) return "";
  const approxChars = Math.max(64, Math.floor(maxTokens * 4));
  if (text.length <= approxChars && text.length <= 20_000) {
    if (estimateTokensFromText(text) <= maxTokens) return text;
  }
  let clipped = text.slice(0, Math.min(text.length, approxChars));
  if (clipped.length <= 20_000) {
    let tokens = estimateTokensFromText(clipped);
    while (clipped.length > 64 && tokens > maxTokens) {
      clipped = clipped.slice(0, Math.floor(clipped.length * 0.85));
      tokens = estimateTokensFromText(clipped);
    }
  }
  const omitted = text.length - clipped.length;
  return omitted > 0
    ? `${clipped}\n…[hard-truncated +${omitted} chars]`
    : clipped;
}

function clipOpenAiMessageToBudget(
  message: OpenAiChatMessage,
  maxTokens: number,
): { message: OpenAiChatMessage; tokens: number } {
  const budget = Math.max(32, Math.floor(maxTokens));
  let current = { ...message };
  let tokens = estimateOpenAiMessageTokens(current);
  if (tokens <= budget) {
    return { message: current, tokens };
  }

  if (current.responsesOutput) {
    const { responsesOutput: _native, ...visible } = current;
    current = visible;
    tokens = estimateOpenAiMessageTokens(current);
    if (tokens <= budget) return { message: current, tokens };
  }

  if (
    typeof current.reasoning_content === "string" &&
    current.reasoning_content.length > 0
  ) {
    current = {
      ...current,
      reasoning_content: clipTextToApproxTokens(
        current.reasoning_content,
        Math.max(0, Math.floor(budget * 0.1)),
      ),
    };
    tokens = estimateOpenAiMessageTokens(current);
    if (tokens <= budget) return { message: current, tokens };
  }

  if (current.tool_calls && current.tool_calls.length > 0) {
    const overheadWithoutArgs = estimateOpenAiMessageTokens({
      ...current,
      tool_calls: current.tool_calls.map((call) => ({
        ...call,
        function: { ...call.function, arguments: "" },
      })),
    });
    const argsBudget = Math.max(64, budget - overheadWithoutArgs);
    const perArgs = Math.max(
      32,
      Math.floor(argsBudget / current.tool_calls.length),
    );
    current = {
      ...current,
      tool_calls: current.tool_calls.map((call) => ({
        ...call,
        function: {
          ...call.function,
          arguments: clipTextToApproxTokens(call.function.arguments, perArgs),
        },
      })),
    };
    tokens = estimateOpenAiMessageTokens(current);
    if (tokens <= budget) return { message: current, tokens };
  }

  const body = contentToText(current.content);
  if (body.length > 0) {
    const withoutBody = estimateOpenAiMessageTokens({
      ...current,
      content: "",
    });
    const bodyBudget = Math.max(64, budget - withoutBody);
    const clippedBody = clipTextToApproxTokens(body, bodyBudget);
    current = { ...current, content: clippedBody };
    tokens = estimateOpenAiMessageTokens(current);
  }

  return { message: current, tokens };
}

export type HardTruncateResult = {
  messages: OpenAiChatMessage[];
  truncated: boolean;
  keptMessageCount: number;
  droppedMessageCount: number;
  keptTokens: number;
};

export function hardTruncateKeepingSystemPrefix(
  systemPrefix: OpenAiChatMessage[],
  conversation: OpenAiChatMessage[],
  budgetTokens: number,
): HardTruncateResult {
  const budget = Math.max(0, Math.floor(budgetTokens));
  if (conversation.length === 0) {
    return {
      messages: [...systemPrefix],
      truncated: false,
      keptMessageCount: 0,
      droppedMessageCount: 0,
      keptTokens: 0,
    };
  }

  const costs = conversation.map(estimateOpenAiMessageTokens);
  const total = costs.reduce((sum, n) => sum + n, 0);
  if (total <= budget) {
    return {
      messages: [...systemPrefix, ...conversation],
      truncated: false,
      keptMessageCount: conversation.length,
      droppedMessageCount: 0,
      keptTokens: total,
    };
  }

  let keptTokens = 0;
  let start = conversation.length;
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    const cost = costs[i]!;
    if (keptTokens + cost > budget && start < conversation.length) {
      break;
    }
    keptTokens += cost;
    start = i;
  }

  while (start < conversation.length && conversation[start]!.role === "tool") {
    keptTokens -= costs[start]!;
    start += 1;
  }

  if (start >= conversation.length) {
    start = conversation.length - 1;
    keptTokens = costs[start]!;
    while (start > 0 && conversation[start]!.role === "tool") {
      start -= 1;
      keptTokens += costs[start]!;
    }
  }

  const kept = conversation.slice(start).map((message) => ({ ...message }));
  let clippedBody = false;
  let suffixTokens = kept.reduce(
    (sum, message) => sum + estimateOpenAiMessageTokens(message),
    0,
  );
  if (suffixTokens > budget && kept.length > 0) {
    for (let i = 0; i < kept.length && suffixTokens > budget; i += 1) {
      const message = kept[i]!;
      const before = estimateOpenAiMessageTokens(message);
      const clipped = clipOpenAiMessageToBudget(
        message,
        Math.max(256, budget - (suffixTokens - before)),
      );
      if (clipped.tokens < before) clippedBody = true;
      kept[i] = clipped.message;
      suffixTokens = suffixTokens - before + clipped.tokens;
    }
  }

  const finalKeptTokens = kept.reduce(
    (sum, message) => sum + estimateOpenAiMessageTokens(message),
    0,
  );

  return {
    messages: [...systemPrefix, ...kept],
    truncated: start > 0 || clippedBody,
    keptMessageCount: kept.length,
    droppedMessageCount: start,
    keptTokens: finalKeptTokens,
  };
}
