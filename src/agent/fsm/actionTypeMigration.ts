/** @deprecated Import compatibility/loadGraphConfig for whole-graph input handling. */
export { migrateActionParams } from "./compatibility/legacyActionParams.js";
export { resolveActionType, resolvePinName } from "./compatibility/legacyAliases.js";
import { loadGraphConfig } from "./compatibility/loadGraphConfig.js";
import type { FSMGraphConfig } from "./types.js";

export function migrateFSMGraphConfig(config: unknown): FSMGraphConfig {
  return loadGraphConfig(config).config;
}
