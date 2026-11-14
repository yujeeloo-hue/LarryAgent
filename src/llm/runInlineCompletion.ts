/**
 * One short, non-retrying completion for Dev Mode ghost text.
 * Gives up when the first visible token misses the deadline. Reasoning is
 * forced off — a thinking model cannot keep up with typing.
 */
import { agentLogInfo, agentLogWarn } from "../logging/agentLog.js";
import { streamChatCompletion } from "./openaiCompatibleClient.js";
import { noReasoningExtraBody } from "./reasoningDisable.js";
import type { OpenAiCompatibleClientConfig } from "./types.js";
import {
  buildInlineCompletionMessages,
  sanitizeInlineCompletion,
  shouldRequestCompletion,
  INLINE_PREFIX_CHARS,
  INLINE_SUFFIX_CHARS,
} from "./inlineCompletion.js";

/** No text by this time → show nothing. */
export const INLINE_FIRST_TOKEN_MS = 1_200;
/** Hard stop so a slow stream cannot sit on the socket. */
export const INLINE_TOTAL_MS = 2_500;
/** One line, maybe a short block. */
export const INLINE_MAX_TOKENS = 32;

export type RunInlineCompletionInput = {
  client: OpenAiCompatibleClientConfig;
  prefix: string;
  suffix: string;
  languageId: string;
  fileName: string;
  signal?: AbortSignal;
  sessionId?: string;
  firstTokenMs?: number;
  totalMs?: number;
};

export async function runInlineCompletion(
  input: RunInlineCompletionInput,
): Promise<string | null> {
  const prefix = input.prefix.slice(-(INLINE_PREFIX_CHARS + 500));
  const suffix = input.suffix.slice(0, INLINE_SUFFIX_CHARS + 200);
  if (!shouldRequestCompletion(prefix, suffix)) return null;

  const firstTokenMs = input.firstTokenMs ?? INLINE_FIRST_TOKEN_MS;
  const totalMs = input.totalMs ?? INLINE_TOTAL_MS;
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort();
  input.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (input.signal?.aborted) controller.abort();

  let raw = "";
  let sawText = false;
  const started = Date.now();
  const firstTimer = setTimeout(() => {
    if (!sawText) controller.abort();
  }, firstTokenMs);
  const totalTimer = setTimeout(() => controller.abort(), totalMs);

  try {
    for await (const event of streamChatCompletion(
      { ...input.client, disableReasoning: true },
      {
        messages: buildInlineCompletionMessages({
          languageId: input.languageId,
          fileName: input.fileName,
          prefix,
          suffix,
        }),
        signal: controller.signal,
        timeoutMs: firstTokenMs,
        maxAttempts: 1,
        promptCacheKey: "inline-completion",
        extraBody: noReasoningExtraBody(input.client.baseUrl, {
          max_tokens: INLINE_MAX_TOKENS,
        }),
        meta: {
          purpose: "inline_completion",
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        },
      },
    )) {
      if (event.type !== "text_delta") continue;
      if (!sawText) {
        sawText = true;
        clearTimeout(firstTimer);
      }
      raw += event.text;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    agentLogWarn("inlineCompletion.error", {
      message,
      durationMs: Date.now() - started,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });
  } finally {
    clearTimeout(firstTimer);
    clearTimeout(totalTimer);
    input.signal?.removeEventListener("abort", onCallerAbort);
  }

  const text = sanitizeInlineCompletion(raw, prefix, suffix);
  if (!text) return null;
  agentLogInfo("inlineCompletion.done", {
    chars: text.length,
    durationMs: Date.now() - started,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
  return text;
}
