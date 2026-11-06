import {
  chatCompletionOnce,
  DEFAULT_LLM_COMPACT_TIMEOUT_MS,
} from "../../../../llm/openaiCompatibleClient.js";
import { noReasoningExtraBody } from "../../../../llm/reasoningDisable.js";
import { reasoningScopeForClient } from "../../../../llm/contextScope.js";
import type { OpenAiChatMessage } from "../../../../llm/types.js";
import {
  agentLogCompactArtifact,
  agentLogInfo,
  agentLogWarn,
  newCompactArtifactRunId,
} from "../../../../logging/agentLog.js";
import {
  DEFAULT_COMPACT_TRIGGER_RATIO,
  DEFAULT_ITERATION_PROTECT_RAW_ITERATION_COUNT,
  DEFAULT_ITERATION_PROTECT_TOKEN_RATIO,
  getDefaultCompactIterationProtectPrompt,
} from "../../../../settings/types.js";
import type {
  ContextCompactionPart,
  Message,
  Session,
  SystemMessage,
} from "../../../../session/types.js";
import {
  estimateTokensForRequest,
  resolveDecisionTokens,
} from "../../../estimateTokens.js";
import type {
  CompactBeforeIterationInput,
  CompactContextResult,
} from "../../types.js";
import {
  fitSummaryPayload,
  serializeIterationsForSummary,
} from "./serializeForSummary.js";
import { buildDemoVerbatimAppendix } from "./demoAppendix.js";
import {
  buildModelMessages,
  coverageCursorId,
  findLatestIterationProtectCompaction,
  listAllIterationsNewestFirst,
  selectIterationsToSummarize,
} from "./messagesToOpenAi.js";
import {
  firstMessageId,
  lastMessageId,
  walkProtectBoundary,
} from "./splitIterations.js";

function emit(
  onEvent: CompactBeforeIterationInput["onEvent"],
  event: Parameters<NonNullable<CompactBeforeIterationInput["onEvent"]>>[0],
): void {
  onEvent?.(event);
}

function removeIterationProtectMarkers(messages: Message[]): void {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]!;
    if (msg.role !== "system") continue;
    if (msg.parts.some((p) => p.type === "context_compaction")) {
      messages.splice(i, 1);
    }
  }
}

function buildSummarizeUserPrompt(input: {
  systemTemplate: string;
  previousSummary: string | null;
  content: string;
}): string {
  const template = input.systemTemplate.trim();
  if (input.previousSummary) {
    return (
      `${template}\n\n` +
      `You are updating a context compaction summary. A previous compaction produced the summary below. ` +
      `New conversation turns have occurred since then and need to be incorporated.\n\n` +
      `PREVIOUS SUMMARY:\n${input.previousSummary}\n\n` +
      `NEW TURNS TO INCORPORATE:\n${input.content}\n\n` +
      `Update the summary using the exact structure in the instructions above. ` +
      `PRESERVE all existing information that is still relevant. ADD new completed actions. ` +
      `Update "## Active Task" to the user's most recent unfulfilled request. ` +
      `Write only the summary body.`
    );
  }
  return (
    `${template}\n\n` +
    `Create a structured handoff summary for a different assistant that will continue this conversation ` +
    `after earlier turns are compacted.\n\n` +
    `TURNS TO SUMMARIZE:\n${input.content}\n\n` +
    `Use the exact structure in the instructions above. Write only the summary body.`
  );
}

function deterministicFallbackSummary(content: string): string {
  const clipped =
    content.length > 12_000
      ? `${content.slice(0, 5_000)}\n[...truncated...]\n${content.slice(-5_000)}`
      : content;
  return (
    `## Active Task\n(Unavailable — deterministic fallback)\n\n` +
    `## Critical Context\n${clipped}`
  );
}

async function summarizeIterations(input: {
  client: CompactBeforeIterationInput["client"];
  summarize: typeof chatCompletionOnce;
  sessionId: string;
  userPrompt: string;
  content: string;
  signal?: AbortSignal;
}): Promise<{ summary: string; fallback: boolean }> {
  const messages: OpenAiChatMessage[] = [
    { role: "user", content: input.userPrompt },
  ];
  try {
    const result = await input.summarize(input.client, {
      messages,
      meta: {
        sessionId: input.sessionId,
        purpose: "compact-iteration-protect",
      },
      // Iteration-protect summaries should not burn reasoning tokens.
      extraBody: noReasoningExtraBody(input.client.baseUrl),
      timeoutMs: DEFAULT_LLM_COMPACT_TIMEOUT_MS,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const text = result.content.trim();
    if (!text) {
      agentLogWarn("compact.iteration_protect.empty", {
        sessionId: input.sessionId,
      });
      return {
        summary: deterministicFallbackSummary(input.content),
        fallback: true,
      };
    }
    return { summary: text, fallback: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    agentLogWarn("compact.iteration_protect.fallback", {
      sessionId: input.sessionId,
      error: message,
    });
    return {
      summary: deterministicFallbackSummary(input.content),
      fallback: true,
    };
  }
}

function estimateConversationTokens(
  session: Session,
  tools: CompactBeforeIterationInput["tools"],
  buildConfig: {
    reasoningScope?: string;
    contextLimitTokens: number;
    iterationProtectRawIterationCount: number;
    iterationProtectTokenRatio: number;
  },
): number {
  return estimateTokensForRequest(
    buildModelMessages(session.messages, buildConfig),
    tools,
  ).decision;
}

/**
 * Iteration-protect compact: trigger at compactTriggerRatio, protect newest N
 * iterations under token budget, LLM-summarize the rest (iterative merge).
 */
export async function maybeCompactBeforeIteration(
  input: CompactBeforeIterationInput,
): Promise<CompactContextResult> {
  const {
    session,
    client,
    createId,
    contextLimitTokens,
    tools,
    signal,
    onEvent,
  } = input;
  const compactTriggerRatio =
    input.compactTriggerRatio ?? DEFAULT_COMPACT_TRIGGER_RATIO;
  const rawIterationCount =
    input.iterationProtectRawIterationCount ?? DEFAULT_ITERATION_PROTECT_RAW_ITERATION_COUNT;
  const tokenRatio =
    input.iterationProtectTokenRatio ?? DEFAULT_ITERATION_PROTECT_TOKEN_RATIO;
  const summarize = input.summarize ?? chatCompletionOnce;
  const systemTemplate =
    input.iterationProtectSummarizePrompt?.trim() ||
    getDefaultCompactIterationProtectPrompt();

  const buildConfig = {
    reasoningScope: reasoningScopeForClient(client),
    contextLimitTokens,
    iterationProtectRawIterationCount: rawIterationCount,
    iterationProtectTokenRatio: tokenRatio,
  };

  // Prefer host full-window estimate (system + conversation + overlay + tools)
  // so compact and hard-truncate share one estimate fallback; conversation-only
  // estimate is only a last-resort when the host did not pass one.
  const estimateTokens =
    typeof input.windowEstimateTokens === "number" &&
    Number.isFinite(input.windowEstimateTokens)
      ? Math.max(0, Math.floor(input.windowEstimateTokens))
      : estimateConversationTokens(session, tools, buildConfig);
  const { decisionTokens: triggerTokens, source: triggerSource } =
    resolveDecisionTokens(session.contextUsage, estimateTokens);
  const trigger = Math.floor(contextLimitTokens * compactTriggerRatio);
  if (!input.force && triggerTokens < trigger) {
    return { compacted: false, estimatedTokens: triggerTokens };
  }

  const walk = walkProtectBoundary(session.messages, {
    contextLimitTokens,
    rawIterationCount,
    tokenRatio,
    reasoningScope: buildConfig.reasoningScope,
  });

  if (!walk.boundary) {
    agentLogInfo("compact.skip", {
      sessionId: session.id,
      reason: "all_iterations_protected",
      protected: walk.protectedIterations.length,
      protectedTokens: walk.protectedTokens,
      triggerTokens,
      triggerSource,
    });
    return { compacted: false, estimatedTokens: triggerTokens };
  }

  const latest = findLatestIterationProtectCompaction(session.messages);
  const allRounds = listAllIterationsNewestFirst(session.messages);
  const toSummarize = selectIterationsToSummarize(
    allRounds,
    walk.boundary,
    latest ? coverageCursorId(latest.part) : undefined,
    session.messages,
  );

  if (toSummarize.length === 0) {
    agentLogInfo("compact.skip", {
      sessionId: session.id,
      reason: "no_new_iterations_to_summarize",
      triggerTokens,
      triggerSource,
    });
    return { compacted: false, estimatedTokens: triggerTokens };
  }

  emit(onEvent, {
    type: "progress",
    text: `Compacting context · ${toSummarize.length} iterations…`,
  });
  session.progressText = `Compacting context · ${toSummarize.length} iterations…`;
  session.updatedAt = Date.now();

  let serialized = serializeIterationsForSummary(toSummarize, {
    reasoningScope: buildConfig.reasoningScope,
  });
  serialized = fitSummaryPayload(serialized, contextLimitTokens);

  const previousSummary = latest?.part.summary?.trim() || null;
  const coverMode = previousSummary
    ? "iteration_protect_merge"
    : "iteration_protect_full";
  const userPrompt = buildSummarizeUserPrompt({
    systemTemplate,
    previousSummary,
    content: serialized,
  });
  const artifactRunId = newCompactArtifactRunId();
  const summarizedIterationIds = toSummarize.map((round) => ({
    age: round.age,
    chronoIndex: round.chronoIndex,
    userPrefixIds: round.userPrefix.map((m) => m.id),
    messageIds: round.messages.map((m) => m.id),
    tokens: round.tokens,
  }));

  agentLogInfo("compact.cover", {
    sessionId: session.id,
    coverMode,
    roundCount: toSummarize.length,
    protected: walk.protectedIterations.length,
    messageCount: session.messages.length,
    payloadChars: serialized.length,
    artifactRunId,
    triggerTokens,
    triggerSource,
    estimateTokens,
  });

  agentLogCompactArtifact({
    sessionId: session.id,
    strategy: "iterationProtectV1",
    phase: "input",
    runId: artifactRunId,
    coverMode,
    meta: {
      roundCount: toSummarize.length,
      protected: walk.protectedIterations.length,
      messageCount: session.messages.length,
      payloadChars: serialized.length,
      previousSummaryChars: previousSummary?.length ?? 0,
      userPromptChars: userPrompt.length,
      triggerTokens,
      triggerSource,
      estimateTokens,
      contextLimitTokens,
    },
    data: {
      previousSummary,
      serializedTurns: serialized,
      userPrompt,
      summarizedRounds: summarizedIterationIds,
      protectedRoundCount: walk.protectedIterations.length,
      protectedTokens: walk.protectedTokens,
      boundaryAge: walk.boundary.age,
      priorCoveredThroughMessageId: latest
        ? coverageCursorId(latest.part)
        : null,
    },
  });

  const { summary, fallback } = await summarizeIterations({
    client,
    summarize,
    sessionId: session.id,
    userPrompt,
    content: serialized,
    ...(signal ? { signal } : {}),
  });

  if (signal?.aborted) {
    return {
      compacted: false,
      estimatedTokens: triggerTokens,
      error: "Cancelled",
    };
  }

  const fromId = firstMessageId(toSummarize[0]!) ?? session.messages[0]?.id ?? "";
  const coveredThrough =
    lastMessageId(toSummarize[toSummarize.length - 1]!) ?? fromId;
  const toId = coveredThrough;

  removeIterationProtectMarkers(session.messages);

  // Mechanical verbatim appendix (plan §7): rebuilt from the full transcript
  // on every compaction — demo decisions never rely on LLM summary fidelity.
  const demoVerbatim = buildDemoVerbatimAppendix(session.messages);

  const part: ContextCompactionPart = {
    type: "context_compaction",
    id: createId(),
    summary,
    fromMessageId: fromId,
    toMessageId: toId,
    usedTokensBefore: triggerTokens,
    usedTokensAfter: 0,
    coveredThroughMessageId: coveredThrough,
    ...(demoVerbatim ? { demoVerbatim } : {}),
  };

  const marker: SystemMessage = {
    id: createId(),
    role: "system",
    createdAt: Date.now(),
    parts: [part],
  };
  session.messages.push(marker);

  const after = estimateTokensForRequest(
    buildModelMessages(session.messages, buildConfig),
    tools,
  ).decision;
  part.usedTokensAfter = after;
  session.contextUsage = {
    ...session.contextUsage,
    usedTokens: after,
    source: "estimate",
  };
  session.updatedAt = Date.now();

  agentLogCompactArtifact({
    sessionId: session.id,
    strategy: "iterationProtectV1",
    phase: "output",
    runId: artifactRunId,
    coverMode,
    meta: {
      fallback,
      summaryChars: summary.length,
      demoVerbatimChars: demoVerbatim?.length ?? 0,
      usedTokensBefore: triggerTokens,
      usedTokensAfter: after,
      summarizedRounds: toSummarize.length,
      protectedIterations: walk.protectedIterations.length,
    },
    data: {
      fallback,
      summary,
      ...(demoVerbatim ? { demoVerbatim } : {}),
      marker: {
        id: marker.id,
        fromMessageId: fromId,
        toMessageId: toId,
        coveredThroughMessageId: coveredThrough,
        usedTokensBefore: triggerTokens,
        usedTokensAfter: after,
      },
    },
  });

  agentLogInfo("compact.done", {
    sessionId: session.id,
    strategy: "iterationProtectV1",
    usedTokensBefore: triggerTokens,
    usedTokensAfter: after,
    summarizedRounds: toSummarize.length,
    protectedIterations: walk.protectedIterations.length,
    fallback,
    artifactRunId,
  });

  return { compacted: true, estimatedTokens: after };
}
