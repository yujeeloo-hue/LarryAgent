import { createHash } from "node:crypto";
import type { JsonObject, ModelResponsePart } from "../../../session/types.js";
import { resolveResponsesStateful } from "../../apiProtocol.js";
import { reasoningScopeForClient } from "../../contextScope.js";
import { responsesInputFromMessages } from "./wire.js";
import type { OpenAiChatMessage, OpenAiCompatibleClientConfig } from "../../types.js";

function itemHashes(input: JsonObject[]): string[] {
  return input.map((item) => createHash("sha256").update(JSON.stringify(item)).digest("hex"));
}
function digestHashes(hashes: string[]): string {
  return createHash("sha256").update(JSON.stringify(hashes)).digest("hex");
}

/** A server cursor is reusable only for an exactly matching local context prefix. */
export function prepareResponsesContext(messages: readonly OpenAiChatMessage[], client: OpenAiCompatibleClientConfig): {
  fullInput: JsonObject[]; input: JsonObject[]; previousResponseId?: string;
} {
  const scope = reasoningScopeForClient(client);
  const fullInput = responsesInputFromMessages(messages, scope);
  if (resolveResponsesStateful(client)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const previous = messages[index]!.responsesOutput;
      if (!previous || previous.providerScope !== scope || previous.status !== "completed") continue;
      // A newer stateless/invalidated response ends the old server cursor chain.
      // Keep its native output in fullInput instead of falling back to an older ID.
      if (!previous.stored || !hasText(previous.responseId)) break;
      const count = previous.contextLength;
      if (typeof count !== "number" || count < 1 || count > fullInput.length || !previous.contextHash) continue;
      if (digestHashes(itemHashes(fullInput.slice(0, count))) === previous.contextHash) {
        return { fullInput, input: fullInput.slice(count), previousResponseId: previous.responseId };
      }
    }
  }
  return { fullInput, input: fullInput };
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function completeOrUnspecified(item: JsonObject): boolean {
  return item.status === undefined || item.status === "completed";
}
function replayableContent(content: unknown): boolean {
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.length > 0 && content.every((part: unknown) => {
    if (!isObject(part)) return false;
    if (part.type === "input_text" || part.type === "output_text") return typeof part.text === "string";
    if (part.type === "refusal") return typeof part.refusal === "string";
    if (part.type === "input_image") return hasText(part.image_url) && part.file_id === undefined;
    if (part.type === "input_file") return part.file_id === undefined && (hasText(part.file_data) || hasText(part.file_url));
    return false;
  });
}
function replayableReasoning(item: JsonObject): boolean {
  if (!completeOrUnspecified(item)) return false;
  const summary = item.summary;
  if (summary !== undefined && (!Array.isArray(summary) || !summary.every((part) =>
    isObject(part) && part.type === "summary_text" && typeof part.text === "string"))) return false;
  if (item.encrypted_content !== undefined && typeof item.encrypted_content !== "string") return false;
  const content = item.content;
  if (content !== undefined && (!Array.isArray(content) || !content.every((part) =>
    isObject(part) && part.type === "reasoning_text" && typeof part.text === "string"))) return false;
  // Some compatible providers return summaries without encrypted reasoning.
  return Array.isArray(summary) || hasText(item.encrypted_content) || Array.isArray(content);
}
function replayableHostedResult(item: JsonObject): boolean {
  if (item.status !== "completed") return false;
  switch (item.type) {
    case "web_search_call": {
      const action = item.action;
      if (!isObject(action)) return false;
      if (action.type === "search") return hasText(action.query)
        || (Array.isArray(action.queries) && action.queries.length > 0 && action.queries.every(hasText));
      if (action.type === "open_page") return hasText(action.url);
      if (action.type === "find_in_page") return hasText(action.url) && hasText(action.pattern);
      return false;
    }
    case "file_search_call":
      return Array.isArray(item.queries) && item.queries.every((query) => typeof query === "string")
        && (item.results === undefined || item.results === null || Array.isArray(item.results));
    case "code_interpreter_call":
      return typeof item.code === "string" && Array.isArray(item.outputs);
    case "image_generation_call":
      return hasText(item.result);
    case "mcp_call":
      return typeof item.output === "string";
    case "mcp_list_tools":
      return Array.isArray(item.tools);
    default:
      return false;
  }
}

/**
 * A rejected cursor can be retried once with full history only when every local
 * call already has its exact cached result and no approval could execute again.
 * This is deliberately stricter than normal Responses input serialization.
 */
export function canReplayResponsesInput(input: readonly JsonObject[]): boolean {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const item of input) {
    if (!isObject(item)) return false;
    if (item.type === "function_call") {
      if (!hasText(item.call_id) || !hasText(item.name) || typeof item.arguments !== "string"
        || !completeOrUnspecified(item) || calls.has(item.call_id)) return false;
      calls.add(item.call_id);
    } else if (item.type === "function_call_output") {
      if (!hasText(item.call_id) || !calls.has(item.call_id) || results.has(item.call_id)
        || !completeOrUnspecified(item) || !replayableContent(item.output)) return false;
      results.add(item.call_id);
    } else if (item.type === "message" || item.type === undefined) {
      if (!["system", "developer", "user", "assistant"].includes(String(item.role))
        || !completeOrUnspecified(item) || !replayableContent(item.content)) return false;
    } else if (item.type === "reasoning") {
      if (!replayableReasoning(item)) return false;
    } else if (!replayableHostedResult(item)) {
      // Includes item_reference, unknown tools, and every MCP approval response.
      return false;
    }
  }
  return calls.size === results.size;
}

/** Save the full logical prefix even when the network request sent only a delta. */
export function sealResponsesContext(part: ModelResponsePart, fullInput?: JsonObject[]): void {
  if (fullInput) part.requestItemHashes = itemHashes(fullInput);
  if (part.status !== "completed") return;
  if (!part.requestItemHashes) return;
  const prefix = [...part.requestItemHashes, ...itemHashes(part.output)];
  part.contextLength = prefix.length;
  part.contextHash = digestHashes(prefix);
}

export function responseVisibleText(output: JsonObject[]): { text: string; annotations: JsonObject[] } {
  const messages: string[] = [];
  const annotations: JsonObject[] = [];
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    const chunks: string[] = [];
    for (const content of item.content) {
      if (!content || typeof content !== "object" || Array.isArray(content)) continue;
      if (content.type === "output_text" && typeof content.text === "string") chunks.push(content.text);
      if (content.type === "refusal" && typeof content.refusal === "string") chunks.push(content.refusal);
      if (Array.isArray(content.annotations)) {
        for (const annotation of content.annotations) {
          if (annotation && typeof annotation === "object" && !Array.isArray(annotation)) annotations.push(annotation);
        }
      }
    }
    if (chunks.length) messages.push(chunks.join(""));
  }
  return { text: messages.join("\n\n"), annotations };
}
