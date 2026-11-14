import type { JsonObject } from "../../../session/types.js";
import { agentLogInfo, agentLogWarn, agentLogError } from "../../../logging/agentLog.js";
import { parseToolArgumentsRaw } from "../../../tools/validateToolArguments.js";
import { modelEndpoint, resolveResponsesStateful } from "../../apiProtocol.js";
import { reasoningScopeForClient } from "../../contextScope.js";
import { llmActivityKey, recordLlmEndpointActivity } from "../../healthActivity.js";
import { beginLlmTimelineEntry, type LlmTimelineEntry } from "../../llmTimeline/recorder.js";
import type {
  LlmCompleteOptions,
  LlmCompleteResult,
} from "../../canonicalTypes.js";
import { parseOpenAiUsage } from "../../parseUsage.js";
import { responsesInputFromMessages } from "./wire.js";
import { classifyResponsesRequestSafety } from "./requestSafety.js";
import type { StreamEvent } from "../../streamEvents.js";
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS, type ChatResponseFormat,
  type OpenAiCompatibleClientConfig, type StreamChatOptions } from "../../types.js";
import { withLlmUserAgent } from "../../userAgent.js";

type Options = StreamChatOptions & { responseFormat?: ChatResponseFormat };
export type ResponsesCompleteOptions = LlmCompleteOptions & {
  nativeTools?: JsonObject[];
  responses?: NonNullable<StreamChatOptions["responses"]>;
};
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const objects = (value: unknown): JsonObject[] => Array.isArray(value)
  ? value.filter((item): item is JsonObject => Boolean(object(item))) : [];
const NATIVE_TOOL_TYPES = new Set([
  "web_search", "web_search_preview", "file_search", "code_interpreter", "image_generation", "mcp",
]);
const HOSTED_OUTPUT_TYPES = new Set([
  "web_search_call", "file_search_call", "code_interpreter_call", "image_generation_call",
  "mcp_call", "mcp_list_tools", "mcp_approval_request",
]);

function formatForResponses(format: unknown): JsonObject | undefined {
  const raw = object(format);
  if (raw?.type === "json_schema") {
    const schema = object(raw.json_schema);
    return schema ? { type: "json_schema", ...schema } as JsonObject : raw as JsonObject;
  }
  return raw as JsonObject | undefined;
}

/** Request policy owns tools/input/state; provider extras cannot replace them. */
export function buildResponsesBody(config: OpenAiCompatibleClientConfig, options: Options, stream: boolean): JsonObject {
  const extra = { ...(options.extraBody ?? {}) };
  for (const key of ["model", "input", "messages", "tools", "store", "stream", "previous_response_id", "conversation"]) {
    if (key in extra) throw new Error(`Responses extraBody cannot override ${key}`);
  }
  const rawReasoning = object(extra.reasoning);
  const reasoning = {
    ...(typeof rawReasoning?.effort === "string" ? { effort: rawReasoning.effort } : {}),
    ...(typeof rawReasoning?.summary === "string" ? { summary: rawReasoning.summary } : {}),
  } as JsonObject;
  const effort = config.disableReasoning ? "off" : extra.reasoning_effort ?? config.reasoningEffort;
  if (typeof effort === "string") reasoning.effort = effort === "off" ? "none" : effort === "max" ? "xhigh" : effort;
  if (Object.keys(reasoning).length > 0 && !reasoning.summary) reasoning.summary = "auto";
  const format = formatForResponses(options.responseFormat ?? extra.response_format);
  const textConfig = { ...(object(extra.text) ?? {}), ...(format ? { format } : {}) } as JsonObject;
  const maxTokens = extra.max_output_tokens ?? extra.max_completion_tokens ?? extra.max_tokens;
  for (const key of ["reasoning", "reasoning_effort", "response_format", "max_tokens", "max_completion_tokens",
    "thinking", "enableReasoning", "enable_thinking", "chat_template_kwargs", "stream_options", "tool_stream"]) delete extra[key];
  const tools: JsonObject[] = (options.tools ?? []).map((tool) => ({ type: "function",
    name: tool.function.name, ...(tool.function.description ? { description: tool.function.description } : {}),
    ...(tool.function.parameters ? { parameters: tool.function.parameters } : {}), strict: tool.function.strict ?? false }));
  for (const tool of options.nativeTools ?? []) {
    if (!NATIVE_TOOL_TYPES.has(text(tool.type))) {
      throw new Error(`Unsupported native Responses tool: ${text(tool.type) || "missing type"}`);
    }
    tools.push(tool);
  }
  const cacheKey = options.promptCacheKey?.trim() || options.meta?.sessionId?.trim();
  const include = Array.isArray(extra.include) ? extra.include.filter((entry) => typeof entry === "string") : [];
  return {
    ...extra,
    ...(Object.keys(reasoning).length > 0 ? { reasoning } : {}),
    ...(Object.keys(textConfig).length > 0 ? { text: textConfig } : {}),
    ...(maxTokens !== undefined ? { max_output_tokens: maxTokens } : {}),
    ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
    model: config.model,
    input: options.responses?.input ?? responsesInputFromMessages(options.messages, reasoningScopeForClient(config)),
    ...(options.responses?.previousResponseId ? { previous_response_id: options.responses.previousResponseId } : {}),
    tools,
    store: resolveResponsesStateful(config),
    background: extra.background === true,
    include: [...new Set([...include, "reasoning.encrypted_content"])],
    stream,
  };
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly param?: string, readonly code?: string) { super(message); }
}
class RequestNotSubmittedError extends Error {}
function rejectedPreviousResponseId(error: unknown, body: JsonObject): string | undefined {
  const previousId = text(body.previous_response_id);
  if (!previousId || !(error instanceof HttpError) || ![400, 404].includes(error.status)) return undefined;
  const codePointsToCursor = /^(?:previous_response|previous_response_id)_(?:not_found|expired)$/i.test(error.code ?? "");
  const missing = /\b(?:not[\s_-]*found|does(?:\s+not|n't)\s+exist|no\s+such\s+response|expired)\b/i.test(error.message)
    || /不存在|未找到|找不到|已过期/.test(error.message) || codePointsToCursor
    || (error.param === "previous_response_id" && /^(?:not_found|resource_not_found|expired)$/i.test(error.code ?? ""));
  if (!missing) return undefined;
  // A structured pointer takes precedence over incidental words in a message.
  if (error.param && error.param !== "previous_response_id") return undefined;
  const escapedId = previousId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const namesThisId = new RegExp(`(^|[^A-Za-z0-9_-])${escapedId}(?=$|[^A-Za-z0-9_-])`).test(error.message);
  const namedIds = error.message.match(/\bresp_[A-Za-z0-9_-]+\b/g) ?? [];
  if (namedIds.length > 0 && !namesThisId) return undefined;
  const pointsToCursor = error.param === "previous_response_id"
    || (namesThisId && (/\bprevious_response_id\b/i.test(error.message) || codePointsToCursor));
  return pointsToCursor ? previousId : undefined;
}
/** Explicit store:true rejection is a safe stateless downgrade, unlike a generic 400. */
function rejectedStore(error: unknown, body: JsonObject): boolean {
  if (body.store !== true || !(error instanceof HttpError) || ![400, 422].includes(error.status)) return false;
  if (error.param && error.param !== "store") return false;
  const mentionsStore = error.param === "store" || /\bstore\b/i.test(error.message);
  if (!mentionsStore) return false;
  if (/^(?:store_)?(?:not_supported|unsupported)$/i.test(error.code ?? "")) return true;
  const unsupported = /not[\s_-]*supported|unsupported|does(?:\s+not|n't)\s+(?:retain|support)|unknown\s+(?:parameter|field)|unrecognized\s+(?:parameter|field)|不支持/i.test(error.message);
  return unsupported;
}
/** Only requests whose offered capabilities cannot cause remote effects may be resubmitted. */
function mayExecuteNative(body: JsonObject): boolean {
  return classifyResponsesRequestSafety(body.tools, body.input) !== "read_only";
}
/** No bytes for this long after headers means the provider stalled; a later GET can recover by ID. */
export const RESPONSES_STREAM_IDLE_TIMEOUT_MS = 300_000;
function timelineRequest(body: JsonObject): string {
  return JSON.stringify(body, (key, value: unknown) => {
    if (key.toLowerCase() === "authorization") return "[authorization omitted]";
    return key === "encrypted_content" ? "[opaque reasoning omitted]" : value;
  });
}

function abortScope(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
  const abort = (): void => { controller.abort(); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const clear = (): void => { if (timer) clearTimeout(timer); };
  return {
    signal: controller.signal, clear,
    check(response?: Response): void {
      if (!controller.signal.aborted && !signal?.aborted && !timedOut) return;
      void response?.body?.cancel().catch(() => {});
      throw new Error(signal?.aborted || !timedOut ? "Request cancelled" : `Request timed out after ${timeoutMs}ms`);
    },
    dispose(): void { clear(); signal?.removeEventListener("abort", abort); },
  };
}

async function waitRetry(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Request cancelled")); return; }
    const abort = (): void => { clearTimeout(timer); reject(new Error("Request cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function request(
  config: OpenAiCompatibleClientConfig, options: Options, body: JsonObject,
  timeline?: LlmTimelineEntry | null,
): Promise<{ response: Response; scope: ReturnType<typeof abortScope> }> {
  const configuredAttempts = options.maxAttempts;
  const attempts = configuredAttempts !== undefined && Number.isFinite(configuredAttempts)
    ? Math.max(1, Math.min(3, Math.floor(configuredAttempts)))
    : (options.responses?.noRetry || mayExecuteNative(body) ? 1 : 3);
  const endpoint = modelEndpoint(config, "responses");
  let everDispatched = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const scope = abortScope(options.signal, options.timeoutMs ?? config.requestTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    try {
      scope.check();
      everDispatched = true;
      const response = await fetch(endpoint, {
        method: "POST", signal: scope.signal,
        headers: withLlmUserAgent({ "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}`, ...(options.extraHeaders ?? {}) }),
        body: JSON.stringify(body),
      });
      scope.check(response);
      timeline?.noteHttpStatus(response.status);
      if (!response.ok) {
        const raw = await response.text();
        scope.check(response);
        let parsed: ObjectValue | undefined;
        try { parsed = object(JSON.parse(raw)); } catch { /* Preserve HTTP status for non-JSON error bodies. */ }
        const detail = object(parsed?.error);
        throw new HttpError(response.status, text(detail?.message) || raw || `HTTP ${response.status}`,
          typeof detail?.param === "string" ? detail.param : undefined,
          typeof detail?.code === "string" ? detail.code : undefined);
      }
      if (body.stream === true) scope.clear();
      recordLlmEndpointActivity(llmActivityKey({ endpointUrl: endpoint, apiKey: config.apiKey, model: config.model }));
      return { response, scope };
    } catch (error) {
      let failure = error;
      try { scope.check(); } catch (abortError) { failure = abortError; }
      scope.dispose();
      const retryable = !(failure instanceof HttpError) || [429, 502, 503, 504].includes(failure.status);
      if (options.signal?.aborted || !retryable || attempt === attempts) {
        if (!everDispatched && options.signal?.aborted) throw new RequestNotSubmittedError("Request cancelled");
        throw failure;
      }
      timeline?.noteRetry(attempt + 1);
      agentLogWarn("llm.retry", { model: config.model, protocol: "responses", attempt, message: String(failure) });
      await waitRetry(500 * 2 ** (attempt - 1), options.signal);
    }
  }
  throw new Error("Model request failed after retries");
}

/** Standards-compliant SSE framing, including split UTF-8 and trailing data. */
async function* sseObjects(response: Response, signal: AbortSignal, idleTimeoutMs = RESPONSES_STREAM_IDLE_TIMEOUT_MS): AsyncGenerator<ObjectValue> {
  if (!response.body) throw new Error("Response body is empty");
  const reader = response.body.getReader();
  const read = async (): Promise<Awaited<ReturnType<typeof reader.read>>> => {
    if (idleTimeoutMs <= 0) return reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([reader.read(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void reader.cancel().catch(() => {});
          reject(new Error(`Responses stream stalled: no data for ${Math.round(idleTimeoutMs / 1000)}s`));
        }, idleTimeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  function* lines(atEof: boolean): Generator<ObjectValue> {
    for (;;) {
      const sep = buffer.indexOf("\n");
      if (sep < 0 && (!atEof || !buffer)) break;
      const line = (sep < 0 ? buffer : buffer.slice(0, sep)).replace(/\r$/, "");
      buffer = sep < 0 ? "" : buffer.slice(sep + 1);
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      if (!line && data.length > 0) {
        const payload = data.join("\n"); data = [];
        if (payload.trim() === "[DONE]") continue;
        const parsed = object(JSON.parse(payload));
        if (!parsed) throw new Error("Invalid Responses stream payload");
        yield parsed;
      }
    }
    if (atEof && data.length > 0) {
      const payload = data.join("\n"); data = [];
      if (payload.trim() !== "[DONE]") {
        const parsed = object(JSON.parse(payload));
        if (!parsed) throw new Error("Invalid Responses stream payload");
        yield parsed;
      }
    }
  }
  try {
    while (!signal.aborted) {
      const chunk = await read();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      yield* lines(chunk.done);
      if (chunk.done) break;
    }
    if (signal.aborted) throw new Error("Request cancelled");
  } finally {
    signal.removeEventListener("abort", cancel); cancel();
    try { reader.releaseLock(); } catch { /* A stalled read may still be settling. */ }
  }
}

function responseState(response: ObjectValue, stored: boolean, output = false): StreamEvent {
  if (!text(response.id)) throw new Error("Responses payload is missing response id");
  return { type: "response_state", responseId: text(response.id), status: text(response.status),
    stored: stored && response.store !== false,
    ...(output && Array.isArray(response.output) ? { output: response.output as JsonObject[] } : {}) };
}

function outputText(output: JsonObject[]): string {
  return output.filter((item) => item.type === "message").flatMap((item) => objects(item.content))
    .map((part) => text(part.text) || text(part.refusal)).join("");
}
function reasoningText(output: JsonObject[]): string {
  // OpenAI hosts expose summary_text; GLM-class providers expose the raw
  // chain in content (reasoning_text). Extract both in a fixed order so the
  // streamed-prefix reconciliation below stays deterministic.
  return output.filter((item) => item.type === "reasoning").flatMap((item) => [
    ...objects(item.summary),
    ...objects(item.content),
  ]).map((part) => text(part.text)).join("");
}
function hosted(item: ObjectValue): boolean {
  return HOSTED_OUTPUT_TYPES.has(text(item.type));
}
function hostedEvent(item: ObjectValue, fallback: string): StreamEvent {
  const status = text(item.status) || fallback;
  return { type: "hosted_tool", id: text(item.id), name: text(item.name) || text(item.type),
    status: status === "completed" ? "completed" : status === "failed" ? "failed" : status === "incomplete" ? "incomplete" : "in_progress",
    item: item as JsonObject };
}
function* completedEvents(response: ObjectValue, stored: boolean, streamedText: string, streamedReasoning: string): Generator<StreamEvent> {
  // Some gateways emit decoded argument objects; persisted replay needs the JSON-string wire form.
  for (const item of objects(response.output)) {
    if (item.type === "function_call" && object(item.arguments)) item.arguments = JSON.stringify(item.arguments);
  }
  yield responseState(response, stored, true);
  const usage = parseOpenAiUsage(response.usage);
  if (usage) yield usage;
  if (response.status !== "completed" || response.error || response.incomplete_details) {
    throw new Error(text(object(response.error)?.message) || `Response ${text(response.status) || "has invalid terminal status"}${object(response.incomplete_details)?.reason ? `: ${object(response.incomplete_details)?.reason}` : ""}`);
  }
  if (!Array.isArray(response.output)) throw new Error("Completed response is missing output");
  const output = response.output as JsonObject[];
  for (const item of output) {
    if (!object(item)) throw new Error("Invalid Responses output item");
    const type = text(item.type);
    if (hosted(item) || ["message", "reasoning", "function_call"].includes(type)) continue;
    // A call awaiting a locally produced output would stall the next request.
    if (!type || /_call$/.test(type)) throw new Error(`Unsupported Responses output item: ${type || "missing type"}`);
    agentLogWarn("llm.responses_unknown_output", { type });
  }
  const finalText = outputText(output);
  if (finalText.startsWith(streamedText) && finalText.length > streamedText.length) {
    yield { type: "text_delta", text: finalText.slice(streamedText.length) };
  }
  const summary = reasoningText(output);
  if (summary.startsWith(streamedReasoning) && summary.length > streamedReasoning.length) {
    yield { type: "reasoning_delta", text: summary.slice(streamedReasoning.length) };
  }
  // Validate the complete response before delivering any executable function.
  const functions: Array<Extract<StreamEvent, { type: "tool_call" }>> = [];
  for (const item of output) {
    if (item.type === "function_call") {
      if (!text(item.call_id) || !text(item.name) || typeof item.arguments !== "string" ||
          (item.status && item.status !== "completed")) throw new Error("Incomplete Responses function call");
      const parsed = parseToolArgumentsRaw(item.arguments);
      functions.push({ type: "tool_call", id: text(item.call_id), name: text(item.name),
        argumentsRaw: item.arguments, arguments: parsed.value, ...(!parsed.ok ? { argumentsError: parsed.error } : {}) });
    } else if (hosted(item)) yield hostedEvent(item, "completed");
  }
  yield* functions;
  yield { type: "done", reason: "completed" };
}

async function* runResponses(config: OpenAiCompatibleClientConfig, options: Options, stream: boolean): AsyncGenerator<StreamEvent> {
  const body = buildResponsesBody(config, options, stream);
  const requestSafety = classifyResponsesRequestSafety(body.tools, body.input);
  const timeline = options.meta?.sessionId ? beginLlmTimelineEntry({ sessionId: options.meta.sessionId,
    model: config.model, stream, messageCount: options.messages.length,
    toolDefCount: (options.tools?.length ?? 0) + (options.nativeTools?.length ?? 0),
    ...(options.meta.purpose ? { purpose: options.meta.purpose } : {}),
    ...(options.meta.iteration !== undefined ? { iteration: options.meta.iteration } : {}), reqRaw: timelineRequest(body) }) : null;
  let requestScope: ReturnType<typeof abortScope> | undefined;
  try {
    yield { type: "status", status: "streaming" };
    agentLogInfo("llm.request", { model: config.model, protocol: "responses", stream, nativeToolCount: options.nativeTools?.length ?? 0 });
    // The Host checkpoints this marker before advancing the generator into
    // fetch. A lost connection before response.created still has an unknown
    // remote outcome and must not silently resubmit hosted effects.
    yield { type: "response_state", responseId: "", status: "submitting", stored: body.store === true, requestSafety };
    let transport;
    try { transport = await request(config, options, body, timeline); }
    catch (error) {
      if (error instanceof RequestNotSubmittedError) {
        yield { type: "response_state", responseId: "", status: "not_submitted", stored: false, requestSafety };
      }
      if (error instanceof HttpError && [400, 401, 403, 404, 405, 422, 429].includes(error.status)) {
        const rejectedId = rejectedPreviousResponseId(error, body);
        const storeRejected = rejectedStore(error, body);
        yield { type: "response_state", responseId: "", status: "rejected", stored: body.store === true,
          ...(rejectedId ? { rejectedPreviousResponseId: rejectedId } : {}),
          ...(storeRejected ? { rejectedStore: true } : {}) };
      }
      if (!stream && !options.responses?.noRetry && !mayExecuteNative(body) && error instanceof HttpError && [400, 422].includes(error.status) && /non.?stream|stream(?:ing)? (?:is )?required/i.test(error.message)) {
        timeline?.finish({ doneReason: "error", error: error.message });
        yield* runResponses(config, options, true);
        return;
      }
      throw error;
    }
    const { response, scope } = transport;
    requestScope = scope;
    const observe = (event: StreamEvent): StreamEvent => { timeline?.observe(event); return event; };
    let sseResponse = response;
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      const raw = await response.text();
      scope.check(response);
      // Some gateways stream SSE frames under a JSON or text content type.
      if (/^\s*(?:data:|event:|:)/.test(raw)) sseResponse = new Response(raw);
      else {
        let data: ObjectValue | undefined;
        try { data = object(JSON.parse(raw)); } catch { /* Reported below with a body preview. */ }
        if (!data) throw new Error(`Invalid Responses response: ${raw.slice(0, 200) || "empty body"}`);
        for (const event of completedEvents(data, body.store === true, "", "")) {
          scope.check(); yield observe(event);
        }
        return;
      }
    }
    let streamedText = "";
    let streamedReasoning = "";
    let acceptedResponseId = false;
    const items = new Map<string, ObjectValue>();
    for await (const data of sseObjects(sseResponse, scope.signal)) {
      scope.check();
      const type = text(data.type);
      const nativeResponse = object(data.response);
      if (["response.created", "response.queued", "response.in_progress"].includes(type) && nativeResponse) {
        acceptedResponseId = true;
        yield observe(responseState(nativeResponse, body.store === true));
      } else if (type === "response.output_text.delta" || type === "response.refusal.delta") {
        streamedText += text(data.delta);
        yield observe({ type: "text_delta", text: text(data.delta) });
      } else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
        streamedReasoning += text(data.delta);
        yield observe({ type: "reasoning_delta", text: text(data.delta) });
      } else if (["response.output_item.added", "response.output_item.done"].includes(type)) {
        const item = object(data.item);
        if (item) {
          items.set(text(item.id), item);
          if (hosted(item)) yield observe(hostedEvent(item, type.endsWith(".done") ? "completed" : "in_progress"));
          else if (item.type === "function_call" && text(item.call_id) && type.endsWith(".added")) {
            yield observe({ type: "tool_call_delta", id: text(item.call_id), name: text(item.name), argumentsRawDelta: "" });
          }
        }
      } else if (type === "response.function_call_arguments.delta") {
        const item = items.get(text(data.item_id));
        if (item && text(item.call_id)) yield observe({ type: "tool_call_delta", id: text(item.call_id),
          name: text(item.name), argumentsRawDelta: text(data.delta) });
      } else if (/^response\.(?:web_search_call|file_search_call|code_interpreter_call|mcp_call|image_generation_call)\./.test(type)) {
        const item = items.get(text(data.item_id)) ?? { id: data.item_id, type: type.split(".")[1] };
        yield observe(hostedEvent({ ...item, status: type.split(".").at(-1) }, "in_progress"));
      } else if (["response.completed", "response.failed", "response.incomplete", "response.cancelled"].includes(type)) {
        if (!nativeResponse) throw new Error("Missing terminal Responses payload");
        if (type !== "response.completed" && nativeResponse.status === "completed") throw new Error("Invalid Responses terminal event");
        for (const event of completedEvents(nativeResponse, body.store === true, streamedText, streamedReasoning)) {
          scope.check(); yield observe(event);
        }
        return;
      } else if (type === "error" || data.error) {
        const detail = object(data.error) ?? data;
        const message = text(data.message) || text(detail.message) || "Responses stream error";
        if (!acceptedResponseId) {
          // Before response.created nothing ran; policy rejection here is as definite as an HTTP 400.
          const rejection = new HttpError(400, message,
            typeof detail.param === "string" ? detail.param : undefined,
            typeof detail.code === "string" ? detail.code : undefined);
          const rejectedId = rejectedPreviousResponseId(rejection, body);
          const storeRejected = rejectedStore(rejection, body);
          if (rejectedId || storeRejected) {
            yield observe({ type: "response_state", responseId: "", status: "rejected", stored: body.store === true,
              ...(rejectedId ? { rejectedPreviousResponseId: rejectedId } : {}),
              ...(storeRejected ? { rejectedStore: true } : {}) });
          }
        }
        throw new Error(message);
      }
    }
    throw new Error("Responses stream ended before response.completed; retrieve the recorded response before retrying native tools");
  } catch (error) {
    const message = options.signal?.aborted ? "Request cancelled" : error instanceof Error ? error.message : String(error);
    const failure: StreamEvent = { type: "error", message };
    const done: StreamEvent = { type: "done", reason: options.signal?.aborted ? "cancelled" : "error" };
    timeline?.observe(failure); timeline?.observe(done);
    agentLogError("llm.error", { model: config.model, protocol: "responses", message });
    yield failure; yield done;
  } finally { requestScope?.dispose(); timeline?.finish(); }
}

export async function* streamResponses(config: OpenAiCompatibleClientConfig, options: StreamChatOptions): AsyncGenerator<StreamEvent> {
  yield* runResponses(config, options, true);
}

export async function responsesOnce(config: OpenAiCompatibleClientConfig, options: ResponsesCompleteOptions): Promise<LlmCompleteResult> {
  for (;;) {
    let content = "";
    let failure: string | undefined;
    let storeRejected = false;
    for await (const event of runResponses(config, options, false)) {
      if (event.type === "text_delta") content += event.text;
      else if (event.type === "error") failure = event.message;
      else if (event.type === "progress") options.onProgress?.(event.text);
      else if (event.type === "response_state" && event.rejectedStore === true) storeRejected = true;
    }
    if (storeRejected && config.responsesStateful === true) {
      config.responsesStateful = false;
      try {
        await config.onResponsesStatefulDisabled?.("store_rejected");
      } catch (error) {
        agentLogWarn("responses.stateful_disable_persist_failed", {
          model: config.model,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      agentLogInfo("responses.store_fallback", {
        model: config.model,
        stream: false,
        ...(options.meta?.sessionId ? { sessionId: options.meta.sessionId } : {}),
      });
      const retryOptions: ResponsesCompleteOptions = { ...options, responses: { ...options.responses } };
      delete retryOptions.responses!.previousResponseId;
      options = retryOptions;
      continue;
    }
    if (failure) throw new Error(failure);
    if (!content.trim()) throw new Error("Empty model response");
    return { content: content.trim() };
  }
}

function resourceUrl(config: OpenAiCompatibleClientConfig, responseId: string, suffix = ""): string {
  if (!responseId.trim()) throw new Error("Response id is required");
  const url = new URL(modelEndpoint(config, "responses"));
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodeURIComponent(responseId)}${suffix}`;
  return url.toString();
}
/** `status` is set when the provider answered; absent means transport failure or timeout. */
export class ResponseResourceError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}
async function responseResource(config: OpenAiCompatibleClientConfig, responseId: string, method: "GET" | "POST", suffix = "",
  signal?: AbortSignal): Promise<JsonObject> {
  const scope = abortScope(signal, config.requestTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(resourceUrl(config, responseId, suffix), { method, signal: scope.signal,
      headers: withLlmUserAgent({ Authorization: `Bearer ${config.apiKey}` }) });
    scope.check(response);
    const raw = await response.text(); scope.check(response);
    let data: ObjectValue | undefined;
    try { data = object(JSON.parse(raw)); } catch { /* Non-JSON bodies keep the HTTP status below. */ }
    if (!response.ok) {
      throw new ResponseResourceError(text(object(data?.error)?.message) || `HTTP ${response.status}`, response.status);
    }
    if (!data) throw new ResponseResourceError("Invalid Responses resource", response.status);
    return data as JsonObject;
  } finally { scope.dispose(); }
}
export function retrieveResponse(config: OpenAiCompatibleClientConfig, responseId: string, signal?: AbortSignal): Promise<JsonObject> {
  return responseResource(config, responseId, "GET", "", signal);
}
/** Only background responses support remote cancellation; effects are not undone. */
export async function cancelResponse(config: OpenAiCompatibleClientConfig, responseId: string): Promise<JsonObject> {
  const current = await retrieveResponse(config, responseId);
  if (current.background !== true) throw new Error("Only background responses can be cancelled; stopping a local stream does not undo tool effects");
  if (["completed", "failed", "incomplete", "cancelled"].includes(text(current.status))) return current;
  return responseResource(config, responseId, "POST", "/cancel");
}
