/**
 * Pin / routeTarget helpers — graph-owned pins; routing Actions only select
 * pin.name via fixed callback slots.
 */

import { FSMConfigError } from "./FSMConfigError.js";
import type { FsmParamsPropertySchema, FsmParamsSchema } from "./paramsSchema.js";
import type {
  FSMGraphConfig,
  FSMGraphEdgeConfig,
  FSMGraphNodeConfig,
  NodeActionConfig,
} from "./types.js";

export const ROUTE_TARGET_KEY = "routeTarget";

/** Shared pin-select property for Action params schemas. */
export function pinSelectProperty(
  title: string,
  description?: string,
): FsmParamsPropertySchema {
  return {
    type: "string",
    minLength: 1,
    title,
    ...(description ? { description } : {}),
    "x-ui": "pin-select",
  };
}

export function pinNamesOf(node: FSMGraphNodeConfig): string[] {
  const names: string[] = [];
  for (const pin of node.pins ?? []) {
    const name = typeof pin?.name === "string" ? pin.name.trim() : "";
    if (name) names.push(name);
  }
  return names;
}

/**
 * Resolve a required pin slot from Action params.
 * Empty / missing → error message (caller should halt).
 */
export function resolvePinSlot(
  params: Record<string, unknown>,
  slot: string,
  actionLabel: string,
): { ok: true; pin: string } | { ok: false; errorMessage: string } {
  const raw = params[slot];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {
      ok: false,
      errorMessage: `${actionLabel}: routing slot "${slot}" is not bound to a pin`,
    };
  }
  return { ok: true, pin: raw.trim() };
}

/** Collect param keys that are pin-select / pin-map / route-bindings from a schema. */
export function pinSlotKeysFromSchema(schema: FsmParamsSchema): {
  selectKeys: string[];
  mapKeys: string[];
  bindingKeys: string[];
} {
  const selectKeys: string[] = [];
  const mapKeys: string[] = [];
  const bindingKeys: string[] = [];
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (prop["x-ui"] === "pin-select" || key === "defaultPin") {
      selectKeys.push(key);
    }
    if (prop["x-ui"] === "pin-map") mapKeys.push(key);
    if (
      prop["x-ui"] === "route-bindings" ||
      prop["x-ui"] === "text-pin-bindings" ||
      prop["x-ui"] === "flag-pin-bindings" ||
      (prop["x-ui"] === "hidden" && (key === "when" || key === "routes"))
    ) {
      bindingKeys.push(key);
    }
  }
  return { selectKeys, mapKeys, bindingKeys };
}

function rewritePinInParams(
  params: Record<string, unknown> | undefined,
  selectKeys: string[],
  mapKeys: string[],
  bindingKeys: string[],
  fromName: string,
  toName: string,
): Record<string, unknown> | undefined {
  if (!params) return params;
  const next: Record<string, unknown> = { ...params };
  let changed = false;
  for (const key of selectKeys) {
    if (next[key] === fromName) {
      next[key] = toName;
      changed = true;
    }
  }
  for (const mapKey of mapKeys) {
    const map = next[mapKey];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    const rewritten: Record<string, unknown> = {
      ...(map as Record<string, unknown>),
    };
    let mapChanged = false;
    for (const [role, pin] of Object.entries(rewritten)) {
      if (pin === fromName) {
        rewritten[role] = toName;
        mapChanged = true;
      }
    }
    if (mapChanged) {
      next[mapKey] = rewritten;
      changed = true;
    }
  }
  for (const bindingKey of bindingKeys) {
    const rows = next[bindingKey];
    if (!Array.isArray(rows)) continue;
    let listChanged = false;
    const rewritten = rows.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const row = { ...(item as Record<string, unknown>) };
      if (row.to === fromName) {
        row.to = toName;
        listChanged = true;
      } else if (row.pin === fromName) {
        row.pin = toName;
        listChanged = true;
      }
      return row;
    });
    if (listChanged) {
      next[bindingKey] = rewritten;
      changed = true;
    }
  }
  return changed ? next : params;
}

export type PinSchemaLookup = (actionType: string) => FsmParamsSchema | undefined;

/**
 * Rename a pin on a node: cascade Action slot refs + routeTarget edges.
 * Returns a new config object (shallow-copied nodes/edges as needed).
 */
export function renameNodePin(
  config: FSMGraphConfig,
  nodeId: string,
  fromName: string,
  toName: string,
  schemaLookup: PinSchemaLookup,
): FSMGraphConfig {
  const from = fromName.trim();
  const to = toName.trim();
  if (!from || !to) {
    throw new FSMConfigError(
      "INVALID_PIN",
      "renameNodePin requires non-empty fromName and toName",
    );
  }
  if (from === to) return config;

  const nodes = config.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    const pins = (node.pins ?? []).map((p) =>
      p.name === from ? { name: to } : { ...p },
    );
    const actions: NodeActionConfig[] = (node.actions ?? []).map((action) => {
      const schema = schemaLookup(action.type);
      if (!schema) return action;
      const { selectKeys, mapKeys, bindingKeys } = pinSlotKeysFromSchema(schema);
      const params = rewritePinInParams(
        action.params,
        selectKeys,
        mapKeys,
        bindingKeys,
        from,
        to,
      );
      if (params === action.params) return action;
      return {
        type: action.type,
        ...(params !== undefined ? { params } : {}),
      };
    });
    return { ...node, pins, actions };
  });

  const edges: FSMGraphEdgeConfig[] = config.edges.map((edge) => {
    if (edge.from !== nodeId || edge.type !== "EdgeWhen") return edge;
    const params = edge.params as { turnKey?: string; equals?: unknown };
    if (
      params?.turnKey === ROUTE_TARGET_KEY &&
      params.equals === from
    ) {
      return {
        ...edge,
        params: { ...params, equals: to },
      };
    }
    return edge;
  });

  return { ...config, nodes, edges };
}

/** Unique pin names for a role node’s stay + transitions + fixed markers. */
export function pinsFromNames(names: string[]): Array<{ name: string }> {
  const seen = new Set<string>();
  const out: Array<{ name: string }> = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name });
  }
  return out;
}
