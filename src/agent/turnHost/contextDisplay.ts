import type { StreamEvent } from "../../llm/streamEvents.js";
import { agentLogInfo } from "../../logging/agentLog.js";
import type { Session } from "../../session/types.js";
import { emit } from "./emit.js";
import { touch } from "./touch.js";

/**
 * Composer context ring is provider-only: local estimates (stream-length
 * heuristics, post-compact BPE) no longer drive the display — the ring holds
 * its last provider reading until the next usage event lands. Estimate-source
 * calls stay wired at the call sites for internal bookkeeping but emit
 * nothing.
 */
export function emitContextDisplay(
  session: Session,
  onEvent: ((event: StreamEvent) => void) | undefined,
  usedTokens: number,
  source: "provider" | "estimate",
): void {
  if (source !== "provider") return;
  const rounded = Math.max(0, Math.round(usedTokens));
  const nextUsage: Session["contextUsage"] = {
    ...session.contextUsage,
    displayUsedTokens: rounded,
  };
  session.contextUsage = nextUsage;
  const event: Extract<StreamEvent, { type: "context_display" }> = {
    type: "context_display",
    usedTokens: rounded,
    source,
  };
  if (typeof session.contextUsage.cachedTokens === "number") {
    event.cachedTokens = session.contextUsage.cachedTokens;
  }
  emit(onEvent, event);
}

export function applyUsageToSession(
  session: Session,
  event: Extract<StreamEvent, { type: "usage" }>,
  estimatedFallback: number,
  onEvent?: (event: StreamEvent) => void,
): boolean {
  const previous = session.contextUsage.usedTokens;
  const hasRealPrompt =
    (typeof event.promptTokens === "number" && event.promptTokens > 0) ||
    (typeof event.totalTokens === "number" && event.totalTokens > 0);
  // Providers often emit empty usage placeholders mid-stream; wait for the
  // final non-zero reading so compact / cache counts stay meaningful.
  if (!hasRealPrompt) {
    return false;
  }

  let next: number;
  if (typeof event.promptTokens === "number" && event.promptTokens > 0) {
    next = event.promptTokens;
  } else if (typeof event.totalTokens === "number" && event.totalTokens > 0) {
    next = event.totalTokens;
  } else {
    next = estimatedFallback;
  }
  // Providers sometimes emit a zero usage chunk mid-stream; do not clear a
  // known-good reading until a positive (or first) value arrives.
  if (next === 0 && previous > 0) {
    agentLogInfo("context.usage.keep", {
      sessionId: session.id,
      previous,
      incoming: next,
      promptTokens: event.promptTokens ?? null,
      totalTokens: event.totalTokens ?? null,
      cachedTokens: event.cachedTokens ?? null,
      estimatedFallback,
    });
    return false;
  }
  const nextUsage: Session["contextUsage"] = {
    usedTokens: next,
    displayUsedTokens: next,
    source: "provider",
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
  emitContextDisplay(session, onEvent, next, "provider");
  return true;
}
