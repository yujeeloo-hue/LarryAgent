import { createHash } from "node:crypto";
import { createDefaultActionRegistry } from "../actions/createDefaultActionRegistry.js";
import { loadGraphConfig } from "../compatibility/loadGraphConfig.js";
import { pinSlotKeysFromSchema } from "../pinRouting.js";
import { normalizeAndValidateParams } from "../paramsSchema.js";
import { validateFSMGraphConfig } from "../validateFSMGraphConfig.js";
import type { PreparedNodeAction } from "../FSMRegistry.js";
import type { FSMGraphConfig } from "../types.js";
import { ACTION_CONTRACTS, inferNodePattern, NODE_PATTERNS, type NodePattern } from "./contracts.js";
export type GraphIssue = {
  code: string;
  severity: "error" | "warning";
  stage: "structure" | "actions" | "flow";
  path: string;
  message: string;
  suggestion: string;
  nodeId?: string;
  actionId?: string;
  edgeId?: string;
  expected?: unknown;
  actual?: unknown;
  options?: string[];
};
export type GraphValidation = {
  valid: boolean;
  fingerprint: string;
  errors: number;
  warnings: number;
  issues: GraphIssue[];
  scope: string;
};
export function graphFingerprint(raw: unknown): string {
  return createHash("sha256").update(JSON.stringify(raw) ?? "undefined").digest("hex");
}
export function analyzeGraph(raw: unknown): GraphValidation {
  const issues: GraphIssue[] = [];
  const add = (issue: GraphIssue) => {
    if (!issues.some(i => i.code === issue.code && i.path === issue.path && i.message === issue.message)) issues.push(issue);
  };
  const finish = (): GraphValidation => ({
    valid: !issues.some(i => i.severity === "error"),
    fingerprint: graphFingerprint(raw),
    errors: issues.filter(i => i.severity === "error").length,
    warnings: issues.filter(i => i.severity === "warning").length,
    issues,
    scope: "Static structure, registered parameter validators, recursive action dependencies and local pin wiring. Actions are not executed; dynamic predicate coverage and host/model behavior are not proven."
  });
  let config: FSMGraphConfig;
  try {
    config = loadGraphConfig(raw).config;
  } catch (error) {
    add({
      code: errorCode(error),
      severity: "error",
      stage: "structure",
      path: "config",
      message: message(error),
      suggestion: "Restore a supported graph version with nodes[] and edges[]; use the editing tools to build a draft."
    });
    return finish();
  }
  const registry = createDefaultActionRegistry();
  const entry = config.entryNodeId;
  const terminal = config.terminalNodeId || "end";
  const nodeIds = new Set<string>();
  for (const [ni, node] of config.nodes.entries()) {
    const path = `nodes[${ni}]`;
    if (!node.id.trim() || nodeIds.has(node.id.trim())) add({
      code: "INVALID_NODE_ID",
      severity: "error",
      stage: "structure",
      path: `${path}.id`,
      nodeId: node.id,
      message: "Node ids must be non-empty and unique.",
      suggestion: "Choose a unique nodeId."
    });
    nodeIds.add(node.id.trim());
    const pins = new Set<string>();
    for (const [pi, pin] of (node.pins ?? []).entries()) {
      if (!pin?.name?.trim() || pins.has(pin.name.trim())) add({
        code: "INVALID_PIN",
        severity: "error",
        stage: "structure",
        path: `${path}.pins[${pi}]`,
        nodeId: node.id,
        message: "Pin names must be non-empty and unique within the node.",
        suggestion: "Rename or remove the duplicate pin."
      });else pins.add(pin.name.trim());
    }
    const available = new Set<string>();
    const refs: Array<{
      pin: string;
      path: string;
      actionId?: string;
    }> = [];
    const inspect = (a: PreparedNodeAction, actionPath: string, actionId?: string) => {
      const location = {
        nodeId: node.id,
        ...(actionId ? {
          actionId
        } : {})
      };
      const contract = ACTION_CONTRACTS[a.type];
      if (a.type === "NodeActionRouteTo") {
        const routes = Array.isArray(a.params.routes) ? a.params.routes : [];
        const when = Array.isArray(a.params.when) ? a.params.when : [];
        const hasRoutes = routes.some(row => row && typeof row.event === "string" && row.event.trim() && typeof row.to === "string" && row.to.trim());
        const hasWhen = when.some(row => row && typeof (row.to ?? row.pin) === "string" && (row.expr || row.key || row.allOf?.length));
        const hasLegacy = typeof a.params.pin === "string" && (a.params.expr || a.params.key || Array.isArray(a.params.allOf) && a.params.allOf.length);
        if (!hasRoutes && !hasWhen && !hasLegacy) add({
          code: "EMPTY_ROUTE_MAPPING",
          severity: "error",
          stage: "actions",
          path: actionPath,
          ...location,
          message: "RouteTo has no usable event or condition mappings and would halt at runtime.",
          suggestion: "Configure routes [{event,to}] or when [{expr,to}]; to must name a local pin.",
          options: [...pins]
        });
      }
      for (const dependency of contract?.requires ?? []) {
        if (!available.has(dependency)) add({
          code: "ACTION_PREREQUISITE_MISSING",
          severity: "error",
          stage: "actions",
          path: actionPath,
          ...location,
          message: `${a.type} requires visit-local ${dependency}, which no earlier action in this node provides. Node context resets on every visit.`,
          suggestion: dependency === "iterationSpec" ? "Insert NodeActionPrepareRole earlier in this node." : dependency === "tools" ? "Insert NodeActionPrepareTools earlier in this node, before BuildModelWindow." : "Insert NodeActionBuildModelWindow earlier in this node, after PrepareRole and PrepareTools.",
          expected: dependency,
          actual: [...available]
        });
      }
      if (a.type === "NodeActionBuildModelWindow" && !available.has("tools")) add({
        code: "TOOLS_NOT_PREPARED",
        severity: "warning",
        stage: "actions",
        path: actionPath,
        ...location,
        message: "No PrepareTools precedes this model window; the runtime may use an empty or turn-level tool set.",
        suggestion: "Add PrepareTools before BuildModelWindow for an explicit tool policy."
      });
      const slots = pinSlotKeysFromSchema(a.paramsSchema);
      const ref = (pin: unknown, suffix: string) => {
        if (typeof pin === "string" && pin) refs.push({
          pin,
          path: `${actionPath}.params.${suffix}`,
          ...(actionId ? {
            actionId
          } : {})
        });
      };
      for (const key of slots.selectKeys) ref(a.params[key], key);
      for (const key of slots.mapKeys) for (const [role, pin] of Object.entries((a.params[key] ?? {}) as object)) ref(pin, `${key}.${role}`);
      for (const key of slots.bindingKeys) {
        const rows = a.params[key];
        if (Array.isArray(rows)) rows.forEach((row, index) => {
          if (row && typeof row === "object") ref(row.to ?? row.pin, `${key}[${index}].to`);
        });
      }
      a.children.forEach((child, index) => inspect(child, `${actionPath}.children[${index}]`, actionId));
      for (const provided of contract?.provides ?? []) available.add(provided);
    };
    for (const [ai, action] of (node.actions ?? []).entries()) {
      const actionPath = `${path}.actions[${ai}]`;
      const actionId = (action as {
        id?: string;
      }).id;
      try {
        inspect(registry.prepareAction(action.type, action.params, actionPath), actionPath, actionId);
      } catch (error) {
        add({
          code: errorCode(error),
          severity: "error",
          stage: "actions",
          path: actionPath,
          nodeId: node.id,
          ...(actionId ? {
            actionId
          } : {}),
          message: message(error),
          suggestion: "Describe this action with contextId and nodeId; use its schema, conditional requirements and available local pins.",
          expected: registry.hasAction(action.type) ? registry.getActionParamsSchema(action.type) : registry.listActionTypes(),
          actual: action.params,
          options: [...pins]
        });
      }
    }
    const outs = config.edges.filter(e => e.from === node.id);
    if (outs.some(e => e.type === "EdgeWhen" && e.params?.source === "node" && e.params.turnKey === "routeTarget") && !available.has("routeTarget")) add({
      code: "MISSING_ROUTE_PRODUCER",
      severity: "error",
      stage: "flow",
      path,
      nodeId: node.id,
      message: "Outgoing pin connections read node.routeTarget, but no action in this visit can select a local pin.",
      suggestion: "Add and configure NodeActionRouteTo, or use an explicit data predicate/unconditional connection instead."
    });
    for (const ref of refs) {
      if (!pins.has(ref.pin)) add({
        code: "UNKNOWN_PIN",
        severity: "error",
        stage: "actions",
        path: ref.path,
        nodeId: node.id,
        ...(ref.actionId ? {
          actionId: ref.actionId
        } : {}),
        message: `Action references unknown local pin "${ref.pin}". Pin names are not destination node ids.`,
        suggestion: "Create/connect this local pin, or choose an existing pin.",
        actual: ref.pin,
        options: [...pins]
      });else if (!node.selfLoop && !outs.some(e => e.type === "EdgeAlways" || e.type === "EdgeWhen" && e.params?.source === "node" && e.params.turnKey === "routeTarget" && e.params.equals === ref.pin)) add({
        code: "UNWIRED_ROUTE_PIN",
        severity: "error",
        stage: "flow",
        path: ref.path,
        nodeId: node.id,
        ...(ref.actionId ? {
          actionId: ref.actionId
        } : {}),
        message: `Pin "${ref.pin}" has no outgoing route connection and this node cannot implicitly self-loop.`,
        suggestion: "Connect this pin to its destination using fsm_graph_connection, or explicitly enable selfLoop for intentional re-entry."
      });
    }
    if (node.id !== terminal && !outs.length && !node.selfLoop) add({
      code: "NON_TERMINAL_NO_OUTGOING",
      severity: "error",
      stage: "structure",
      path,
      nodeId: node.id,
      message: "This non-terminal node has no exit yet. The draft remains editable.",
      suggestion: "Connect the node to its next stage with fsm_graph_connection."
    });
    if (outs.some(e => e.type === "EdgeAlways") && outs.length !== 1) add({
      code: "EDGE_ALWAYS_NOT_ALONE",
      severity: "error",
      stage: "structure",
      path,
      nodeId: node.id,
      message: "EdgeAlways must be the only outgoing edge; edge order is not priority.",
      suggestion: "Remove the unconditional connection before defining mutually exclusive branch connections."
    });
    if (node.id !== terminal && !node.actions?.length) add({
      code: "EMPTY_NODE",
      severity: "warning",
      stage: "actions",
      path,
      nodeId: node.id,
      message: "This node has no actions; it only passes control to an edge.",
      suggestion: `Inspect node pattern ${inferNodePattern(node, entry, terminal)} and add the actions required for its intended responsibility.`
    });
  }
  if (!nodeIds.has(entry)) add({
    code: "MISSING_ENTRY",
    severity: "error",
    stage: "structure",
    path: "entryNodeId",
    message: "Entry node does not exist.",
    suggestion: "Set entryNodeId to an existing node.",
    options: [...nodeIds]
  });
  if (!nodeIds.has(terminal)) add({
    code: "MISSING_TERMINAL",
    severity: "error",
    stage: "structure",
    path: "terminalNodeId",
    message: "Terminal node does not exist.",
    suggestion: "Create or select a terminal node.",
    options: [...nodeIds]
  });
  const edgeIds = new Set<string>();
  const predicates = new Set<string>();
  config.edges.forEach((edge, index) => {
    const path = `edges[${index}]`;
    const location = {
      ...(edge.id ? {
        edgeId: edge.id
      } : {}),
      nodeId: edge.from
    };
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) add({
      code: "DANGLING_EDGE",
      severity: "error",
      stage: "structure",
      path,
      ...location,
      message: "Both connection endpoints must exist.",
      suggestion: "Create the missing node or reconnect this edge.",
      options: [...nodeIds]
    });
    if (edge.id && edgeIds.has(edge.id)) add({
      code: "DUPLICATE_EDGE_ID",
      severity: "error",
      stage: "structure",
      path,
      ...location,
      message: "Connection ids must be unique.",
      suggestion: "Choose another connectionId."
    });
    if (edge.id) edgeIds.add(edge.id);
    try {
      normalizeAndValidateParams(registry.getEdgeParamsSchema(edge.type), edge.params, path);
    } catch (error) {
      add({
        code: errorCode(error),
        severity: "error",
        stage: "structure",
        path,
        ...location,
        message: message(error),
        suggestion: "Describe this edge type and use its exact parameter schema."
      });
    }
    const predicate = JSON.stringify([edge.from, edge.type, edge.params?.source ?? "turn", edge.params?.turnKey, edge.params?.equals, edge.params?.type, edge.params?.operator, edge.params?.value, edge.params?.unlessNodeKey, edge.params?.requireIncompletePlan]);
    if ((edge.type === "EdgeAlways" || edge.type === "EdgeWhen") && predicates.has(predicate)) add({
      code: "AMBIGUOUS_CONNECTION",
      severity: "error",
      stage: "flow",
      path,
      ...location,
      message: "An identical outgoing predicate is already connected; both edges can match at once.",
      suggestion: "Remove the duplicate or use mutually exclusive conditions."
    });
    predicates.add(predicate);
  });
  try {
    validateFSMGraphConfig(config, registry);
  } catch (error) {
    const code = errorCode(error);
    if (!issues.some(i => i.severity === "error" && (i.code === code || code === "INVALID_PIN" && i.code === "UNKNOWN_PIN"))) add({
      code,
      severity: "error",
      stage: "structure",
      path: "config",
      message: message(error),
      suggestion: "Fix the reported runtime configuration constraint, then validate again."
    });
  }
  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    config.edges.filter(e => e.from === id).forEach(e => visit(e.to));
  };
  visit(entry);
  for (const node of config.nodes) if (!reachable.has(node.id)) add({
    code: "UNREACHABLE_NODE",
    severity: "warning",
    stage: "flow",
    path: `node:${node.id}`,
    nodeId: node.id,
    message: "No structural path reaches this node from entry.",
    suggestion: "Connect the intended incoming path or remove the unused node."
  });
  if (!reachable.has(terminal)) add({
    code: "TERMINAL_UNREACHABLE",
    severity: "error",
    stage: "flow",
    path: "terminalNodeId",
    message: "There is no structural path from entry to the terminal node.",
    suggestion: "Add a completion path; an implicit self-loop alone cannot finish the graph."
  });
  return finish();
}
export function nodeGuidance(config: FSMGraphConfig, nodeId: string, declaredPattern?: NodePattern) {
  const node = config.nodes.find(n => n.id === nodeId);
  if (!node) return null;
  const pattern = declaredPattern ?? inferNodePattern(node, config.entryNodeId, config.terminalNodeId ?? "end");
  const connections = config.edges.filter(e => e.from === nodeId);
  const pins = (node.pins ?? []).map(p => p.name);
  return {
    pattern,
    ...NODE_PATTERNS[pattern],
    pins,
    implicitSelfLoopPins: node.selfLoop ? pins.filter(pin => !connections.some(e => e.type === "EdgeAlways" || e.type === "EdgeWhen" && e.params?.source === "node" && e.params.turnKey === "routeTarget" && e.params.equals === pin)) : [],
    connections,
    currentActions: (node.actions ?? []).map(a => a.type)
  };
}
export function errorCode(error: unknown): string {
  return typeof (error as {
    code?: unknown;
  })?.code === "string" ? (error as {
    code: string;
  }).code : "INVALID_GRAPH";
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
