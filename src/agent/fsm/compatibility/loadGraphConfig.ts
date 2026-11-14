import { FSMConfigError } from "../FSMConfigError.js";
import { FSM_GRAPH_CONFIG_VERSION } from "../constants.js";
import type { FSMGraphConfig } from "../types.js";
import { migrateV1ToV2 } from "./migrations/v1ToV2.js";
import type { GraphConfigLoadResult, LegacyFSMGraphConfig } from "./types.js";
import { isPlainObject } from "./legacyUtils.js";
import { refreshRetiredSkillReflectGate } from "./legacyTopology.js";

/** Input boundary only: the runtime never calls historical migrations. */
export function loadGraphConfig(raw: unknown): GraphConfigLoadResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FSMConfigError("INVALID_VERSION", "FSM graph config must be an object");
  }
  const config = raw as Record<string, unknown>;
  if (config.version !== 1 && config.version !== FSM_GRAPH_CONFIG_VERSION) {
    throw new FSMConfigError("INVALID_VERSION", `Unsupported FSM graph version: ${String(config.version)}`);
  }
  if (!Array.isArray(config.nodes)) {
    throw new FSMConfigError("EMPTY_NODES", "FSM graph nodes must be an array");
  }
  if (!Array.isArray(config.edges)) {
    throw new FSMConfigError("DANGLING_EDGE", "FSM graph edges must be an array");
  }
  for (const node of config.nodes) {
    if (!node || typeof node !== "object" || Array.isArray(node) || typeof node.id !== "string") {
      throw new FSMConfigError("INVALID_NODE_ID", "FSM graph node id must be a string");
    }
    if (node.actions !== undefined && !Array.isArray(node.actions)) {
      throw new FSMConfigError("UNKNOWN_ACTION", `Node "${node.id}" actions must be an array`);
    }
    for (const action of node.actions ?? []) {
      if (!action || typeof action !== "object" || Array.isArray(action) || typeof action.type !== "string") {
        throw new FSMConfigError("UNKNOWN_ACTION", `Node "${node.id}" Action type must be a string`);
      }
      if (action.params !== undefined && !isPlainObject(action.params)) {
        throw new FSMConfigError("INVALID_ACTION_PARAMS", `Node "${node.id}" Action params must be an object`);
      }
    }
    if (node.pins !== undefined && !Array.isArray(node.pins)) {
      throw new FSMConfigError("INVALID_PIN", `Node "${node.id}" pins must be an array`);
    }
    for (const pin of node.pins ?? []) {
      if (!pin || typeof pin !== "object" || Array.isArray(pin) || typeof pin.name !== "string") {
        throw new FSMConfigError("INVALID_PIN", `Node "${node.id}" pin name must be a string`);
      }
    }
  }
  for (const edge of config.edges) {
    if (!edge || typeof edge !== "object" || Array.isArray(edge) ||
      typeof edge.from !== "string" || typeof edge.to !== "string") {
      throw new FSMConfigError("DANGLING_EDGE", "FSM graph edge endpoints must be strings");
    }
    if (edge.params !== undefined && !isPlainObject(edge.params)) {
      throw new FSMConfigError("INVALID_EDGE_PARAMS", "FSM graph edge params must be an object");
    }
  }
  if (config.version === FSM_GRAPH_CONFIG_VERSION) {
    const refreshed = refreshRetiredSkillReflectGate(raw as FSMGraphConfig);
    return { config: refreshed.config, migrated: refreshed.changed, migrations: [] };
  }
  return {
    config: refreshRetiredSkillReflectGate(migrateV1ToV2(raw as LegacyFSMGraphConfig)).config,
    migrated: true,
    migrations: [{ from: 1, to: FSM_GRAPH_CONFIG_VERSION }],
  };
}
