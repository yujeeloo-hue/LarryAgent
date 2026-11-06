import type {
  CompactionStrategyId,
  ContextCompactionStrategy,
} from "./types.js";
import { DEFAULT_COMPACTION_STRATEGY_ID } from "./types.js";
import { iterationProtectV1Strategy } from "./strategies/iterationProtectV1/strategy.js";

const strategies = new Map<CompactionStrategyId, ContextCompactionStrategy>();

let registered = false;

export function registerCompactionStrategies(): void {
  if (registered) return;
  strategies.set(iterationProtectV1Strategy.id, iterationProtectV1Strategy);
  registered = true;
}

export function getCompactionStrategy(
  id?: CompactionStrategyId | string | null,
): ContextCompactionStrategy {
  registerCompactionStrategies();
  const key =
    id === "iterationProtectV1" ? id : DEFAULT_COMPACTION_STRATEGY_ID;
  return strategies.get(key) ?? iterationProtectV1Strategy;
}

