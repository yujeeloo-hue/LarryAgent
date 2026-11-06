import { chatCompletionOnce } from "../llm/openaiCompatibleClient.js";
import { noReasoningExtraBody } from "../llm/reasoningDisable.js";
import type { OpenAiCompatibleClientConfig } from "../llm/types.js";
import { agentLogError, agentLogInfo, agentLogWarn } from "../logging/agentLog.js";

/**
 * One-shot user-prompt optimizer for the composer `/opt` command
 * (docs/plans/20260828-composer-prompt-optimizer.md). Mirrors generateTitle:
 * reuses the caller-resolved session client, disables reasoning,
 * non-streaming, short wall-clock cap. Any failure returns
 * null — the composer keeps the `/opt` draft and shows an error hint.
 */

/** Wall-clock cap for the optimize call (failure keeps the draft). */
export const PROMPT_OPTIMIZE_TIMEOUT_MS = 10_000;

export type PromptOptimizeInput = {
  /** Prompt text after the `/opt` command (whitespace-trimmed by the caller). */
  text: string;
  /** Client resolved for the target session / composer provider selection. */
  client: OpenAiCompatibleClientConfig;
  sessionId?: string;
};

const OPTIMIZER_SYSTEM_PROMPT = [
  "You clean up a user's prompt before it is sent to a coding agent.",
  "Fix typos, wrong characters, grammar mistakes, and awkward phrasing so the intent reads clearly and logically.",
  "Rules: keep the original language and meaning;",
  "keep code blocks, commands, file paths, and technical identifiers exactly as written;",
  "do not add new information, questions, or translations;",
  "when nothing needs fixing, echo the original text unchanged.",
  "Output only the rewritten prompt as plain text — no explanations, labels, quotes, or markdown fences.",
].join(" ");

/** Whole-message markdown fence, e.g. ```text\n...\n``` */
const WRAPPING_FENCE_RE = /^```(?:\w+)?[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```$/;

/** Leading scaffold label like "Optimized prompt:" (newline after optional). */
const LABEL_PREFIX_RE =
  /^(?:optimized|rewritten|revised|polished|corrected)\s+prompt\s*[:：][ \t]*\r?\n?/i;

const QUOTE_CHARS = "\"'`“”‘’";

/**
 * Normalize model output into sendable prompt text: strip a wrapping fence,
 * a scaffold label prefix, and one layer of wrapping quotes. Returns null
 * when empty or over the length guard (explanations leaked / runaway
 * rewrite) — callers keep the original draft then.
 */
export function sanitizeOptimizedPrompt(
  raw: string,
  original: string,
): string | null {
  let text = raw.trim();
  if (!text) return null;

  const fence = text.match(WRAPPING_FENCE_RE);
  if (fence?.[1]) {
    text = fence[1].trim();
    if (!text) return null;
  }

  text = text.replace(LABEL_PREFIX_RE, "").trim();
  if (!text) return null;

  let start = 0;
  let end = text.length;
  while (start < end && QUOTE_CHARS.includes(text.charAt(start))) start += 1;
  while (end > start && QUOTE_CHARS.includes(text.charAt(end - 1))) end -= 1;
  text = text.slice(start, end).trim();
  if (!text) return null;

  if (text.length > original.length * 3 + 200) return null;
  return text;
}

/**
 * Optimize one prompt with the resolved session client. Never throws —
 * request errors and rejected outputs log and return null (the composer
 * keeps the `/opt` draft). Reasoning is disabled on this call: one quick
 * non-streaming pass, 10s cap.
 */
export async function optimizeUserPromptOnce(
  input: PromptOptimizeInput,
): Promise<string | null> {
  const original = input.text.trim();
  if (!original) return null;

  try {
    const result = await chatCompletionOnce(input.client, {
      messages: [
        { role: "system", content: OPTIMIZER_SYSTEM_PROMPT },
        { role: "user", content: original },
      ],
      meta: {
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        purpose: "prompt_optimize",
      },
      timeoutMs: PROMPT_OPTIMIZE_TIMEOUT_MS,
      extraBody: noReasoningExtraBody(input.client.baseUrl),
    });

    const optimized = sanitizeOptimizedPrompt(result.content, original);
    if (!optimized) {
      agentLogWarn("prompt.optimize.rejected", {
        sessionId: input.sessionId,
        originalChars: original.length,
        rawChars: result.content.length,
      });
      return null;
    }
    agentLogInfo("prompt.optimize.done", {
      sessionId: input.sessionId,
      originalChars: original.length,
      optimizedChars: optimized.length,
    });
    return optimized;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    agentLogError("prompt.optimize.error", {
      sessionId: input.sessionId,
      message,
    });
    return null;
  }
}
