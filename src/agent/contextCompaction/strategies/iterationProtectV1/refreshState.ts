import type { Session } from "../../../../session/types.js";
import { DEFAULT_CONTEXT_LIMIT_TOKENS } from "../../../../settings/types.js";
import type { CompactionBuildConfig } from "../../types.js";
import { messagesAfterModelWindowFloor } from "../../messagesToOpenAi.js";
import { findLatestIterationProtectCompaction } from "./messagesToOpenAi.js";
import { walkProtectBoundary } from "./splitIterations.js";

export function refreshSessionCompactionState(
  session: Session,
  config?: CompactionBuildConfig,
): void {
  const scope = messagesAfterModelWindowFloor(session.messages);
  const walk = walkProtectBoundary(scope, {
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
  const latest = findLatestIterationProtectCompaction(scope);
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
