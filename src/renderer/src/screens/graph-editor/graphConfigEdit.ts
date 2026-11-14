/** Renderer-side FSMGraphConfig edit helpers (JSON mirror of main types). */

export type GraphConfigJson = {
  version: number;
  entryNodeId: string;
  terminalNodeId?: string;
  nodes: GraphNodeJson[];
  edges: GraphEdgeJson[];
};

export type GraphNodeJson = {
  id: string;
  name?: string;
  pins?: Array<{ name: string }>;
  actions?: Array<{ type: string; params?: Record<string, unknown> }>;
  selfLoop?: boolean;
};

export type GraphEdgeJson = {
  id?: string;
  from: string;
  to: string;
  type: string;
  params?: Record<string, unknown>;
};

const ROUTE_TARGET = "routeTarget";
export const GRAPH_NODE_START = "start";
export const GRAPH_NODE_END = "end";

function cloneConfig(config: GraphConfigJson): GraphConfigJson {
  return structuredClone(config);
}

function findNode(config: GraphConfigJson, nodeId: string): GraphNodeJson | undefined {
  return config.nodes.find((n) => n.id === nodeId);
}

export function graphViewInputFromConfig(config: GraphConfigJson) {
  return {
    entryNodeId: config.entryNodeId,
    terminalNodeId: config.terminalNodeId ?? GRAPH_NODE_END,
    nodes: config.nodes.map((node) => ({
      id: node.id,
      ...(node.name !== undefined && node.name !== ""
        ? { name: node.name }
        : {}),
      selfLoop: node.selfLoop === true,
      actionTypes: (node.actions ?? []).map((a) => a.type),
    })),
    edges: config.edges.map((edge) => {
      const when =
        edge.type === "EdgeWhen" && edge.params
          ? summarizeWhen(edge.params)
          : undefined;
      return {
        from: edge.from,
        to: edge.to,
        type: edge.type,
        ...(when ? { when } : {}),
      };
    }),
  };
}

function summarizeWhen(params: Record<string, unknown>): string {
  const turnKey = typeof params.turnKey === "string" ? params.turnKey : "";
  if (!turnKey) return "";
  const parts = [turnKey];
  if ("equals" in params) {
    const equals = params.equals;
    parts.push(
      `=${typeof equals === "string" ? equals : JSON.stringify(equals)}`,
    );
  }
  if (params.source === "node") parts.push("@node");
  return parts.join("");
}

export function addIntermediateNode(
  config: GraphConfigJson,
  id: string,
  name?: string,
): GraphConfigJson {
  const trimmed = id.trim();
  if (!trimmed) return config;
  if (trimmed === GRAPH_NODE_START || trimmed === GRAPH_NODE_END) return config;
  const next = cloneConfig(config);
  if (next.nodes.some((n) => n.id === trimmed)) return config;
  next.nodes.push({
    id: trimmed,
    name: name?.trim() || trimmed,
    pins: [],
    actions: [],
    selfLoop: false,
  });
  return next;
}

export function removeNode(
  config: GraphConfigJson,
  nodeId: string,
): GraphConfigJson {
  if (nodeId === GRAPH_NODE_START || nodeId === GRAPH_NODE_END) return config;
  const next = cloneConfig(config);
  next.nodes = next.nodes.filter((n) => n.id !== nodeId);
  next.edges = next.edges.filter(
    (e) => e.from !== nodeId && e.to !== nodeId,
  );
  return next;
}

export function updateNodeMeta(
  config: GraphConfigJson,
  nodeId: string,
  patch: { name?: string; selfLoop?: boolean },
): GraphConfigJson {
  const next = cloneConfig(config);
  next.nodes = next.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    return {
      ...node,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.selfLoop !== undefined ? { selfLoop: patch.selfLoop } : {}),
    };
  });
  return next;
}

export function addPin(
  config: GraphConfigJson,
  nodeId: string,
  pinName: string,
): GraphConfigJson {
  const name = pinName.trim();
  if (!name) return config;
  const node = findNode(config, nodeId);
  if (!node) return config;
  const pins = [...(node.pins ?? [])];
  if (pins.some((p) => p.name === name)) return config;
  pins.push({ name });
  const next = cloneConfig(config);
  next.nodes = next.nodes.map((n) =>
    n.id === nodeId ? { ...n, pins } : n,
  );
  return next;
}

export function removePin(
  config: GraphConfigJson,
  nodeId: string,
  pinName: string,
): GraphConfigJson {
  const name = pinName.trim();
  const next = cloneConfig(config);
  next.nodes = next.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    return {
      ...node,
      pins: (node.pins ?? []).filter((p) => p.name !== name),
    };
  });
  next.edges = next.edges.filter((edge) => {
    if (edge.from !== nodeId || edge.type !== "EdgeWhen") return true;
    const params = edge.params ?? {};
    return !(
      params.turnKey === ROUTE_TARGET &&
      params.equals === name &&
      params.source === "node"
    );
  });
  return next;
}

export function connectPinToNode(
  config: GraphConfigJson,
  fromNodeId: string,
  pinName: string,
  toNodeId: string,
): GraphConfigJson {
  const pin = pinName.trim();
  if (!pin || !findNode(config, fromNodeId) || !findNode(config, toNodeId)) {
    return config;
  }
  let next = config;
  const node = findNode(next, fromNodeId)!;
  if (!(node.pins ?? []).some((p) => p.name === pin)) {
    next = addPin(next, fromNodeId, pin);
  }

  next = cloneConfig(next);
  next.edges = next.edges.filter((edge) => {
    if (edge.from !== fromNodeId || edge.type !== "EdgeWhen") return true;
    const params = edge.params ?? {};
    return !(
      params.turnKey === ROUTE_TARGET &&
      params.equals === pin &&
      params.source === "node"
    );
  });
  next.edges.push({
    from: fromNodeId,
    to: toNodeId,
    type: "EdgeWhen",
    params: {
      turnKey: ROUTE_TARGET,
      equals: pin,
      source: "node",
    },
  });
  return next;
}

/**
 * Wire two nodes by pin: reuse a pin named after the target if present,
 * otherwise create that pin, then connect.
 */
export function wireNodeToNode(
  config: GraphConfigJson,
  fromNodeId: string,
  toNodeId: string,
): GraphConfigJson {
  if (
    fromNodeId === toNodeId ||
    !findNode(config, fromNodeId) ||
    !findNode(config, toNodeId)
  ) {
    return config;
  }
  // Match pin by destination node id (built-in convention); create if missing.
  return connectPinToNode(config, fromNodeId, toNodeId, toNodeId);
}

/**
 * Remove the visual wire `from → to`: drop every routeTarget pin on `from`
 * that targets `to` (and their EdgeWhen). Under the usual pin.name === to
 * convention that is one pin.
 */
export function removeWire(
  config: GraphConfigJson,
  fromNodeId: string,
  toNodeId: string,
): GraphConfigJson {
  if (!fromNodeId || !toNodeId) return config;
  const pinNames: string[] = [];
  for (const edge of config.edges) {
    if (edge.from !== fromNodeId || edge.to !== toNodeId) continue;
    if (edge.type !== "EdgeWhen") continue;
    const params = edge.params ?? {};
    if (
      params.turnKey === ROUTE_TARGET &&
      params.source === "node" &&
      typeof params.equals === "string" &&
      params.equals.trim()
    ) {
      pinNames.push(params.equals.trim());
    }
  }
  let next = config;
  const unique = [...new Set(pinNames)];
  if (unique.length === 0) {
    // Fallback: convention pin named after the target.
    next = removePin(next, fromNodeId, toNodeId);
  } else {
    for (const pin of unique) {
      next = removePin(next, fromNodeId, pin);
    }
  }
  return pruneUnwiredPins(next);
}

export function addAction(
  config: GraphConfigJson,
  nodeId: string,
  actionType: string,
): GraphConfigJson {
  const type = actionType.trim();
  if (!type || !findNode(config, nodeId)) return config;
  const next = cloneConfig(config);
  next.nodes = next.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    const actions = [...(node.actions ?? []), { type, params: {} }];
    return { ...node, actions };
  });
  return next;
}

export function removeAction(
  config: GraphConfigJson,
  nodeId: string,
  index: number,
): GraphConfigJson {
  const next = cloneConfig(config);
  next.nodes = next.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    const actions = [...(node.actions ?? [])];
    if (index < 0 || index >= actions.length) return node;
    actions.splice(index, 1);
    return { ...node, actions };
  });
  return next;
}

/** Action execution order is semantic — reorder must splice, not swap. */
export function reorderAction(
  config: GraphConfigJson,
  nodeId: string,
  from: number,
  to: number,
): GraphConfigJson {
  const next = cloneConfig(config);
  next.nodes = next.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    const actions = [...(node.actions ?? [])];
    if (from === to || from < 0 || from >= actions.length) return node;
    if (to < 0 || to >= actions.length) return node;
    const [moved] = actions.splice(from, 1);
    if (!moved) return node;
    actions.splice(to, 0, moved);
    return { ...node, actions };
  });
  return next;
}

export function updateActionParams(
  config: GraphConfigJson,
  nodeId: string,
  index: number,
  params: Record<string, unknown>,
): GraphConfigJson {
  const next = cloneConfig(config);
  next.nodes = next.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    const actions = [...(node.actions ?? [])];
    if (index < 0 || index >= actions.length) return node;
    actions[index] = { ...actions[index]!, params: { ...params } };
    return { ...node, actions };
  });
  return next;
}

export function pinNamesOfNode(
  config: GraphConfigJson,
  nodeId: string,
): string[] {
  const node = findNode(config, nodeId);
  return (node?.pins ?? [])
    .map((p) => p.name.trim())
    .filter((n) => n.length > 0);
}

export function edgeTargetForPin(
  config: GraphConfigJson,
  fromNodeId: string,
  pinName: string,
): string | null {
  for (const edge of config.edges) {
    if (edge.from !== fromNodeId || edge.type !== "EdgeWhen") continue;
    const params = edge.params ?? {};
    if (
      params.turnKey === ROUTE_TARGET &&
      params.equals === pinName &&
      params.source === "node"
    ) {
      return edge.to;
    }
  }
  return null;
}

/** Pin names that have an outgoing EdgeWhen from this node. */
export function wiredPinNames(
  config: GraphConfigJson,
  fromNodeId: string,
): Set<string> {
  const names = new Set<string>();
  for (const edge of config.edges) {
    if (edge.from !== fromNodeId || edge.type !== "EdgeWhen") continue;
    const params = edge.params ?? {};
    if (
      params.turnKey === ROUTE_TARGET &&
      typeof params.equals === "string" &&
      params.equals.trim() &&
      params.source === "node"
    ) {
      names.add(params.equals.trim());
    }
  }
  return names;
}

/**
 * Drop pins with no outgoing wire and no action-param reference.
 * Clears stale pin-select / pin-map values only when the pin itself is dropped.
 */
export function pruneUnwiredPins(config: GraphConfigJson): GraphConfigJson {
  const next = cloneConfig(config);
  for (const node of next.nodes) {
    const wired = wiredPinNames(next, node.id);
    const referenced = pinNamesReferencedByActions(node.actions ?? []);
    const keep = new Set<string>([...wired, ...referenced]);
    const before = node.pins ?? [];
    const kept = before.filter((p) => keep.has(p.name.trim()));
    if (kept.length === before.length) continue;
    const dropped = new Set(
      before.map((p) => p.name.trim()).filter((n) => n && !keep.has(n)),
    );
    node.pins = kept;
    if (dropped.size === 0 || !node.actions) continue;
    node.actions = node.actions.map((action) => {
      if (!action.params) return action;
      return {
        ...action,
        params: scrubPinRefsFromParams(action.params, dropped),
      };
    });
  }
  return next;
}

function pinNamesReferencedByActions(
  actions: Array<{ params?: Record<string, unknown> }>,
): Set<string> {
  const names = new Set<string>();
  for (const action of actions) {
    const params = action.params;
    if (!params) continue;
    for (const value of Object.values(params)) {
      if (typeof value === "string" && value.trim()) {
        names.add(value.trim());
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const to = (item as { to?: unknown; pin?: unknown }).to;
          const pin = (item as { pin?: unknown }).pin;
          if (typeof to === "string" && to.trim()) names.add(to.trim());
          else if (typeof pin === "string" && pin.trim()) names.add(pin.trim());
        }
        continue;
      }
      if (value && typeof value === "object") {
        for (const v of Object.values(value as Record<string, unknown>)) {
          if (typeof v === "string" && v.trim()) names.add(v.trim());
        }
      }
    }
  }
  return names;
}

function scrubPinRefsFromParams(
  params: Record<string, unknown>,
  dropped: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      if (!dropped.has(value)) out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.filter((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return true;
        }
        const to =
          typeof (item as { to?: unknown }).to === "string"
            ? (item as { to: string }).to
            : typeof (item as { pin?: unknown }).pin === "string"
              ? (item as { pin: string }).pin
              : "";
        return !to || !dropped.has(to);
      });
      continue;
    }
    if (value && typeof value === "object") {
      const map: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === "string" && dropped.has(v)) continue;
        map[k] = v;
      }
      out[key] = map;
      continue;
    }
    out[key] = value;
  }
  return out;
}
