import {
  DEFAULT_TERMINAL_NODE_ID,
  EDGE_TYPE_ALWAYS,
  EDGE_TYPE_WHEN,
  FSM_GRAPH_CONFIG_VERSION,
} from "./constants.js";
import { FSMConfigError } from "./FSMConfigError.js";
import {
  coerceTypedExpected,
  FSM_COMPARE_OPERATORS,
} from "./compareValues.js";
import type { FSMRegistry, PreparedNodeAction } from "./FSMRegistry.js";
import { defaultEdgeId } from "./FSMRegistry.js";
import {
  pinSlotKeysFromSchema,
  ROUTE_TARGET_KEY,
} from "./pinRouting.js";
import type {
  EdgeWhenParams,
  FSMGraphConfig,
  FSMGraphEdgeConfig,
  FSMGraphNodeConfig,
} from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertEdgeWhenParams(
  params: unknown,
  edgeIndex: number,
): EdgeWhenParams {
  if (!isPlainObject(params)) {
    throw new FSMConfigError(
      "INVALID_EDGE_PARAMS",
      `Edge #${edgeIndex} (EdgeWhen) requires params object with turnKey`,
    );
  }
  const turnKey = params.turnKey;
  if (typeof turnKey !== "string" || turnKey.length === 0) {
    throw new FSMConfigError(
      "INVALID_EDGE_PARAMS",
      `Edge #${edgeIndex} (EdgeWhen) params.turnKey must be a non-empty string`,
    );
  }
  // Unified pin model: never controlResult / activeRole as edge conditions.
  if (turnKey === "controlResult" || turnKey === "activeRole") {
    throw new FSMConfigError(
      "RETIRED_EDGE_KEY",
      `Edge #${edgeIndex}: turnKey "${turnKey}" is retired — use routeTarget + pin.name`,
    );
  }
  const out: EdgeWhenParams = { turnKey };
  if ("equals" in params) {
    out.equals = params.equals;
  }
  if (params.source === "turn" || params.source === "node" || params.source === "session") {
    out.source = params.source;
  }
  if (typeof params.unlessNodeKey === "string" && params.unlessNodeKey.trim()) {
    out.unlessNodeKey = params.unlessNodeKey.trim();
  }
  if (params.requireIncompletePlan === true) {
    out.requireIncompletePlan = true;
  }
  // Typed comparison (schema v19 blackboard feature): type/operator/value is
  // mutually exclusive with equals — exactly one comparison style per edge.
  const hasTyped =
    params.type !== undefined ||
    params.operator !== undefined ||
    params.value !== undefined;
  if (hasTyped && "equals" in params) {
    throw new FSMConfigError(
      "INVALID_EDGE_PARAMS",
      `Edge #${edgeIndex} (EdgeWhen) params.equals is mutually exclusive with type/operator/value`,
    );
  }
  if (hasTyped) {
    if (params.type !== "int" && params.type !== "float" && params.type !== "string") {
      throw new FSMConfigError(
        "INVALID_EDGE_PARAMS",
        `Edge #${edgeIndex} (EdgeWhen) params.type must be "int" | "float" | "string" for typed comparisons`,
      );
    }
    const type = params.type;
    if (
      typeof params.operator !== "string" ||
      !(FSM_COMPARE_OPERATORS as readonly string[]).includes(params.operator)
    ) {
      throw new FSMConfigError(
        "INVALID_EDGE_PARAMS",
        `Edge #${edgeIndex} (EdgeWhen) params.operator must be one of ${FSM_COMPARE_OPERATORS.join(" ")}`,
      );
    }
    const expected = coerceTypedExpected(
      type,
      params.value,
      `Edge #${edgeIndex} (EdgeWhen) params.value`,
    );
    if (!expected.ok) {
      throw new FSMConfigError("INVALID_EDGE_PARAMS", expected.error);
    }
    out.type = type;
    out.operator = params.operator;
    out.value = params.value;
  }
  return out;
}

function assertEdgeAlwaysParams(params: unknown, edgeIndex: number): void {
  if (params === undefined) {
    return;
  }
  if (!isPlainObject(params) || Object.keys(params).length > 0) {
    throw new FSMConfigError(
      "INVALID_EDGE_PARAMS",
      `Edge #${edgeIndex} (EdgeAlways) must omit params or use an empty object`,
    );
  }
}

function assertNodePins(nodeCfg: FSMGraphNodeConfig): Set<string> {
  const id = nodeCfg.id?.trim() ?? "";
  const seen = new Set<string>();
  for (const pin of nodeCfg.pins ?? []) {
    const name = typeof pin?.name === "string" ? pin.name.trim() : "";
    if (!name) {
      throw new FSMConfigError(
        "INVALID_PIN",
        `Node "${id}" has a pin with empty name`,
      );
    }
    if (seen.has(name)) {
      throw new FSMConfigError(
        "INVALID_PIN",
        `Node "${id}" duplicate pin name "${name}"`,
      );
    }
    seen.add(name);
  }
  return seen;
}

function assertActionPinRefs(
  actions: readonly PreparedNodeAction[],
  pins: Set<string>,
): void {
  for (const actionCfg of actions) {
    const schema = actionCfg.paramsSchema;
    const { selectKeys, mapKeys, bindingKeys } = pinSlotKeysFromSchema(schema);
    const params = actionCfg.params;
    for (const key of selectKeys) {
      const value = params[key];
      if (value === undefined || value === null || value === "") continue;
      if (typeof value !== "string" || !pins.has(value)) {
        throw new FSMConfigError(
          "INVALID_PIN",
          `${actionCfg.label} slot "${key}" references unknown pin "${String(value)}"`,
        );
      }
    }
    for (const mapKey of mapKeys) {
      const map = params[mapKey];
      if (!map || typeof map !== "object" || Array.isArray(map)) continue;
      for (const [role, pin] of Object.entries(
        map as Record<string, unknown>,
      )) {
        if (typeof pin !== "string" || !pins.has(pin)) {
          throw new FSMConfigError(
            "INVALID_PIN",
            `${actionCfg.label} ${mapKey}["${role}"] references unknown pin "${String(pin)}"`,
          );
        }
      }
    }
    for (const bindingKey of bindingKeys) {
      const rows = params[bindingKey];
      if (!Array.isArray(rows)) continue;
      for (const [rowIndex, item] of rows.entries()) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const to =
          typeof (item as { to?: unknown }).to === "string"
            ? (item as { to: string }).to
            : typeof (item as { pin?: unknown }).pin === "string"
              ? (item as { pin: string }).pin
              : "";
        if (!to) continue;
        if (!pins.has(to)) {
          throw new FSMConfigError(
            "INVALID_PIN",
            `${actionCfg.label} ${bindingKey}[${rowIndex}].to references unknown pin "${to}"`,
          );
        }
      }
    }
    assertActionPinRefs(actionCfg.children, pins);
  }
}

/**
 * Structural + registry validation before hydrate. All Action checks use the
 * same normalized params; Action factories run only after graph validation.
 * Throws {@link FSMConfigError} on failure.
 */
export function validateFSMGraphConfig(
  config: FSMGraphConfig,
  registry: FSMRegistry,
): {
  entryNodeId: string;
  terminalNodeId: string;
  preparedActionsByNode: ReadonlyMap<string, readonly PreparedNodeAction[]>;
} {
  if (config.version !== FSM_GRAPH_CONFIG_VERSION) {
    throw new FSMConfigError(
      "INVALID_VERSION",
      `FSMGraphConfig.version must be ${FSM_GRAPH_CONFIG_VERSION}, got ${String(config.version)}`,
    );
  }

  const entryNodeId = config.entryNodeId?.trim() ?? "";
  if (!entryNodeId) {
    throw new FSMConfigError(
      "MISSING_ENTRY",
      "FSMGraphConfig.entryNodeId is required",
    );
  }

  const terminalNodeId =
    config.terminalNodeId?.trim() || DEFAULT_TERMINAL_NODE_ID;

  if (!Array.isArray(config.nodes) || config.nodes.length === 0) {
    throw new FSMConfigError(
      "EMPTY_NODES",
      "FSMGraphConfig.nodes must be a non-empty array",
    );
  }

  const nodeIds = new Set<string>();
  const selfLoopNodeIds = new Set<string>();
  const pinsByNode = new Map<string, Set<string>>();
  const preparedActionsByNode = new Map<string, PreparedNodeAction[]>();

  for (const nodeCfg of config.nodes) {
    const id = nodeCfg.id?.trim() ?? "";
    if (!id) {
      throw new FSMConfigError(
        "INVALID_NODE_ID",
        "FSMGraphConfig node id is required",
      );
    }
    if (nodeIds.has(id)) {
      throw new FSMConfigError(
        "DUPLICATE_NODE",
        `FSMGraphConfig duplicate node id "${id}"`,
      );
    }
    nodeIds.add(id);
    if (nodeCfg.selfLoop === true) {
      selfLoopNodeIds.add(id);
    }

    const pins = assertNodePins(nodeCfg);
    pinsByNode.set(id, pins);

    const actions = (nodeCfg.actions ?? []).map((actionCfg, actionIndex) => {
      if (!registry.hasAction(actionCfg.type)) {
        throw new FSMConfigError(
          "UNKNOWN_ACTION",
          `Unknown NodeAction type "${actionCfg.type}" on node "${id}" (action #${actionIndex})`,
        );
      }
      return registry.prepareAction(
        actionCfg.type,
        actionCfg.params,
        `Node "${id}" action #${actionIndex} (${actionCfg.type})`,
      );
    });
    preparedActionsByNode.set(id, actions);

    assertActionPinRefs(actions, pins);
  }

  if (!nodeIds.has(entryNodeId)) {
    throw new FSMConfigError(
      "MISSING_ENTRY",
      `FSMGraphConfig entryNodeId "${entryNodeId}" not found in nodes`,
    );
  }
  if (!nodeIds.has(terminalNodeId)) {
    throw new FSMConfigError(
      "MISSING_TERMINAL",
      `FSMGraphConfig terminal node "${terminalNodeId}" not found in nodes`,
    );
  }

  if (!Array.isArray(config.edges)) {
    throw new FSMConfigError(
      "DANGLING_EDGE",
      "FSMGraphConfig.edges must be an array",
    );
  }

  const edgeIds = new Set<string>();
  const outgoing = new Map<string, FSMGraphEdgeConfig[]>();
  /** fromNode → pin.name → edge index (one pin → one edge). */
  const pinEdgeOwner = new Map<string, Map<string, number>>();

  config.edges.forEach((edgeCfg, index) => {
    const from = edgeCfg.from?.trim() ?? "";
    const to = edgeCfg.to?.trim() ?? "";
    if (!from || !to) {
      throw new FSMConfigError(
        "DANGLING_EDGE",
        `FSMGraphConfig edge #${index} needs from and to`,
      );
    }
    if (!nodeIds.has(from)) {
      throw new FSMConfigError(
        "DANGLING_EDGE",
        `FSMGraphConfig edge #${index} from "${from}" not found`,
      );
    }
    if (!nodeIds.has(to)) {
      throw new FSMConfigError(
        "DANGLING_EDGE",
        `FSMGraphConfig edge #${index} to "${to}" not found`,
      );
    }

    if (!registry.hasEdge(edgeCfg.type)) {
      throw new FSMConfigError(
        "UNKNOWN_EDGE",
        `Unknown Edge type "${edgeCfg.type}" (edge #${index})`,
      );
    }

    if (edgeCfg.type === EDGE_TYPE_WHEN) {
      const whenParams = assertEdgeWhenParams(edgeCfg.params, index);
      if (
        whenParams.turnKey === ROUTE_TARGET_KEY &&
        typeof whenParams.equals === "string"
      ) {
        const pins = pinsByNode.get(from) ?? new Set();
        // Nodes with no pins declared skip membership (unit tests); graphs
        // that emit routeTarget in production should declare pins.
        if (pins.size > 0 && !pins.has(whenParams.equals)) {
          throw new FSMConfigError(
            "PIN_EDGE_MISMATCH",
            `Edge #${index}: routeTarget equals "${whenParams.equals}" is not a pin on node "${from}"`,
          );
        }
        if (pins.size > 0) {
          const byPin = pinEdgeOwner.get(from) ?? new Map<string, number>();
          const prior = byPin.get(whenParams.equals);
          if (prior !== undefined) {
            throw new FSMConfigError(
              "DUPLICATE_PIN_EDGE",
              `Node "${from}" pin "${whenParams.equals}" already used by edge #${prior}; one pin may have at most one outgoing edge`,
            );
          }
          byPin.set(whenParams.equals, index);
          pinEdgeOwner.set(from, byPin);
        }
      }
    } else if (edgeCfg.type === EDGE_TYPE_ALWAYS) {
      assertEdgeAlwaysParams(edgeCfg.params, index);
    }

    const id = defaultEdgeId(edgeCfg, index);
    if (edgeIds.has(id)) {
      throw new FSMConfigError(
        "DUPLICATE_EDGE_ID",
        `FSMGraphConfig duplicate edge id "${id}"`,
      );
    }
    edgeIds.add(id);

    const list = outgoing.get(from) ?? [];
    list.push(edgeCfg);
    outgoing.set(from, list);
  });

  for (const nodeId of nodeIds) {
    if (nodeId === terminalNodeId) {
      continue;
    }
    const outs = outgoing.get(nodeId) ?? [];
    if (outs.length === 0 && !selfLoopNodeIds.has(nodeId)) {
      throw new FSMConfigError(
        "NON_TERMINAL_NO_OUTGOING",
        `Non-terminal node "${nodeId}" must have at least one outgoing edge`,
      );
    }
    const alwaysCount = outs.filter((e) => e.type === EDGE_TYPE_ALWAYS).length;
    if (alwaysCount > 0 && outs.length !== 1) {
      throw new FSMConfigError(
        "EDGE_ALWAYS_NOT_ALONE",
        `Node "${nodeId}" has EdgeAlways and must have exactly one outgoing edge (got ${outs.length})`,
      );
    }
  }

  return { entryNodeId, terminalNodeId, preparedActionsByNode };
}
