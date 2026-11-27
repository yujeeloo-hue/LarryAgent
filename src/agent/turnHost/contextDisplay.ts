import type { StreamEvent } from "../../llm/streamEvents.js";
import { agentLogInfo } from "../../logging/agentLog.js";
import type { Session } from "../../session/types.js";
import type { ContextUsageBreakdown } from "../../shared/contextUsageBreakdown.js";
import { emit } from "./emit.js";
import { touch } from "./touch.js";

function publishContextDisplay(
  usage: Session["contextUsage"],
  onEvent: ((event: StreamEvent) => void) | undefined,
): void {
  if (!usage.source) return;
  emit(onEvent, {
    type: "context_display",
    usedTokens: Math.round(usage.usedTokens),
    source: usage.source,
    ...(usage.cachedTokens !== undefined ? { cachedTokens: usage.cachedTokens } : {}),
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.breakdown ? { breakdown: usage.breakdown } : {}),
  });
}

export function setEstimatedContextDisplay(
  session: Session,
  onEvent: ((event: StreamEvent) => void) | undefined,
  usedTokens: number,
  breakdown: ContextUsageBreakdown | undefined,
): void {
  session.contextUsage = {
    usedTokens,
    displayUsedTokens: usedTokens,
    source: "estimate",
    ...(breakdown ? { breakdown } : {}),
  };
  publishContextDisplay(session.contextUsage, onEvent);
}

export function applyUsageToSession(
  session: Session,
  event: Extract<StreamEvent, { type: "usage" }>,
  estimatedFallback: number,
  onEvent?: (event: StreamEvent) => void,
  breakdown?: ContextUsageBreakdown,
): boolean {
  const previous = session.contextUsage.usedTokens;
  const prompt = event.promptTokens;
  const total = event.totalTokens;
  const completion = event.completionTokens;
  const hasPrompt = typeof prompt === "number" && Number.isFinite(prompt) && prompt > 0;
  const hasTotal = typeof total === "number" && Number.isFinite(total) && total > 0;
  const next = hasPrompt ? prompt : hasTotal ? total : undefined;
  if (next === undefined) return false;
  const inputTokens = hasPrompt ? prompt :
    hasTotal && typeof completion === "number" && completion >= 0 && completion < total
      ? total - completion
      : null;
  const nextUsage: Session["contextUsage"] = {
    usedTokens: next,
    displayUsedTokens: Math.round(next),
    source: "provider",
    inputTokens,
    ...(inputTokens !== null && breakdown ? { breakdown } : {}),
    ...(estimatedFallback > 0 ? { requestEstimateTokens: Math.round(estimatedFallback) } : {}),
  };
  if (typeof event.cachedTokens === "number") {
    nextUsage.cachedTokens = event.cachedTokens;
  }
  session.contextUsage = nextUsage;
  if (previous !== next) {
    agentLogInfo("context.usage.update", {
      sessionId: session.id,
      from: previous,
      to: next,
      promptTokens: event.promptTokens ?? null,
      totalTokens: event.totalTokens ?? null,
      cachedTokens: event.cachedTokens ?? null,
      cacheWriteTokens: event.cacheWriteTokens ?? null,
      estimatedFallback,
      source: "provider",
    });
  } else if (typeof event.cachedTokens === "number") {
    agentLogInfo("context.usage.cache", {
      sessionId: session.id,
      usedTokens: next,
      cachedTokens: event.cachedTokens,
      cacheWriteTokens: event.cacheWriteTokens ?? null,
    });
  }
  touch(session);
  publishContextDisplay(nextUsage, onEvent);
  return true;
}
