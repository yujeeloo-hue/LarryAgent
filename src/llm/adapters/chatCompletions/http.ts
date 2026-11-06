import {
  agentLogError,
  agentLogFullRequest,
  agentLogInfo,
  agentLogWarn,
  isFullLlmRequestLogEnabled,
  truncateForLog,
} from "../../../logging/agentLog.js";
import { summarizeRequestPrefix } from "../../../logging/requestPrefixHash.js";
import type { JsonObject } from "../../../session/types.js";
import { parseToolArgumentsRaw } from "../../../tools/validateToolArguments.js";
import { modelEndpoint } from "../../apiProtocol.js";
import {
  appendToolCallArguments,
  toolCallArgumentsDeltaToString,
} from "../../appendToolCallArguments.js";
import { glmToolStreamBody } from "../../glmToolStream.js";
import { llmActivityKey, recordLlmEndpointActivity } from "../../healthActivity.js";
import {
  beginLlmTimelineEntry,
  type LlmTimelineEntry,
} from "../../llmTimeline/recorder.js";
import type { StreamEvent, StreamToolCallDeltaEvent } from "../../streamEvents.js";
import { parseOpenAiUsage } from "../../parseUsage.js";
import { withLlmUserAgent } from "../../userAgent.js";
import type {
  ChatResponseFormat,
  LlmRequestMeta,
  OpenAiChatMessage,
  OpenAiCompatibleClientConfig,
  OpenAiToolDefinition,
  StreamChatOptions,
} from "../../types.js";
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS } from "../../types.js";
import type {
  LlmCompleteOptions,
  LlmCompleteResult,
} from "../../canonicalTypes.js";

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** True when the gateway rejects Structured Outputs `json_schema`. */
function isJsonSchemaResponseFormatUnsupported(
  httpStatus: number,
  message: string,
): boolean {
  if (httpStatus !== 400 && httpStatus !== 422) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes("response_format") &&
    (lower.includes("unavailable") ||
      lower.includes("json_schema") ||
      lower.includes("not support"))
  );
}

/**
 * True when the gateway rejects non-streaming chat completions
 * (`stream: false`) — e.g. `copilot.tencent.com` returns
 * `{"code":11101,"msg":"Non-stream chat request is currently not supported"}`.
 * The `message` here is the `httpErrorMessage` output, which for non-OpenAI
 * error shapes embeds the raw JSON body, so match on the raw-text keywords.
 */
function isNonStreamUnsupported(
  httpStatus: number,
  message: string,
): boolean {
  if (httpStatus !== 400 && httpStatus !== 422) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes("non-stream") ||
    lower.includes("nonstream") ||
    lower.includes("stream is required") ||
    lower.includes("streaming is required") ||
    lower.includes("stream must be") ||
    (lower.includes("stream") &&
      (lower.includes("not supported") || lower.includes("unsupported")))
  );
}

function truncateJson(value: unknown): string {
  try {
    return truncateForLog(JSON.stringify(value));
  } catch {
    return truncateForLog(String(value));
  }
}

/** JSON snapshot of an LLM request for the timeline raw panel; never throws. */
function safeTimelineReqRaw(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return '{"error":"request payload not serializable"}';
  }
}

/**
 * TokenHUB Prompt Cache hints: body `prompt_cache_key` + header `X-Session-ID`.
 * Prefer an explicit key; otherwise reuse the session id from request meta.
 */
function resolvePromptCacheKey(
  explicit: string | undefined,
  meta: LlmRequestMeta | undefined,
): string | undefined {
  const fromExplicit = typeof explicit === "string" ? explicit.trim() : "";
  if (fromExplicit) return fromExplicit;
  const fromSession =
    typeof meta?.sessionId === "string" ? meta.sessionId.trim() : "";
  return fromSession || undefined;
}

function withPromptCacheBody(
  body: JsonObject,
  promptCacheKey: string | undefined,
  extraBody: JsonObject | undefined,
): JsonObject {
  return {
    ...body,
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    ...(extraBody ?? {}),
  };
}

function withPromptCacheHeaders(
  headers: Record<string, string>,
  promptCacheKey: string | undefined,
  extraHeaders: Record<string, string> | undefined,
): Record<string, string> {
  return withLlmUserAgent({
    ...headers,
    ...(promptCacheKey ? { "X-Session-ID": promptCacheKey } : {}),
    ...(extraHeaders ?? {}),
  });
}

function llmFields(
  config: OpenAiCompatibleClientConfig,
  meta: LlmRequestMeta | undefined,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    model: config.model,
    host: hostOf(config.baseUrl),
    ...(meta?.sessionId ? { sessionId: meta.sessionId } : {}),
    ...(meta?.iteration !== undefined ? { iteration: meta.iteration } : {}),
    ...(meta?.purpose ? { purpose: meta.purpose } : {}),
    ...extra,
  };
}

/** When Full request log is on: prefix hash summary (drawer) + untruncated body (disk). */
function logFullLlmRequestIfEnabled(
  config: OpenAiCompatibleClientConfig,
  meta: LlmRequestMeta | undefined,
  messages: OpenAiChatMessage[],
  tools?: OpenAiToolDefinition[],
): void {
  if (!isFullLlmRequestLogEnabled()) return;

  const prefix = summarizeRequestPrefix(messages, tools);
  const segmentMap: Record<string, { present: boolean; hash: string | null; charLen: number }> =
    {};
  for (const seg of prefix.segments) {
    segmentMap[seg.id] = {
      present: seg.present,
      hash: seg.hash,
      charLen: seg.charLen,
    };
  }

  agentLogInfo(
    "llm.request.prefix",
    llmFields(config, meta, {
      messageCount: prefix.messageCount,
      toolDefCount: prefix.toolDefCount,
      toolsHash: prefix.toolsHash,
      toolsNames: prefix.toolsNames,
      transcriptStartIndex: prefix.transcriptStartIndex,
      segments: segmentMap,
    }),
  );

  agentLogFullRequest(
    "llm.request.full",
    llmFields(config, meta, {
      messageCount: messages.length,
      toolDefCount: tools?.length ?? 0,
      prefix: segmentMap,
      toolsHash: prefix.toolsHash,
      toolsNames: prefix.toolsNames,
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    }),
  );
}

type ToolCallAcc = {
  id: string;
  name: string;
  argumentsRaw: string;
};

const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRY_AFTER_CAP_MS = 10_000;
/**
 * Longer budget for context-compaction LLM calls (Cold / Warm / iteration-protect).
 * Those payloads are large; a 30s chat timeout would starve summarization.
 */
export const DEFAULT_LLM_COMPACT_TIMEOUT_MS = 120_000;

/**
 * Combine an optional caller AbortSignal with a clearable per-attempt timeout.
 * Streaming callers should `clearTimeout()` once response headers arrive so a
 * long token stream is not killed by the same timer, while still honoring the
 * caller's cancel signal for the body. Call `dispose()` when the attempt ends.
 *
 * Pass `timeoutMs: 0` (or a negative value) to disable the wall-clock timer.
 */
function createRequestAbort(input: {
  signal?: AbortSignal;
  timeoutMs?: number;
}): {
  signal: AbortSignal;
  /** Stop the wall-clock timer only (keep caller-cancel wiring). */
  clearTimeout: () => void;
  /** Tear down timer + caller listener. */
  dispose: () => void;
  didTimeout: () => boolean;
  timeoutMs: number;
} {
  const timeoutMs =
    typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
      ? Math.floor(input.timeoutMs)
      : DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;

  const onCallerAbort = (): void => {
    controller.abort();
  };
  if (input.signal) {
    if (input.signal.aborted) {
      if (timer) clearTimeout(timer);
      controller.abort();
    } else {
      input.signal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
  };

  return {
    signal: controller.signal,
    clearTimeout: clearTimer,
    dispose: () => {
      clearTimer();
      input.signal?.removeEventListener("abort", onCallerAbort);
    },
    didTimeout: () => timedOut,
    timeoutMs,
  };
}

/** Reject late transport results even when the transport ignored its signal. */
function ensureRequestActive(
  requestAbort: ReturnType<typeof createRequestAbort>,
  callerSignal: AbortSignal | undefined,
  response: Response,
): void {
  const timedOut = requestAbort.didTimeout();
  if (!callerSignal?.aborted && !requestAbort.signal.aborted && !timedOut) return;
  // Do not await cancellation: an uncooperative transport may also leave its
  // cancellation promise pending. A late body must never reach the parser.
  void response.body?.cancel().catch(() => {});
  if (callerSignal?.aborted || !timedOut) throw new Error("Request cancelled");
  throw new Error(`Request timed out after ${requestAbort.timeoutMs}ms`);
}

/**
 * Chat endpoint for a config: `rawEndpoint` uses `baseUrl` as-is (already
 * the full endpoint); otherwise append `chat/completions`.
 */
function chatCompletionsUrl(config: OpenAiCompatibleClientConfig): string {
  return modelEndpoint(config, "chat_completions");
}

/**
 * Stable health-gate identity for a config: resolved protocol endpoint + model +
 * API key fingerprint. Must match what `llm:checkHealth` probes (same URL
 * resolution) so recent real traffic suppresses redundant probe requests.
 * Accepts a partial config — only endpoint-relevant fields are read.
 */
export function llmEndpointKey(config: {
  baseUrl: string;
  apiKey: string;
  model?: string;
  rawEndpoint?: boolean;
  apiProtocol?: NonNullable<OpenAiCompatibleClientConfig["apiProtocol"]>;
}): string {
  return llmActivityKey({
    endpointUrl: modelEndpoint(config),
    apiKey: config.apiKey,
    ...(config.model !== undefined ? { model: config.model } : {}),
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function backoffMs(attempt: number): number {
  return 500 * 2 ** (attempt - 1);
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.min(asSeconds * 1000, RETRY_AFTER_CAP_MS);
  }
  const asDate = Date.parse(raw);
  if (!Number.isNaN(asDate)) {
    return Math.min(Math.max(0, asDate - Date.now()), RETRY_AFTER_CAP_MS);
  }
  return null;
}

function httpErrorMessage(status: number, raw: string): string {
  let message = `HTTP ${status}`;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof (parsed as { error?: { message?: unknown } }).error?.message ===
        "string"
    ) {
      message = (parsed as { error: { message: string } }).error.message;
    } else if (raw.trim()) {
      message = raw.trim().slice(0, 500);
    }
  } catch {
    if (raw.trim()) message = raw.trim().slice(0, 500);
  }
  return message;
}

function usageFromChunk(
  data: unknown,
): { event: StreamEvent; raw: unknown } | null {
  if (typeof data !== "object" || data === null || !("usage" in data)) {
    return null;
  }
  const raw = (data as { usage?: unknown }).usage;
  const event = parseOpenAiUsage(raw);
  if (!event) return null;
  return { event, raw };
}

function incompleteCompletionMessage(finishReason: unknown): string | undefined {
  if (finishReason === "length" || finishReason === "content_filter") {
    return `Model response is incomplete (finish_reason: ${finishReason})`;
  }
  return undefined;
}

async function* parseSseStream(
  response: Response,
  signal?: AbortSignal,
  onUsageRaw?: (raw: unknown) => void,
): AsyncGenerator<StreamEvent, void, undefined> {
  if (!response.body) {
    yield { type: "error", message: "Response body is empty" };
    yield { type: "done", reason: "error" };
    return;
  }

  const toolCalls = new Map<number, ToolCallAcc>();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawError = false;
  let sawCompletionMarker = false;
  let sawDone = false;

  // Abort an outstanding read as well as the fetch. This also covers custom
  // transports whose response bodies do not inherit the request signal.
  const cancelReader = (): void => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancelReader, { once: true });
  if (signal?.aborted) cancelReader();

  const flushToolCalls = function* (): Generator<StreamEvent, void, undefined> {
    for (const call of toolCalls.values()) {
      if (signal?.aborted) return;
      if (!call.id || !call.name) continue;
      const parsed = parseToolArgumentsRaw(call.argumentsRaw);
      const event: Extract<StreamEvent, { type: "tool_call" }> = {
        type: "tool_call",
        id: call.id,
        name: call.name,
        argumentsRaw: call.argumentsRaw,
        arguments: parsed.value,
      };
      if (!parsed.ok) {
        event.argumentsError = parsed.error;
      }
      yield event;
    }
  };

  const consumeLines = function* (atEof: boolean): Generator<StreamEvent, void, undefined> {
    while (buffer.length > 0 && !sawDone && !signal?.aborted) {
      const sep = buffer.indexOf("\n");
      if (sep < 0 && !atEof) break;
      let line = sep < 0 ? buffer : buffer.slice(0, sep);
      buffer = sep < 0 ? "" : buffer.slice(sep + 1);
      line = line.replace(/\r$/, "").trim();
      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === "[DONE]") {
        sawDone = true;
        sawCompletionMarker = true;
        return;
      }

      let data: unknown;
      try {
        data = JSON.parse(payload);
      } catch {
        sawError = true;
        yield { type: "error", message: "Invalid JSON in model stream" };
        continue;
      }

      if (typeof data !== "object" || data === null) {
        sawError = true;
        yield { type: "error", message: "Invalid model stream payload" };
        continue;
      }

      if ("error" in data && data.error !== null && data.error !== undefined) {
        const error = data.error;
        const message = typeof error === "string"
          ? error
          : typeof error === "object" && "message" in error && typeof error.message === "string"
            ? error.message
            : "";
        // Gateways can report code-only or other nonstandard error payloads.
        // Every non-null error must block pending tools, even without a message.
        sawError = true;
        yield {
          type: "error",
          message: message.trim() ? message : "Model stream reported an error",
        };
        continue;
      }

      const parsedUsage = usageFromChunk(data);
      if (parsedUsage) {
        onUsageRaw?.(parsedUsage.raw);
        yield parsedUsage.event;
      }

      const choice = (
        data as {
          choices?: Array<{
            finish_reason?: string | null;
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
              reasoning?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: unknown };
              }>;
            };
          }>;
        }
      ).choices?.[0];
      if (typeof choice?.finish_reason === "string" && choice.finish_reason) {
        sawCompletionMarker = true;
        const message = incompleteCompletionMessage(choice.finish_reason);
        if (message) {
          sawError = true;
          yield { type: "error", message };
        }
      }
      const delta = choice?.delta;
      if (!delta) continue;

      if (typeof delta.content === "string" && delta.content.length > 0) {
        yield { type: "text_delta", text: delta.content };
      }

      const reasoningDelta =
        typeof delta.reasoning_content === "string" &&
        delta.reasoning_content.length > 0
          ? delta.reasoning_content
          : typeof delta.reasoning === "string" && delta.reasoning.length > 0
            ? delta.reasoning
            : null;
      if (reasoningDelta) {
        yield { type: "reasoning_delta", text: reasoningDelta };
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          const current = toolCalls.get(index) ?? {
            id: "",
            name: "",
            argumentsRaw: "",
          };
          if (typeof tc.id === "string" && tc.id.length > 0) {
            current.id = tc.id;
          }
          const nameDelta = tc.function?.name;
          if (typeof nameDelta === "string" && nameDelta.length > 0) {
            current.name += nameDelta;
            // Announce the tool name as soon as it arrives so the UI can show
            // Progress line while large argument payloads (e.g. write_file) stream.
            yield {
              type: "tool_call_delta",
              id: current.id || `pending-${index}`,
              name: current.name,
              argumentsRawDelta: "",
            } satisfies StreamToolCallDeltaEvent;
          }
          const argsDelta = toolCallArgumentsDeltaToString(
            tc.function?.arguments,
          );
          if (argsDelta.length > 0) {
            current.argumentsRaw = appendToolCallArguments(
              current.argumentsRaw,
              argsDelta,
            );
            const deltaEvent: StreamToolCallDeltaEvent = current.name
              ? {
                  type: "tool_call_delta",
                  id: current.id || `pending-${index}`,
                  name: current.name,
                  argumentsRawDelta: argsDelta,
                }
              : {
                  type: "tool_call_delta",
                  id: current.id || `pending-${index}`,
                  argumentsRawDelta: argsDelta,
                };
            yield deltaEvent;
          }
          toolCalls.set(index, current);
        }
      }
    }
  };

  try {
    while (!sawDone && !signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        yield* consumeLines(true);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      yield* consumeLines(false);
    }

    if (signal?.aborted) {
      yield { type: "error", message: "Request cancelled" };
      yield { type: "done", reason: "cancelled" };
    } else {
      if (!sawCompletionMarker && !sawError) {
        sawError = true;
        yield { type: "error", message: "Model stream ended before completion" };
      }
      // Partial/error responses can still contain syntactically valid tool
      // arguments. They must never turn into executable calls.
      if (!sawError) yield* flushToolCalls();
      yield {
        type: "done",
        reason: signal?.aborted ? "cancelled" : sawError ? "error" : "completed",
      };
    }
  } catch (err) {
    const cancelled = signal?.aborted === true;
    const message = err instanceof Error ? err.message : String(err);
    yield {
      type: "error",
      message: cancelled ? "Request cancelled" : message,
    };
    yield { type: "done", reason: cancelled ? "cancelled" : "error" };
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    cancelReader();
    reader.releaseLock();
  }
}

/**
 * Stream a chat completion from an OpenAI-compatible HTTP API.
 * Yields project `StreamEvent` values (text/tool deltas, usage, error, done).
 * Retries transport / 429 / 502 / 503 / 504 up to 3 attempts.
 *
 * Public wrapper: records the round-trip in the in-memory LLM timeline
 * (Dev Panel → Timeline tab) when `meta.sessionId` is present, then delegates.
 */
export async function* streamChatCompletion(
  config: OpenAiCompatibleClientConfig,
  options: StreamChatOptions,
): AsyncGenerator<StreamEvent, void, undefined> {
  options = { ...options, messages: options.messages.map(({ responsesOutput: _native, ...message }) => message) };
  const meta = options.meta;
  if (!meta?.sessionId) {
    yield* streamChatCompletionImpl(config, options);
    return;
  }
  const timeline = beginLlmTimelineEntry({
    sessionId: meta.sessionId,
    ...(meta.purpose ? { purpose: meta.purpose } : {}),
    ...(meta.iteration !== undefined ? { iteration: meta.iteration } : {}),
    model: config.model,
    stream: true,
    messageCount: options.messages.length,
    toolDefCount: options.tools?.length ?? 0,
    reqRaw: safeTimelineReqRaw({
      model: config.model,
      stream: true,
      messages: options.messages,
      ...(options.tools?.length ? { tools: options.tools } : {}),
    }),
  });
  if (!timeline) {
    yield* streamChatCompletionImpl(config, options);
    return;
  }
  try {
    for await (
      const event of streamChatCompletionImpl(config, options, timeline)
    ) {
      timeline.observe(event);
      yield event;
    }
    timeline.finish();
  } catch (err) {
    timeline.finish({
      doneReason: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function* streamChatCompletionImpl(
  config: OpenAiCompatibleClientConfig,
  options: StreamChatOptions,
  timeline?: LlmTimelineEntry,
  allowJsonSchemaFallback = false,
): AsyncGenerator<StreamEvent, void, undefined> {
  const url = chatCompletionsUrl(config);
  const meta = options.meta;
  const promptCacheKey = resolvePromptCacheKey(options.promptCacheKey, meta);
  const hasTools = Boolean(options.tools && options.tools.length > 0);
  const glmToolStream = hasTools
    ? glmToolStreamBody(config.baseUrl, config.model)
    : undefined;
  const body: JsonObject = withPromptCacheBody(
    {
      model: config.model,
      messages: options.messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(hasTools ? { tools: options.tools } : {}),
      ...(glmToolStream ?? {}),
    },
    promptCacheKey,
    options.extraBody,
  );

  const startedAt = Date.now();
  agentLogInfo(
    "llm.request",
    llmFields(config, meta, {
      stream: true,
      ...(glmToolStream ? { toolStream: true } : {}),
      messageCount: options.messages.length,
      toolDefCount: options.tools?.length ?? 0,
      promptCacheKey: promptCacheKey ?? null,
    }),
  );
  logFullLlmRequestIfEnabled(
    config,
    meta,
    options.messages,
    options.tools,
  );

  yield { type: "status", status: "streaming" };
  yield { type: "progress", text: "Waiting for model…" };

  let jsonSchemaFallbackDone = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (options.signal?.aborted) {
      agentLogWarn(
        "llm.cancelled",
        llmFields(config, meta, { attempt, durationMs: Date.now() - startedAt }),
      );
      yield { type: "error", message: "Request cancelled" };
      yield { type: "done", reason: "cancelled" };
      return;
    }

    let response: Response;
    const requestTimeoutMs = options.timeoutMs ?? config.requestTimeoutMs;
    const requestAbort = createRequestAbort({
      ...(options.signal ? { signal: options.signal } : {}),
      ...(requestTimeoutMs !== undefined
        ? { timeoutMs: requestTimeoutMs }
        : {}),
    });
    try {
      const init: RequestInit = {
        method: "POST",
        headers: withPromptCacheHeaders(
          {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          promptCacheKey,
          options.extraHeaders,
        ),
        body: JSON.stringify(body),
        signal: requestAbort.signal,
      };
      response = await fetch(url, init);
      ensureRequestActive(requestAbort, options.signal, response);
      // Headers received — drop the per-attempt timer so a long stream is not
      // aborted mid-flight. Caller cancel still aborts via the shared signal.
      requestAbort.clearTimeout();
    } catch (err) {
      const timedOut = requestAbort.didTimeout();
      requestAbort.dispose();
      const cancelled = options.signal?.aborted === true;
      if (cancelled) {
        agentLogWarn(
          "llm.cancelled",
          llmFields(config, meta, {
            attempt,
            durationMs: Date.now() - startedAt,
          }),
        );
        yield { type: "error", message: "Request cancelled" };
        yield { type: "done", reason: "cancelled" };
        return;
      }
      const message = timedOut
        ? `Request timed out after ${requestAbort.timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      if (attempt < MAX_ATTEMPTS) {
        agentLogWarn(
          "llm.retry",
          llmFields(config, meta, {
            attempt,
            reason: timedOut ? "timeout" : "transport",
            message,
            nextAttempt: attempt + 1,
          }),
        );
        timeline?.noteRetry(attempt + 1);
        yield { type: "progress", text: timedOut
          ? "Model request timed out — retrying…"
          : "Retrying model request…" };
        try {
          await sleep(backoffMs(attempt), options.signal);
        } catch {
          agentLogWarn(
            "llm.cancelled",
            llmFields(config, meta, {
              attempt,
              durationMs: Date.now() - startedAt,
            }),
          );
          yield { type: "error", message: "Request cancelled" };
          yield { type: "done", reason: "cancelled" };
          return;
        }
        continue;
      }
      agentLogError(
        "llm.error",
        llmFields(config, meta, {
          attempt,
          reason: timedOut ? "timeout" : "transport",
          message,
          durationMs: Date.now() - startedAt,
        }),
      );
      yield { type: "error", message };
      yield { type: "done", reason: "error" };
      return;
    }

    if (response.ok) {
      // Successful handshake = live endpoint + valid auth — strongest possible
      // health signal; lets the 60s poll skip its own probe request.
      recordLlmEndpointActivity(llmEndpointKey(config));
      timeline?.noteHttpStatus(response.status);
      let streamError: string | undefined;
      let doneReason:
        | "completed"
        | "cancelled"
        | "paused"
        | "error"
        | undefined;
      let textChars = 0;
      let reasoningChars = 0;
      let toolCallCount = 0;
      const usage: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        cachedTokens?: number;
        cacheWriteTokens?: number;
      } = {};
      let usageRaw: unknown;

      try {
        for await (const event of parseSseStream(
          response,
          requestAbort.signal,
          (raw) => {
            usageRaw = raw;
          },
        )) {
          if (event.type === "text_delta") {
            textChars += event.text.length;
          } else if (event.type === "reasoning_delta") {
            reasoningChars += event.text.length;
          } else if (event.type === "tool_call") {
            toolCallCount += 1;
          } else if (event.type === "usage") {
            if (typeof event.promptTokens === "number") {
              usage.promptTokens = event.promptTokens;
            }
            if (typeof event.completionTokens === "number") {
              usage.completionTokens = event.completionTokens;
            }
            if (typeof event.totalTokens === "number") {
              usage.totalTokens = event.totalTokens;
            }
            if (typeof event.cachedTokens === "number") {
              usage.cachedTokens = event.cachedTokens;
            }
            if (typeof event.cacheWriteTokens === "number") {
              usage.cacheWriteTokens = event.cacheWriteTokens;
            }
          } else if (event.type === "error") {
            streamError = event.message;
          } else if (event.type === "done") {
            doneReason = event.reason;
          }
          yield event;
        }
      } finally {
        requestAbort.dispose();
      }

      const durationMs = Date.now() - startedAt;
      if (doneReason === "cancelled") {
        agentLogWarn(
          "llm.cancelled",
          llmFields(config, meta, {
            attempt,
            durationMs,
            textChars,
            reasoningChars,
            toolCallCount,
          }),
        );
      } else if (streamError || doneReason === "error") {
        agentLogError(
          "llm.error",
          llmFields(config, meta, {
            attempt,
            reason: "stream",
            message: streamError ?? "Stream error",
            durationMs,
            textChars,
            reasoningChars,
            toolCallCount,
          }),
        );
      } else {
        agentLogInfo(
          "llm.response",
          llmFields(config, meta, {
            attempt,
            durationMs,
            textChars,
            reasoningChars,
            toolCallCount,
            httpStatus: response.status,
            promptCacheKey: promptCacheKey ?? null,
            ...usage,
            ...(usageRaw !== undefined
              ? { usageRaw: truncateJson(usageRaw) }
              : {}),
          }),
        );
      }
      return;
    }

    requestAbort.dispose();
    const raw = await response.text().catch(() => "");
    const message = httpErrorMessage(response.status, raw);
    const wireFormat = body.response_format as ChatResponseFormat | undefined;
    if (
      allowJsonSchemaFallback &&
      !jsonSchemaFallbackDone &&
      wireFormat?.type === "json_schema" &&
      isJsonSchemaResponseFormatUnsupported(response.status, message)
    ) {
      jsonSchemaFallbackDone = true;
      body.response_format = { type: "json_object" };
      agentLogWarn("llm.response_format_fallback", llmFields(config, meta, {
        attempt,
        from: "json_schema",
        to: "json_object",
        httpStatus: response.status,
        message,
      }));
      attempt -= 1;
      timeline?.noteRetry(attempt + 1);
      continue;
    }
    const retryable = RETRYABLE_STATUS.has(response.status);

    if (retryable && attempt < MAX_ATTEMPTS) {
      const wait = retryAfterMs(response) ?? backoffMs(attempt);
      agentLogWarn(
        "llm.retry",
        llmFields(config, meta, {
          attempt,
          reason: "http",
          httpStatus: response.status,
          message,
          waitMs: wait,
          nextAttempt: attempt + 1,
        }),
      );
      timeline?.noteRetry(attempt + 1);
      yield { type: "progress", text: "Retrying model request…" };
      try {
        await sleep(wait, options.signal);
      } catch {
        agentLogWarn(
          "llm.cancelled",
          llmFields(config, meta, {
            attempt,
            durationMs: Date.now() - startedAt,
          }),
        );
        yield { type: "error", message: "Request cancelled" };
        yield { type: "done", reason: "cancelled" };
        return;
      }
      continue;
    }

    agentLogError(
      "llm.error",
      llmFields(config, meta, {
        attempt,
        reason: "http",
        httpStatus: response.status,
        message,
        durationMs: Date.now() - startedAt,
      }),
    );
    timeline?.noteHttpStatus(response.status);
    yield { type: "error", message };
    yield { type: "done", reason: "error" };
    return;
  }
}

/**
 * Non-streaming chat completion (used for context summarization).
 * Same retry policy as streaming.
 *
 * Public wrapper: records the round-trip in the in-memory LLM timeline
 * (Dev Panel → Timeline tab) when `meta.sessionId` is present, then delegates.
 */
export async function chatCompletionOnce(
  config: OpenAiCompatibleClientConfig,
  options: LlmCompleteOptions,
): Promise<LlmCompleteResult> {
  options = { ...options, messages: options.messages.map(({ responsesOutput: _native, ...message }) => message) };
  const meta = options.meta;
  if (!meta?.sessionId) {
    return chatCompletionOnceImpl(config, options);
  }
  const timeline = beginLlmTimelineEntry({
    sessionId: meta.sessionId,
    ...(meta.purpose ? { purpose: meta.purpose } : {}),
    ...(meta.iteration !== undefined ? { iteration: meta.iteration } : {}),
    model: config.model,
    stream: false,
    messageCount: options.messages.length,
    toolDefCount: 0,
    reqRaw: safeTimelineReqRaw({
      model: config.model,
      stream: false,
      messages: options.messages,
    }),
  });
  if (!timeline) {
    return chatCompletionOnceImpl(config, options);
  }
  try {
    const result = await chatCompletionOnceImpl(config, options, timeline);
    timeline.finish({
      doneReason: "completed",
      textChars: result.content.length,
      textRaw: result.content,
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    timeline.finish({
      doneReason: message === "Request cancelled" ? "cancelled" : "error",
      error: message,
    });
    throw err;
  }
}

async function chatCompletionOnceImpl(
  config: OpenAiCompatibleClientConfig,
  options: LlmCompleteOptions,
  timeline?: LlmTimelineEntry,
): Promise<LlmCompleteResult> {
  const url = chatCompletionsUrl(config);
  const meta = options.meta;
  const promptCacheKey = resolvePromptCacheKey(options.promptCacheKey, meta);
  const body: JsonObject = withPromptCacheBody(
    {
      model: config.model,
      messages: options.messages,
      stream: false,
      ...(options.responseFormat
        ? { response_format: options.responseFormat }
        : {}),
    },
    promptCacheKey,
    options.extraBody,
  );

  const startedAt = Date.now();
  agentLogInfo(
    "llm.request",
    llmFields(config, meta, {
      stream: false,
      messageCount: options.messages.length,
      promptCacheKey: promptCacheKey ?? null,
      hasResponseFormat: Boolean(options.responseFormat),
    }),
  );
  logFullLlmRequestIfEnabled(config, meta, options.messages);

  let jsonSchemaFallbackDone = false;
  let streamFallbackDone = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (options.signal?.aborted) {
      agentLogWarn(
        "llm.cancelled",
        llmFields(config, meta, { attempt, durationMs: Date.now() - startedAt }),
      );
      throw new Error("Request cancelled");
    }

    let response: Response;
    const requestTimeoutMs = options.timeoutMs ?? config.requestTimeoutMs;
    const requestAbort = createRequestAbort({
      ...(options.signal ? { signal: options.signal } : {}),
      ...(requestTimeoutMs !== undefined
        ? { timeoutMs: requestTimeoutMs }
        : {}),
    });
    try {
      const init: RequestInit = {
        method: "POST",
        headers: withPromptCacheHeaders(
          {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          promptCacheKey,
          options.extraHeaders,
        ),
        body: JSON.stringify(body),
        signal: requestAbort.signal,
      };
      response = await fetch(url, init);
      ensureRequestActive(requestAbort, options.signal, response);
    } catch (err) {
      const timedOut = requestAbort.didTimeout();
      requestAbort.dispose();
      const cancelled = options.signal?.aborted === true;
      if (cancelled) {
        agentLogWarn(
          "llm.cancelled",
          llmFields(config, meta, {
            attempt,
            durationMs: Date.now() - startedAt,
          }),
        );
        throw new Error("Request cancelled");
      }
      const message = timedOut
        ? `Request timed out after ${requestAbort.timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      if (attempt < MAX_ATTEMPTS) {
        agentLogWarn(
          "llm.retry",
          llmFields(config, meta, {
            attempt,
            reason: timedOut ? "timeout" : "transport",
            message,
            nextAttempt: attempt + 1,
          }),
        );
        timeline?.noteRetry(attempt + 1);
        options.onProgress?.(
          timedOut
            ? "Model request timed out — retrying…"
            : "Retrying model request…",
        );
        await sleep(backoffMs(attempt), options.signal);
        continue;
      }
      agentLogError(
        "llm.error",
        llmFields(config, meta, {
          attempt,
          reason: timedOut ? "timeout" : "transport",
          message,
          durationMs: Date.now() - startedAt,
        }),
      );
      throw new Error(message);
    }

    if (response.ok) {
      // Successful handshake = live endpoint + valid auth — strongest possible
      // health signal; lets the 60s poll skip its own probe request.
      recordLlmEndpointActivity(llmEndpointKey(config));
      timeline?.noteHttpStatus(response.status);
      let data: unknown;
      try {
        data = await response.json();
        ensureRequestActive(requestAbort, options.signal, response);
      } catch (err) {
        const timedOut = requestAbort.didTimeout();
        requestAbort.dispose();
        const cancelled = options.signal?.aborted === true;
        if (cancelled) {
          agentLogWarn(
            "llm.cancelled",
            llmFields(config, meta, {
              attempt,
              durationMs: Date.now() - startedAt,
            }),
          );
          throw new Error("Request cancelled");
        }
        const message = timedOut
          ? `Request timed out after ${requestAbort.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
        if (attempt < MAX_ATTEMPTS) {
          agentLogWarn(
            "llm.retry",
            llmFields(config, meta, {
              attempt,
              reason: timedOut ? "timeout" : "transport",
              message,
              nextAttempt: attempt + 1,
            }),
          );
          options.onProgress?.(
            timedOut
              ? "Model request timed out — retrying…"
              : "Retrying model request…",
          );
          await sleep(backoffMs(attempt), options.signal);
          continue;
        }
        agentLogError(
          "llm.error",
          llmFields(config, meta, {
            attempt,
            reason: timedOut ? "timeout" : "transport",
            message,
            durationMs: Date.now() - startedAt,
          }),
        );
        throw new Error(message);
      }
      requestAbort.dispose();
      const choice = (
        data as {
          choices?: Array<{
            finish_reason?: string | null;
            message?: {
              content?: unknown;
              reasoning_content?: unknown;
              reasoning?: unknown;
            };
          }>;
        }
      ).choices?.[0];
      const incompleteMessage = incompleteCompletionMessage(choice?.finish_reason);
      if (incompleteMessage) {
        agentLogError("llm.error", llmFields(config, meta, {
          attempt,
          reason: "incomplete_response",
          message: incompleteMessage,
          durationMs: Date.now() - startedAt,
          finishReason: choice?.finish_reason,
        }));
        throw new Error(incompleteMessage);
      }
      const message = choice?.message;
      const rawContent = message?.content;
      const rawReasoning =
        message?.reasoning_content ?? message?.reasoning;
      // Some local reasoning models fill reasoning_* and leave content empty
      // when the token budget is tight; prefer content, then reasoning text.
      const content =
        typeof rawContent === "string" && rawContent.trim().length > 0
          ? rawContent
          : typeof rawReasoning === "string" && rawReasoning.trim().length > 0
            ? rawReasoning
            : rawContent;
      if (typeof content !== "string" || content.trim().length === 0) {
        agentLogError(
          "llm.error",
          llmFields(config, meta, {
            attempt,
            reason: "empty_response",
            message: "Empty model response",
            durationMs: Date.now() - startedAt,
            finishReason: choice?.finish_reason ?? null,
            contentType: message ? typeof message.content : null,
          }),
        );
        timeline?.noteHttpStatus(response.status);
        throw new Error("Empty model response");
      }
      const trimmed = content.trim();
      const parsedUsage = parseOpenAiUsage(
        (data as { usage?: unknown }).usage,
      );
      if (parsedUsage) {
        timeline?.observe(parsedUsage);
      }
      agentLogInfo(
        "llm.response",
        llmFields(config, meta, {
          attempt,
          durationMs: Date.now() - startedAt,
          textChars: trimmed.length,
          httpStatus: response.status,
          ...(parsedUsage && parsedUsage.type === "usage"
            ? {
                ...(typeof parsedUsage.promptTokens === "number"
                  ? { promptTokens: parsedUsage.promptTokens }
                  : {}),
                ...(typeof parsedUsage.completionTokens === "number"
                  ? { completionTokens: parsedUsage.completionTokens }
                  : {}),
                ...(typeof parsedUsage.totalTokens === "number"
                  ? { totalTokens: parsedUsage.totalTokens }
                  : {}),
                ...(typeof parsedUsage.cachedTokens === "number"
                  ? { cachedTokens: parsedUsage.cachedTokens }
                  : {}),
                ...(typeof parsedUsage.cacheWriteTokens === "number"
                  ? { cacheWriteTokens: parsedUsage.cacheWriteTokens }
                  : {}),
              }
            : {}),
        }),
      );
      return { content: trimmed };
    }

    // Non-OK: stop the timer before reading the error body / deciding retry.
    requestAbort.dispose();
    const raw = await response.text().catch(() => "");
    const message = httpErrorMessage(response.status, raw);

    // DeepSeek / some gateways reject `json_schema` — fall back to `json_object`
    // once, then keep client-side schema validation (plan JSON, memory extract).
    const wireFormat = body.response_format as ChatResponseFormat | undefined;
    if (
      !jsonSchemaFallbackDone &&
      wireFormat?.type === "json_schema" &&
      isJsonSchemaResponseFormatUnsupported(response.status, message)
    ) {
      jsonSchemaFallbackDone = true;
      body.response_format = { type: "json_object" };
      agentLogWarn(
        "llm.response_format_fallback",
        llmFields(config, meta, {
          attempt,
          from: "json_schema",
          to: "json_object",
          httpStatus: response.status,
          message,
        }),
      );
      attempt -= 1;
      timeline?.noteRetry(attempt + 1);
      continue;
    }

    // Gateways that only support streaming (e.g. copilot.tencent.com returns
    // 400 {"code":11101,"msg":"Non-stream chat request is currently not
    // supported"}): retry once over streaming and aggregate the text.
    if (!streamFallbackDone && isNonStreamUnsupported(response.status, message)) {
      streamFallbackDone = true;
      agentLogWarn(
        "llm.stream_fallback",
        llmFields(config, meta, {
          attempt,
          httpStatus: response.status,
          message,
        }),
      );
      return await chatCompletionOnceViaStream(config, {
        ...options,
        // Preserve the effective format after any json_schema negotiation.
        ...(wireFormat ? { responseFormat: wireFormat } : {}),
      }, timeline);
    }

    const retryable = RETRYABLE_STATUS.has(response.status);
    if (retryable && attempt < MAX_ATTEMPTS) {
      const wait = retryAfterMs(response) ?? backoffMs(attempt);
      agentLogWarn(
        "llm.retry",
        llmFields(config, meta, {
          attempt,
          reason: "http",
          httpStatus: response.status,
          message,
          waitMs: wait,
          nextAttempt: attempt + 1,
        }),
      );
      timeline?.noteRetry(attempt + 1);
      options.onProgress?.("Retrying model request…");
      await sleep(wait, options.signal);
      continue;
    }
    agentLogError(
      "llm.error",
      llmFields(config, meta, {
        attempt,
        reason: "http",
        httpStatus: response.status,
        message,
        durationMs: Date.now() - startedAt,
      }),
    );
    timeline?.noteHttpStatus(response.status);
    throw new Error(message);
  }

  agentLogError(
    "llm.error",
    llmFields(config, meta, {
      reason: "retries_exhausted",
      message: "Model request failed after retries",
      durationMs: Date.now() - startedAt,
    }),
  );
  throw new Error("Model request failed after retries");
}

/**
 * Streaming fallback for gateways that reject `stream: false` (e.g.
 * copilot.tencent.com). Runs the same request with `stream: true` via the
 * streaming client (full retry policy, SSE parsing, timeline, agent logs) and
 * aggregates the emitted text into a single result.
 *
 * Throws on failure — the streaming client already exhausted its own retries,
 * so re-sending the non-streaming body would only reproduce the 400.
 */
async function chatCompletionOnceViaStream(
  config: OpenAiCompatibleClientConfig,
  options: LlmCompleteOptions,
  timeline: LlmTimelineEntry | undefined,
): Promise<LlmCompleteResult> {
  const events = streamChatCompletionImpl(
    config,
    {
      messages: options.messages,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.extraBody || options.responseFormat
        ? { extraBody: {
            ...(options.extraBody ?? {}),
            ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
          } }
        : {}),
      ...(options.extraHeaders ? { extraHeaders: options.extraHeaders } : {}),
      ...(options.promptCacheKey ? { promptCacheKey: options.promptCacheKey } : {}),
      ...(options.meta ? { meta: options.meta } : {}),
    },
    timeline,
    true,
  );
  let text = "";
  let reasoning = "";
  let streamError: string | undefined;
  let doneReason: string | undefined;
  for await (const event of events) {
    timeline?.observe(event);
    if (event.type === "text_delta") {
      text += event.text;
    } else if (event.type === "reasoning_delta") {
      // Local reasoning models can leave content empty; keep reasoning text
      // as a last-resort body, mirroring the non-streaming path.
      reasoning += event.text;
    } else if (event.type === "error") {
      streamError = event.message;
    } else if (event.type === "done") {
      doneReason = event.reason;
    }
  }
  if (doneReason === "cancelled") {
    throw new Error("Request cancelled");
  }
  const trimmed = (text.trim().length > 0 ? text : reasoning).trim();
  if (streamError) {
    throw new Error(streamError);
  }
  if (!trimmed) {
    agentLogError(
      "llm.error",
      llmFields(config, options.meta, {
        reason: "stream_fallback_empty",
        message: "Empty model response",
      }),
    );
    throw new Error("Empty model response");
  }
  return { content: trimmed };
}
