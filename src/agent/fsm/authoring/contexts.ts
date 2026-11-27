import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDefaultActionRegistry } from "../actions/createDefaultActionRegistry.js";
import { loadGraphConfig } from "../compatibility/loadGraphConfig.js";
import { normalizeAndValidateParams } from "../paramsSchema.js";
import type { FSMGraphConfig, NodeActionConfig } from "../types.js";
import { createForkFromBuiltin, createNewGraphRecord, deleteFsmGraph, describeAction, describeEdge, getFsmGraph, graphRecordRevision, isBuiltinGraphId, listActionCatalogSlim, listEdgeCatalogSlim, listFsmGraphs, requireFsmGraphsRoot, saveFsmGraph } from "../graphLibrary/manager.js";
import type { BuiltinGraphMode, FsmGraphLibraryRecord } from "../graphLibrary/types.js";
import { ACTION_CONTRACTS, GRAPH_DESIGN_GUIDE, NODE_PATTERNS, type NodePattern } from "./contracts.js";
import { analyzeGraph, errorCode, message, nodeGuidance } from "./diagnostics.js";
import { knowledgeBase } from "../../../knowledge/store.js";

const FSM_AUTHORING_GUIDE_DOC = "fsm-graph/authoring-guide";
const FSM_ROUTING_GUIDE_DOC = "fsm-graph/routing-and-edges";
import type { FsmGraphAuthoringOwner, FsmGraphAuthoringResult, FsmGraphToolFamily } from "../../../tools/fsmGraphAuthoring.js";
type DraftAction = NodeActionConfig & {
  id: string;
};
type DraftSnapshot = {
  record: FsmGraphLibraryRecord;
  actionIds: Record<string, string[]>;
  nodePatterns: Record<string, NodePattern>;
};
export type GraphEditingContext = DraftSnapshot & {
  version: 1;
  contextId: string;
  workspacePath: string;
  sessionId?: string;
  revision: number;
  baseRevision: string | null;
  dirty: boolean;
  updatedAt: number;
  history: DraftSnapshot[];
};
const queues = new Map<string, Promise<unknown>>();
async function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
  const pending = (queues.get(key) ?? Promise.resolve()).then(work, work);
  queues.set(key, pending);
  try {
    return await pending;
  } finally {
    if (queues.get(key) === pending) queues.delete(key);
  }
}
function fail(code: string, error: string): never {
  throw Object.assign(new Error(error), {
    code
  });
}
function string(input: Record<string, unknown>, key: string): string {
  return typeof input[key] === "string" ? (input[key] as string).trim() : "";
}
function required(input: Record<string, unknown>, key: string): string {
  return string(input, key) || fail("MISSING_ARGUMENT", `${key} is required`);
}
function object(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_ARGUMENT", "params must be an object");
  return value as Record<string, unknown>;
}
function directory(): string {
  return join(requireFsmGraphsRoot(), "contexts");
}
function path(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) fail("INVALID_CONTEXT_ID", "Invalid contextId");
  return join(directory(), `${id}.json`);
}
async function persist(ctx: GraphEditingContext): Promise<void> {
  await mkdir(directory(), {
    recursive: true
  });
  const target = path(ctx.contextId);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(ctx));
    await rename(temp, target);
  } finally {
    await rm(temp, {
      force: true
    });
  }
}
async function read(id: string, owner?: FsmGraphAuthoringOwner): Promise<GraphEditingContext> {
  let ctx: GraphEditingContext;
  try {
    ctx = JSON.parse(await readFile(path(id), "utf8"));
  } catch (error) {
    if ((error as {
      code?: string;
    }).code === "ENOENT") fail("CONTEXT_NOT_FOUND", "Graph context not found; list contexts to resume or create a new one.");
    throw error;
  }
  if (owner && ctx.workspacePath !== owner.workspacePath) fail("CONTEXT_WORKSPACE_MISMATCH", "This editing context belongs to another workspace.");
  ctx.nodePatterns ??= {};
  return ctx;
}
function alignActionIds(ctx: GraphEditingContext): void {
  const next: Record<string, string[]> = Object.create(null);
  for (const node of ctx.record.config.nodes) next[node.id] = (node.actions ?? []).map((_, index) => ctx.actionIds[node.id]?.[index] ?? randomUUID());
  ctx.actionIds = next;
  for (const edge of ctx.record.config.edges) edge.id ??= randomUUID();
}
function configWithHandles(ctx: GraphEditingContext): FSMGraphConfig {
  const config = structuredClone(ctx.record.config);
  config.nodes.forEach(n => n.actions?.forEach((a, index) => {
    (a as DraftAction).id = ctx.actionIds[n.id]![index]!;
  }));
  return config;
}
function snapshot(ctx: GraphEditingContext): DraftSnapshot {
  return structuredClone({
    record: ctx.record,
    actionIds: ctx.actionIds,
    nodePatterns: ctx.nodePatterns
  });
}
function guidance(ctx: GraphEditingContext, nodeId: string) {
  return nodeGuidance(ctx.record.config, nodeId, ctx.nodePatterns[nodeId]);
}
function result(ctx: GraphEditingContext, extra: Record<string, unknown> = {}): FsmGraphAuthoringResult {
  const validation = analyzeGraph(configWithHandles(ctx));
  const {
    issues,
    ...status
  } = validation;
  return {
    ok: true,
    contextId: ctx.contextId,
    graphId: ctx.record.id,
    revision: ctx.revision,
    readyToCommit: validation.valid,
    enabled: false,
    summary: {
      name: ctx.record.name,
      nodes: ctx.record.config.nodes.map(n => ({
        id: n.id,
        name: n.name,
        selfLoop: n.selfLoop === true,
        pattern: guidance(ctx, n.id)?.pattern,
        pins: (n.pins ?? []).map(p => p.name),
        actions: (n.actions ?? []).map((a, index) => ({
          actionId: ctx.actionIds[n.id]![index],
          type: a.type
        }))
      })),
      connections: ctx.record.config.edges
    },
    validation: {
      ...status,
      issues: issues.slice(0, 30),
      remainingIssues: Math.max(0, issues.length - 30)
    },
    next: validation.valid ? "Review warnings, then commit this revision. New graphs remain disabled until the user enables them." : "Draft saved. Fix blocking issues using node/connection/action tools; validate returns all diagnostics.",
    ...extra
  };
}
async function list(owner?: FsmGraphAuthoringOwner): Promise<GraphEditingContext[]> {
  let files: string[];
  try {
    files = await readdir(directory());
  } catch (error) {
    if ((error as {
      code?: string;
    }).code === "ENOENT") return [];
    throw error;
  }
  const contexts = await Promise.all(files.filter(f => /^[a-f0-9-]{36}\.json$/.test(f)).map(async f => {
    try {
      return await read(f.slice(0, -5));
    } catch {
      return null;
    }
  }));
  return contexts.filter((ctx): ctx is GraphEditingContext => !!ctx && (!owner || ctx.workspacePath === owner.workspacePath));
}
export async function listGraphDrafts() {
  return (await list()).filter(ctx => ctx.dirty !== false).map(ctx => ({
    id: `draft:${ctx.contextId}`,
    name: ctx.record.name,
    updatedAt: ctx.updatedAt,
    origin: ctx.record.origin,
    enabled: false,
    draftContextId: ctx.contextId,
    validation: analyzeGraph(configWithHandles(ctx)),
    ...(ctx.record.color ? {
      color: ctx.record.color
    } : {})
  }));
}
export async function getGraphDraft(id: string): Promise<FsmGraphLibraryRecord> {
  const ctx = await read(id.replace(/^draft:/, ""));
  return {
    ...ctx.record,
    id: `draft:${ctx.contextId}`,
    enabled: false,
    config: configWithHandles(ctx),
    draftContextId: ctx.contextId,
    draftRevision: ctx.revision,
    validation: analyzeGraph(configWithHandles(ctx))
  };
}
export async function discardGraphDraft(id: string): Promise<void> {
  await locked(path(id.replace(/^draft:/, "")), () => rm(path(id.replace(/^draft:/, "")), {
    force: true
  }));
}
async function commit(ctx: GraphEditingContext) {
  const validation = analyzeGraph(configWithHandles(ctx));
  if (!validation.valid) return {
    ...result(ctx),
    ok: false,
    code: "GRAPH_INVALID",
    error: "Fix all blocking issues before committing.",
    validation
  };
  const saved = await saveFsmGraph(ctx.record, ctx.baseRevision);
  ctx.record = saved;
  ctx.baseRevision = graphRecordRevision(saved);
  ctx.history = [];
  ctx.dirty = false;
  ctx.revision += 1;
  ctx.updatedAt = Date.now();
  await persist(ctx);
  return result(ctx, {
    committed: true,
    graph: saved,
    enabled: saved.enabled
  });
}
export async function saveGraphDraftFromEditor(record: FsmGraphLibraryRecord, shouldCommit = false): Promise<FsmGraphLibraryRecord> {
  const id = record.draftContextId ?? record.id.replace(/^draft:/, "");
  return locked(path(id), async () => {
    const ctx = await read(id);
    if (record.draftRevision !== ctx.revision) fail("CONTEXT_CONFLICT", "The draft changed. Reopen it before saving these edits.");
    const config = loadGraphConfig(record.config).config;
    if (shouldCommit) {
      const validation = analyzeGraph(config);
      if (!validation.valid) throw Object.assign(new Error("Fix all validation errors before committing this draft."), {
        code: "GRAPH_INVALID",
        validation
      });
    }
    ctx.history.push(snapshot(ctx));
    ctx.history = ctx.history.slice(-30);
    const oldIds = ctx.actionIds;
    ctx.actionIds = Object.fromEntries(config.nodes.map(n => [n.id, (n.actions ?? []).map((a, index) => {
      const handle = (a as DraftAction).id;
      delete (a as Partial<DraftAction>).id;
      return handle && Object.values(oldIds).some(ids => ids.includes(handle)) ? handle : randomUUID();
    })]));
    const { nodeLayout: _previousLayout, ...previousRecord } = ctx.record;
    ctx.record = {
      ...previousRecord,
      config,
      name: record.name,
      ...(record.color ? {
        color: record.color
      } : {}),
      ...(record.nodeLayout ? {
        nodeLayout: record.nodeLayout
      } : {})
    };
    ctx.dirty = true;
    ctx.revision++;
    ctx.updatedAt = Date.now();
    alignActionIds(ctx);
    await persist(ctx);
    if (shouldCommit) {
      const committed = await commit(ctx);
      if (!committed.ok) throw Object.assign(new Error(committed.error), {
        validation: committed.validation
      });
    }
    return getGraphDraft(id);
  });
}
export async function executeGraphAuthoring(family: FsmGraphToolFamily, input: Record<string, unknown>, owner: FsmGraphAuthoringOwner): Promise<FsmGraphAuthoringResult> {
  try {
    const operation = required(input, "operation");
    if (family === "context" && operation === "guide") {
      const doc = knowledgeBase.isConfigured() ? knowledgeBase.getDoc(FSM_AUTHORING_GUIDE_DOC) : null;
      return {
        ok: true,
        guide: doc ? doc.body : GRAPH_DESIGN_GUIDE,
        ...(doc ? { guideDoc: doc.id } : {}),
        patterns: NODE_PATTERNS
      };
    }
    if (family === "context" && operation === "list") return {
      ok: true,
      graphs: await listFsmGraphs(),
      contexts: (await list(owner)).map(ctx => ({
        contextId: ctx.contextId,
        graphId: ctx.record.id,
        name: ctx.record.name,
        revision: ctx.revision,
        updatedAt: ctx.updatedAt
      }))
    };
    if (family === "action" && operation === "catalog") return {
      ok: true,
      actions: listActionCatalogSlim(),
      patterns: NODE_PATTERNS,
      next: "Describe an action with contextId and nodeId before configuring it."
    };
    if (family === "connection" && operation === "catalog") return {
      ok: true,
      edges: listEdgeCatalogSlim(),
      guide: GRAPH_DESIGN_GUIDE.execution,
      guideDoc: FSM_ROUTING_GUIDE_DOC
    };
    if ((family === "action" || family === "connection") && operation === "describe") {
      const type = required(input, "type");
      const description = family === "action" ? describeAction(type) : describeEdge(type);
      if (!description) fail("UNKNOWN_TYPE", `Unknown ${family} type: ${type}. Use catalog.`);
      let context = null;
      if (string(input, "contextId")) {
        const ctx = await read(string(input, "contextId"), owner);
        context = guidance(ctx, required(input, "nodeId"));
        if (!context) fail("NODE_NOT_FOUND", "nodeId does not exist in this context");
      }
      return {
        ok: true,
        ...description,
        ...(family === "action" ? {
          contract: ACTION_CONTRACTS[type] ?? {
            guidance: "Follow paramsSchema and details. Specialized actions are not required to follow a model-round sequence."
          }
        } : {}),
        context
      };
    }
    if (family === "context" && operation === "delete_graph") {
      const graphId = required(input, "graphId");
      await deleteFsmGraph(graphId);
      return {
        ok: true,
        deleted: graphId
      };
    }
    if (family === "context" && (operation === "create" || operation === "open")) {
      let record: FsmGraphLibraryRecord;
      let baseRevision: string | null = null;
      if (operation === "open") {
        const graphId = required(input, "graphId");
        const existing = await getFsmGraph(graphId);
        if (!existing) fail("GRAPH_NOT_FOUND", "Graph not found");
        if (isBuiltinGraphId(graphId)) fail("BUILTIN_READ_ONLY", "Use create with template=react_v2 to fork the built-in graph.");
        record = existing;
        baseRevision = graphRecordRevision(record);
      } else {
        const name = required(input, "name");
        const template = string(input, "template");
        if (template && !["react", "react_v2", "ask", "plan_execute", "subagent"].includes(template)) fail("UNKNOWN_TEMPLATE", "Use react, react_v2, ask, plan_execute or subagent; omit template for an empty Start/End skeleton.");
        record = template ? createForkFromBuiltin(template as BuiltinGraphMode, name) : {
          ...createNewGraphRecord(name, {
            origin: "llm"
          }),
          config: {
            version: 2,
            entryNodeId: "start",
            terminalNodeId: "end",
            nodes: [{
              id: "start",
              actions: []
            }, {
              id: "end",
              actions: []
            }],
            edges: []
          }
        };
        record.origin = "llm";
        record.enabled = false;
      }
      const ctx: GraphEditingContext = {
        version: 1,
        contextId: randomUUID(),
        workspacePath: owner.workspacePath,
        ...(owner.sessionId ? {
          sessionId: owner.sessionId
        } : {}),
        revision: 0,
        baseRevision,
        dirty: operation === "create",
        record,
        actionIds: {},
        nodePatterns: {
          [record.config.entryNodeId]: "entry",
          [record.config.terminalNodeId ?? "end"]: "end"
        },
        updatedAt: Date.now(),
        history: []
      };
      alignActionIds(ctx);
      await persist(ctx);
      return result(ctx, {
        guide: GRAPH_DESIGN_GUIDE,
        patterns: NODE_PATTERNS
      });
    }
    const id = required(input, "contextId");
    return await locked(path(id), async () => {
      const ctx = await read(id, owner);
      if (family === "context" && operation === "inspect") return result(ctx, input.full === true ? {
        config: configWithHandles(ctx)
      } : {});
      if (family === "context" && operation === "validate") return result(ctx, {
        validation: analyzeGraph(configWithHandles(ctx))
      });
      if (family === "node" && operation === "inspect") {
        const nodeId = required(input, "nodeId");
        const node = configWithHandles(ctx).nodes.find(n => n.id === nodeId);
        if (!node) fail("NODE_NOT_FOUND", "Node not found");
        return result(ctx, {
          node,
          guidance: guidance(ctx, nodeId)
        });
      }
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== ctx.revision) fail("CONTEXT_CONFLICT", `expectedRevision must equal ${ctx.revision}; inspect the context before editing.`);
      if (family === "context" && operation === "commit") return commit(ctx);
      if (family === "context" && operation === "discard") {
        await rm(path(id), {
          force: true
        });
        return {
          ok: true,
          discarded: id
        };
      }
      const before = snapshot(ctx);
      let change: Record<string, unknown> = {
        operation
      };
      if (family === "context") {
        if (operation === "undo") {
          const previous = ctx.history.pop();
          if (!previous) fail("NOTHING_TO_UNDO", "No earlier edit to restore");
          ctx.record = previous.record;
          ctx.actionIds = previous.actionIds;
          ctx.nodePatterns = previous.nodePatterns ?? {};
        } else if (operation === "set_meta") {
          if (input.name !== undefined) ctx.record.name = required(input, "name");
          if (input.description !== undefined) ctx.record.description = string(input, "description");
          for (const key of ["entryNodeId", "terminalNodeId"] as const) if (input[key] !== undefined) {
            const nodeId = required(input, key);
            if (!ctx.record.config.nodes.some(n => n.id === nodeId)) fail("NODE_NOT_FOUND", `${key} must reference an existing node`);
            ctx.record.config[key] = nodeId;
          }
        } else fail("UNKNOWN_OPERATION", "Context operations: guide, list, create, open, inspect, validate, set_meta, undo, commit, discard, delete_graph");
      } else if (family === "node") {
        const nodeId = required(input, "nodeId");
        const config = ctx.record.config;
        let node = config.nodes.find(n => n.id === nodeId);
        const pattern = string(input, "pattern");
        if (pattern && !Object.hasOwn(NODE_PATTERNS, pattern)) fail("UNKNOWN_PATTERN", "Use a node pattern from context guide");
        if (pattern) ctx.nodePatterns[nodeId] = pattern as NodePattern;
        if (operation === "add") {
          if (input.selfLoop !== undefined && typeof input.selfLoop !== "boolean") fail("INVALID_ARGUMENT", "selfLoop must be boolean");
          if (node) fail("DUPLICATE_NODE", "nodeId already exists");
          node = {
            id: nodeId,
            name: string(input, "name") || nodeId,
            actions: [],
            pins: [],
            selfLoop: input.selfLoop === true
          };
          config.nodes.push(node);
          ctx.actionIds[nodeId] = [];
        } else {
          if (!node) fail("NODE_NOT_FOUND", `Node not found: ${nodeId}`);
          if (operation === "inspect") return result(ctx, {
            node: configWithHandles(ctx).nodes.find(n => n.id === nodeId),
            guidance: guidance(ctx, nodeId)
          });
          if (operation === "update") {
            if (input.name !== undefined) node.name = required(input, "name");
            if (input.selfLoop !== undefined) {
              if (typeof input.selfLoop !== "boolean") fail("INVALID_ARGUMENT", "selfLoop must be boolean");
              node.selfLoop = input.selfLoop;
            }
          } else if (operation === "remove") {
            if (nodeId === config.entryNodeId || nodeId === (config.terminalNodeId ?? "end")) fail("PROTECTED_NODE", "Choose new entry/terminal nodes in set_meta before removing this node");
            config.nodes = config.nodes.filter(n => n.id !== nodeId);
            const edges = config.edges.filter(e => e.from === nodeId || e.to === nodeId);
            config.edges = config.edges.filter(e => e.from !== nodeId && e.to !== nodeId);
            delete ctx.actionIds[nodeId];
            delete ctx.nodePatterns[nodeId];
            change = {
              ...change,
              removedConnections: edges.map(e => e.id)
            };
          } else if (operation === "add_pin" || operation === "remove_pin") {
            const pin = required(input, "pin");
            if (operation === "add_pin") {
              if ((node.pins ?? []).some(p => p.name === pin)) fail("DUPLICATE_PIN", "Pin already exists");
              node.pins = [...(node.pins ?? []), {
                name: pin
              }];
            } else {
              if (!(node.pins ?? []).some(p => p.name === pin)) fail("PIN_NOT_FOUND", "Pin not found");
              node.pins = (node.pins ?? []).filter(p => p.name !== pin);
            }
          } else fail("UNKNOWN_OPERATION", "Node operations: add, inspect, update, remove, add_pin, remove_pin");
        }
        change = {
          ...change,
          nodeId,
          guidance: guidance(ctx, nodeId)
        };
      } else if (family === "action") {
        const nodeId = required(input, "nodeId");
        const node = ctx.record.config.nodes.find(n => n.id === nodeId);
        if (!node) fail("NODE_NOT_FOUND", `Node not found: ${nodeId}`);
        node.actions ??= [];
        const ids = ctx.actionIds[nodeId]!;
        const actionId = operation === "add" ? string(input, "actionId") || randomUUID() : required(input, "actionId");
        const index = ids.indexOf(actionId);
        if (operation === "add" && Object.values(ctx.actionIds).some(a => a.includes(actionId))) fail("DUPLICATE_ACTION_ID", "actionId already exists");
        if (operation !== "add" && index < 0) fail("ACTION_NOT_FOUND", "actionId not found on this node; inspect to obtain stable ids");
        if (operation === "add" || operation === "update") {
          const type = operation === "add" ? required(input, "type") : string(input, "type") || node.actions[index]!.type;
          const params = input.params === undefined && operation === "update" ? node.actions[index]!.params : object(input.params);
          let prepared;
          try {
            prepared = createDefaultActionRegistry().prepareAction(type, params, `node ${nodeId} action ${actionId}`);
          } catch (error) {
            throw Object.assign(new Error(message(error)), {
              code: errorCode(error),
              details: {
                nodeId,
                actionId,
                type,
                description: describeAction(type),
                contract: ACTION_CONTRACTS[type],
                availablePins: (node.pins ?? []).map(p => p.name)
              }
            });
          }
          const next = {
            type: prepared.type,
            params: structuredClone(prepared.params)
          };
          if (operation === "update") node.actions[index] = next;else {
            const beforeId = string(input, "beforeActionId");
            const at = beforeId ? ids.indexOf(beforeId) : ids.length;
            if (at < 0) fail("ACTION_NOT_FOUND", "beforeActionId not found on this node");
            node.actions.splice(at, 0, next);
            ids.splice(at, 0, actionId);
          }
        } else if (operation === "remove") {
          node.actions.splice(index, 1);
          ids.splice(index, 1);
        } else if (operation === "move") {
          const beforeId = string(input, "beforeActionId");
          if (beforeId === actionId) fail("INVALID_ARGUMENT", "beforeActionId must name a different action");
          if (beforeId && !ids.includes(beforeId)) fail("ACTION_NOT_FOUND", "beforeActionId not found");
          const [moved] = node.actions.splice(index, 1);
          ids.splice(index, 1);
          const at = beforeId ? ids.indexOf(beforeId) : ids.length;
          node.actions.splice(at, 0, moved!);
          ids.splice(at, 0, actionId);
        } else fail("UNKNOWN_OPERATION", "Action operations: catalog, describe, add, update, move, remove");
        change = {
          ...change,
          nodeId,
          actionId
        };
      } else if (family === "connection") {
        const config = ctx.record.config;
        const connectionId = operation === "connect" ? string(input, "connectionId") || randomUUID() : required(input, "connectionId");
        const index = config.edges.findIndex(e => e.id === connectionId);
        if (operation === "disconnect") {
          if (index < 0) fail("CONNECTION_NOT_FOUND", "Connection not found");
          config.edges.splice(index, 1);
        } else if (operation === "connect" || operation === "update") {
          if (operation === "connect" && index >= 0) fail("DUPLICATE_CONNECTION", "connectionId already exists");
          if (operation === "update" && index < 0) fail("CONNECTION_NOT_FOUND", "Connection not found");
          const from = required(input, "from"),
            to = required(input, "to");
          const source = config.nodes.find(n => n.id === from);
          if (!source || !config.nodes.some(n => n.id === to)) fail("NODE_NOT_FOUND", "Create both endpoint nodes before connecting them");
          const pin = string(input, "pin");
          const type = pin ? "EdgeWhen" : string(input, "type") || "EdgeAlways";
          if (pin && (input.params !== undefined || input.type !== undefined)) fail("INVALID_ARGUMENT", "Use pin for a route connection, or type/params for an explicit predicate; do not combine them");
          const params = pin ? {
            source: "node",
            turnKey: "routeTarget",
            equals: pin
          } : object(input.params);
          const normalized = normalizeAndValidateParams(createDefaultActionRegistry().getEdgeParamsSchema(type), params, "connection");
          const others = config.edges.filter((_, i) => i !== index && config.edges[i]!.from === from);
          if (others.some(e => type === "EdgeAlways" || e.type === "EdgeAlways" || pin && e.type === "EdgeWhen" && e.params?.source === "node" && e.params.turnKey === "routeTarget" && e.params.equals === pin)) fail("CONNECTION_CONFLICT", "This connection conflicts with an existing unconditional edge or pin owner. Disconnect/update it explicitly; no edge is silently replaced.");
          if (pin && !(source.pins ?? []).some(p => p.name === pin)) source.pins = [...(source.pins ?? []), {
            name: pin
          }];
          const next = {
            id: connectionId,
            from,
            to,
            type,
            params: normalized
          };
          if (index < 0) config.edges.push(next);else config.edges[index] = next;
        } else fail("UNKNOWN_OPERATION", "Connection operations: catalog, describe, connect, update, disconnect");
        change = {
          ...change,
          connectionId
        };
      }
      if (operation !== "undo") {
        ctx.history.push(before);
        ctx.history = ctx.history.slice(-30);
      }
      ctx.dirty = true;
      alignActionIds(ctx);
      ctx.revision++;
      ctx.updatedAt = Date.now();
      await persist(ctx);
      return result(ctx, {
        change
      });
    });
  } catch (error) {
    return {
      ok: false,
      code: errorCode(error),
      error: message(error),
      ...((error as {
        details?: unknown;
      })?.details ? {
        details: (error as {
          details: unknown;
        }).details
      } : {})
    };
  }
}
