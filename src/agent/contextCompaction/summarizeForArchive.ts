import {
  chatCompletionOnce,
  DEFAULT_LLM_COMPACT_TIMEOUT_MS,
} from "../../llm/openaiCompatibleClient.js";
import { noReasoningExtraBody } from "../../llm/reasoningDisable.js";
import { reasoningScopeForClient } from "../../llm/contextScope.js";
import type {
  OpenAiChatMessage,
  OpenAiCompatibleClientConfig,
} from "../../llm/types.js";
import { agentLogInfo } from "../../logging/agentLog.js";
import { getDefaultSessionArchiveSummarizePrompt } from "../../settings/types.js";
import type { Message } from "../../session/types.js";
import { fitSummaryPayload, serializeIterationsForSummary } from "./strategies/iterationProtectV1/serializeForSummary.js";
import {
  coverageCursorId,
  findLatestIterationProtectCompaction,
  listAllIterationsNewestFirst,
  selectIterationsToSummarize,
} from "./strategies/iterationProtectV1/messagesToOpenAi.js";
import {
  walkProtectBoundary,
  type ProtectIteration,
} from "./strategies/iterationProtectV1/splitIterations.js";

/**
 * Final archival summary for a deleted session (session_history queue).
 *
 * Same merge semantics as compaction — previous rolling summary + every turn
 * after its coverage cursor — but with zero protected iterations (nothing
 * stays raw; the session is over) and no marker/session mutation. Input size
 * is naturally bounded: auto-compaction kept the uncovered set under the
 * compact trigger while the session lived. Edge sessions that outgrew that
 * guard (long skipCompact runs, prolonged compaction failures) get the older
 * turns clipped by fitSummaryPayload and the row is flagged input_truncated.
 *
 * Unlike compaction there is no deterministic fallback: LLM errors and empty
 * responses throw so the queue worker can retry patiently.
 */

export type SessionArchiveSummaryResult =
  | { kind: "empty" }
  | { kind: "discarded"; reason: string }
  | { kind: "summarized"; summary: string; inputTruncated: boolean };

export type SummarizeSessionForArchiveInput = {
  /** Full transcript (deserialized session_history payload). */
  messages: Message[];
  sessionId: string;
  client: OpenAiCompatibleClientConfig;
  contextLimitTokens: number;
  /** Injectable for tests; defaults to the non-streaming chat call. */
  summarize?: typeof chatCompletionOnce;
  signal?: AbortSignal;
};

/** Archival framing around the shared merge section structure. */
function buildArchiveUserPrompt(input: {
  previousSummary: string | null;
  content: string;
}): string {
  const template = getDefaultSessionArchiveSummarizePrompt().trim();
  if (input.previousSummary) {
    return (
      `${template}\n\n` +
      `You are producing the final archival record for a completed work session. ` +
      `A previous context-compaction summary already covers the older turns; the remaining turns below were never summarized. ` +
      `Merge both into one complete session record. ` +
      `The NO_ARCHIVE discard option does NOT apply here — this session has prior summarized work, so always produce the full merged summary.\n\n` +
      `PREVIOUS SUMMARY (older turns):\n${input.previousSummary}\n\n` +
      `REMAINING TURNS (never summarized):\n${input.content}\n\n` +
      `Produce the final archival summary using the exact structure in the instructions above. ` +
      `PRESERVE all still-relevant information from the previous summary. ` +
      `ADD the completed work from the remaining turns. ` +
      `Write only the summary body.`
    );
  }
  return (
    `${template}\n\n` +
    `You are producing the final archival record for a completed work session. ` +
    `Summarize the full session below for the long-term work-history record.\n\n` +
    `SESSION TURNS:\n${input.content}\n\n` +
    `Use the exact structure in the instructions above. Write only the summary body.`
  );
}

/** Sentinel prefix the prompt uses for the discard decision. */
export const NO_ARCHIVE_SENTINEL = "NO_ARCHIVE";

/**
 * Parse the NO_ARCHIVE discard verdict. Conservative by design: only the
 * first line counts, and it must be exactly the sentinel or
 * `NO_ARCHIVE: <reason>` (case-sensitive, colon-separated). A sentinel that
 * shows up mid-body is treated as summary content — never a discard.
 */
function parseNoArchiveSentinel(content: string): { reason: string } | null {
  const firstLine = content
    .trimStart()
    .split("\n", 1)[0]!
    .trim();
  if (firstLine === NO_ARCHIVE_SENTINEL) {
    return { reason: "" };
  }
  const prefix = `${NO_ARCHIVE_SENTINEL}:`;
  if (firstLine.startsWith(prefix)) {
    const reason = firstLine.slice(prefix.length).trim();
    if (reason) return { reason };
    return { reason: "" };
  }
  return null;
}

export async function summarizeSessionForArchive(
  input: SummarizeSessionForArchiveInput,
): Promise<SessionArchiveSummaryResult> {
  const summarize = input.summarize ?? chatCompletionOnce;
  const messages = input.messages;
  if (messages.length === 0) {
    return { kind: "empty" };
  }

  // Zero-retention walk (same shape as compactSession's full digest):
  // tokenRatio 0 → protect budget 0 → boundary at the newest iteration.
  const walk = walkProtectBoundary(messages, {
    contextLimitTokens: input.contextLimitTokens,
    rawIterationCount: 0,
    tokenRatio: 0,
  });

  const latest = findLatestIterationProtectCompaction(messages);
  const previousSummary = latest?.part.summary?.trim() || null;

  let toSummarize: ProtectIteration[] = [];
  if (walk.boundary) {
    toSummarize = selectIterationsToSummarize(
      listAllIterationsNewestFirst(messages),
      walk.boundary,
      latest ? coverageCursorId(latest.part) : undefined,
      messages,
    );
  }

  if (toSummarize.length === 0) {
    // Nothing new since the last compaction: that summary already IS the
    // complete record — persist it directly without an LLM call.
    if (previousSummary) {
      return { kind: "summarized", summary: previousSummary, inputTruncated: false };
    }
    // No model iterations and no prior summary (marker-only / stray system
    // messages): nothing to archive beyond metadata.
    return { kind: "empty" };
  }

  let serialized = serializeIterationsForSummary(toSummarize, {
    reasoningScope: reasoningScopeForClient(input.client),
  });
  const fitted = fitSummaryPayload(serialized, input.contextLimitTokens);
  const inputTruncated = fitted.length < serialized.length;
  serialized = fitted;

  const userPrompt = buildArchiveUserPrompt({
    previousSummary,
    content: serialized,
  });

  agentLogInfo("archive.summarize.input", {
    sessionId: input.sessionId,
    roundCount: toSummarize.length,
    messageCount: messages.length,
    payloadChars: serialized.length,
    inputTruncated,
    previousSummaryChars: previousSummary?.length ?? 0,
  });

  const wireMessages: OpenAiChatMessage[] = [
    { role: "user", content: userPrompt },
  ];
  const result = await summarize(input.client, {
    messages: wireMessages,
    meta: {
      sessionId: input.sessionId,
      purpose: "session_archive_summarize",
    },
    // Archival summaries should not burn reasoning tokens.
    extraBody: noReasoningExtraBody(input.client.baseUrl),
    timeoutMs: DEFAULT_LLM_COMPACT_TIMEOUT_MS,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const content = result.content.trim();
  if (!content) {
    throw new Error("session archive summarize returned empty content");
  }
  // Fresh sessions only: the LLM may answer with the discard verdict.
  // Sessions with a previous compaction summary always summarize (the
  // merge framing disables the option); a sentinel there is a model
  // misfire — treat it as a failure so the queue retries patiently.
  const discard = parseNoArchiveSentinel(content);
  if (previousSummary) {
    if (discard) {
      throw new Error(
        "session archive summarize returned NO_ARCHIVE despite a previous summary",
      );
    }
  } else if (discard) {
    agentLogInfo("archive.summarize.discarded", {
      sessionId: input.sessionId,
      reason: discard.reason,
    });
    return { kind: "discarded", reason: discard.reason };
  }
  return { kind: "summarized", summary: content, inputTruncated };
}
