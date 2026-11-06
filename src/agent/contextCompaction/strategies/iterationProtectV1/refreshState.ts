import type { Session } from "../../../../session/types.js";
import { DEFAULT_CONTEXT_LIMIT_TOKENS } from "../../../../settings/types.js";
import type { CompactionBuildConfig } from "../../types.js";
import { walkProtectBoundary } from "./splitIterations.js";
import { findLatestIterationProtectCompaction } from "./messagesToOpenAi.js";

/**
 * Turn-end bookkeeping for iterationProtect — stores protect counts in
 * session.contextBuckets for Logs compatibility (hot ≈ protected).
 */
export function refreshSessionCompactionState(
  session: Session,
  config?: CompactionBuildConfig,
): void {
  const walk = walkProtectBoundary(session.messages, {
    contextLimitTokens:
      config?.contextLimitTokens ?? DEFAULT_CONTEXT_LIMIT_TOKENS,
    ...(config?.iterationProtectRawIterationCount !== undefined
      ? { rawIterationCount: config.iterationProtectRawIterationCount }
      : {}),
    ...(config?.iterationProtectTokenRatio !== undefined
      ? { tokenRatio: config.iterationProtectTokenRatio }
      : {}),
    ...(config?.reasoningScope !== undefined
      ? { reasoningScope: config.reasoningScope }
      : {}),
  });
  const latest = findLatestIterationProtectCompaction(session.messages);
  const protectedCount = walk.protectedIterations.length;
  const rawCap = walk.rawIterationCount;
  session.contextBuckets = {
    hotTurnCount: rawCap,
    warmTurnCount: 0,
    hot: protectedCount,
    warm: 0,
    cold: latest ? 1 : 0,
    updatedAt: Date.now(),
  };
}
