import type { JsonObject } from "../../../session/types.js";
import { reasoningScopeForClient } from "../../contextScope.js";
import type { OpenAiChatMessage, OpenAiCompatibleClientConfig, OpenAiContentPart } from "../../types.js";

type DeepSeekReplay = "normal" | "recover";

export function isDeepSeekResponsesModel(client: OpenAiCompatibleClientConfig): boolean {
  const model = client.model.trim().toLowerCase().split("/").at(-1) ?? "";
  return model.startsWith("deepseek-");
}

function standaloneRouteCallId(
  message: OpenAiChatMessage,
  native: OpenAiChatMessage["responsesOutput"],
): string | undefined {
  if (message.reasoning_content?.trim()) return undefined;
  if (native) {
    const item = native.output[0];
    return native.output.length === 1 && !native.continuationInput?.length &&
      item?.type === "function_call" && item.name === "fsm_route" && typeof item.call_id === "string"
      ? item.call_id
      : undefined;
  }
  const call = message.tool_calls?.[0];
  return !message.content && message.tool_calls?.length === 1 && call?.function.name === "fsm_route"
    ? call.id
    : undefined;
}

export function responsesInputForClient(
  messages: readonly OpenAiChatMessage[],
  client: OpenAiCompatibleClientConfig,
  recoverMissingReasoning = false,
): JsonObject[] {
  const replay = isDeepSeekResponsesModel(client) ? recoverMissingReasoning ? "recover" : "normal" : undefined;
  return responsesInputFromMessages(messages, reasoningScopeForClient(client), replay);
}

function responseMessageParts(parts: OpenAiContentPart[]): JsonObject[] {
  return parts.map((part) => part.type === "text"
    ? { type: "input_text", text: part.text }
    : { type: "input_image", image_url: part.image_url.url, detail: part.image_url.detail ?? "auto" });
}

function appendContext(input: JsonObject[], content: string | JsonObject[]): void {
  const previous = input.at(-1);
  if (previous?.role !== "user") {
    input.push({ role: "user", content });
    return;
  }
  if (typeof previous.content === "string" && typeof content === "string") {
    input[input.length - 1] = { ...previous, content: `${previous.content}\n\n${content}` };
    return;
  }
  const asParts = (value: string | JsonObject[]) => typeof value === "string"
    ? [{ type: "input_text", text: value }]
    : value;
  if (typeof previous.content === "string" || Array.isArray(previous.content)) {
    input[input.length - 1] = { ...previous, content: [...asParts(previous.content as string | JsonObject[]), ...asParts(content)] };
  } else {
    input.push({ role: "user", content });
  }
}

function hasPlaintextReasoning(item: JsonObject): boolean {
  return item.type === "reasoning" && Array.isArray(item.content) && item.content.some((part) =>
    part && typeof part === "object" && !Array.isArray(part) && part.type === "reasoning_text" &&
    typeof part.text === "string" && part.text.trim().length > 0);
}

function recordedRound(
  message: OpenAiChatMessage,
  native: OpenAiChatMessage["responsesOutput"],
  messages: readonly OpenAiChatMessage[],
  start: number,
): { content: string | JsonObject[]; toolCount: number } | undefined {
  if (native?.continuationInput?.length || native?.output.some((item) =>
    !["function_call", "message", "reasoning"].includes(String(item.type)) || hasPlaintextReasoning(item))) return;

  const calls = native
    ? native.output.filter((item) => item.type === "function_call")
      .map((item) => ({ id: item.call_id, name: item.name, args: item.arguments }))
    : (message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, args: call.function.arguments }));
  const results = messages.slice(start, start + calls.length);
  const callsById = new Map(calls.map((call) => [call.id, call]));
  if (results.length !== calls.length || callsById.size !== calls.length ||
      new Set(results.map((result) => result.tool_call_id)).size !== results.length ||
      results.some((result) => result.role !== "tool" || !result.tool_call_id || !callsById.has(result.tool_call_id))) return;

  const parts: OpenAiContentPart[] = [];
  const add = (label: string, content: OpenAiChatMessage["content"]) => {
    parts.push({ type: "text", text: label });
    const values = typeof content === "string" ? [{ type: "text" as const, text: content }] : content ?? [];
    for (const part of values) {
      parts.push(part.type === "text" ? { type: "text", text: JSON.stringify(part.text) } : part);
    }
  };
  if (message.content) add("Recorded assistant response for context:", message.content);
  for (const result of results) {
    const call = callsById.get(result.tool_call_id)!;
    add(`Recorded tool result for context (${JSON.stringify({ name: call.name, arguments: call.args })}):`, result.content);
  }
  if (!parts.length) return;
  const content = parts.every((part) => part.type === "text")
    ? parts.map((part) => part.type === "text" ? part.text : "").join("\n")
    : responseMessageParts(parts);
  return { content, toolCount: results.length };
}

export function responsesInputFromMessages(
  messages: readonly OpenAiChatMessage[],
  providerScope?: string,
  deepSeekReplay?: DeepSeekReplay,
): JsonObject[] {
  const input: JsonObject[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const native = message.role === "assistant" && providerScope &&
      message.responsesOutput?.providerScope === providerScope ? message.responsesOutput : undefined;
    if (deepSeekReplay && message.role === "assistant") {
      // FSM triage can run without thinking, then hand off to a thinking node.
      // Keep its completed routing result without requiring nonexistent reasoning.
      const callId = standaloneRouteCallId(message, native);
      const result = messages[index + 1];
      if (callId && result?.role === "tool" && result.tool_call_id === callId && typeof result.content === "string") {
        const routeContext = `Recorded FSM routing result for context:\n${JSON.stringify(result.content)}`;
        appendContext(input, routeContext);
        index += 1;
        continue;
      }
      if (native?.reasoningDisabled || deepSeekReplay === "recover") {
        const recorded = recordedRound(message, native, messages, index + 1);
        if (recorded) {
          appendContext(input, recorded.content);
          index += recorded.toolCount;
          continue;
        }
      }
    }
    if (native) {
      input.push(...native.output);
      input.push(...(native.continuationInput ?? []));
      continue;
    }
    if (message.role === "tool") {
      if (!message.tool_call_id) throw new Error("Responses tool output is missing tool_call_id");
      const output = typeof message.content === "string" ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part): JsonObject =>
              part.type === "text"
                ? { type: "text", text: part.text }
                : { type: "image_url", image_url: { url: part.image_url.url } })
          : "";
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output });
      continue;
    }
    if (message.content !== null && (typeof message.content !== "string" || message.content.length > 0)) {
      const content = typeof message.content === "string" ? message.content : responseMessageParts(message.content);
      input.push({ role: message.role, content });
    }
    for (const call of message.tool_calls ?? []) {
      input.push({ type: "function_call", call_id: call.id,
        name: call.function.name, arguments: call.function.arguments });
    }
  }
  return input;
}
