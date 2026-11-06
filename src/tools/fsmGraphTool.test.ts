import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { runFsmGraphEditTool } from "./fsmGraphEditTool.js";
import {
  runFsmGraphTool,
  type FsmActionCatalogEntryLike,
  type FsmCatalogSlimEntryLike,
  type FsmGraphEditInputLike,
  type FsmGraphEditResultLike,
  type FsmGraphLibraryPort,
  type FsmGraphRecordLike,
} from "./fsmGraphTool.js";

type StoreRecord = FsmGraphRecordLike &
  Record<string, unknown> & { createdAt: number; updatedAt: number };

/**
 * Pure in-memory port — no agent/fsm imports (isolation.boundaries).
 */
function makeHarness() {
  const store = new Map<string, StoreRecord>();
  const detachLog: string[] = [];
  let sequence = 0;

  function nextId(): string {
    sequence += 1;
    return `g${sequence}`;
  }

  const validateConfig = (config: Record<string, unknown>): void => {
    const nodes = (config as { nodes?: unknown }).nodes;
    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw Object.assign(
        new Error("FSMGraphConfig.nodes must be a non-empty array"),
        { code: "EMPTY_NODES" },
      );
    }
  };

  const actionSchemas: Record<string, Record<string, unknown>> = {
    ask_user: {
      type: "object",
      properties: {
        question: { type: "string" },
      },
      required: ["question"],
      additionalProperties: false,
    },
    NoParams: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };

  const edgeSchemas: Record<string, Record<string, unknown>> = {
    EdgeAlways: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    EdgeWhen: {
      type: "object",
      properties: {
        turnKey: { type: "string" },
        equals: {},
      },
      required: ["turnKey"],
      additionalProperties: false,
    },
  };

  function slimFrom(
    schemas: Record<string, Record<string, unknown>>,
  ): FsmCatalogSlimEntryLike[] {
    return Object.keys(schemas).map((type) => {
      const schema = schemas[type]!;
      const required = Array.isArray(schema.required)
        ? schema.required.filter((k): k is string => typeof k === "string")
        : undefined;
      return {
        type,
        ...(required && required.length > 0 ? { required } : {}),
      };
    });
  }

  function validateParams(
    schema: Record<string, unknown>,
    params: Record<string, unknown> | undefined,
    label: string,
  ): Record<string, unknown> {
    const input = params ?? {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((k): k is string => typeof k === "string")
      : [];
    for (const key of required) {
      if (!(key in input)) {
        throw Object.assign(
          new Error(`${label}: missing required property "${key}"`),
          { code: "INVALID_ACTION_PARAMS" },
        );
      }
    }
    if (schema.additionalProperties === false) {
      const props = (schema.properties ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(input)) {
        if (!(key in props)) {
          throw Object.assign(
            new Error(`${label}: unexpected property "${key}"`),
            { code: "INVALID_ACTION_PARAMS" },
          );
        }
      }
    }
    return { ...input };
  }

  const deps: FsmGraphLibraryPort = {
    listFsmGraphs: async () =>
      [...store.values()].map(({ id, name, updatedAt, origin, enabled }) => ({
        id,
        name,
        updatedAt,
        origin,
        enabled,
      })),
    getFsmGraph: async (id) => store.get(id) ?? null,
    createNewGraphRecord: (name, opts) => {
      const now = Date.now();
      return {
        id: nextId(),
        name,
        createdAt: now,
        updatedAt: now,
        config: {
          version: 1,
          entryNodeId: "start",
          nodes: [{ id: "start" }, { id: "n1", actions: [] }],
          edges: [],
        },
        origin: opts?.origin === "llm" ? "llm" : "user",
        enabled: opts?.origin !== "llm",
      };
    },
    createForkFromBuiltin: (mode, name) => {
      const now = Date.now();
      return {
        id: nextId(),
        name: name ?? `${mode} (fork)`,
        createdAt: now,
        updatedAt: now,
        config: {
          version: 1,
          forkedFrom: mode,
          entryNodeId: "start",
          nodes: [{ id: "start" }, { id: "n1", actions: [] }],
          edges: [],
        },
        origin: "user",
        enabled: true,
      };
    },
    saveFsmGraph: async (record) => {
      validateConfig(record.config as Record<string, unknown>);
      const stored = { ...record, updatedAt: Date.now() } as StoreRecord;
      store.set(stored.id, stored);
      return stored;
    },
    deleteFsmGraph: async (id) => {
      store.delete(id);
    },
    validateStoredGraph: async (id) => {
      const record = store.get(id);
      if (!record) {
        throw Object.assign(new Error(`FSM graph not found: ${id}`), {
          code: "NOT_FOUND",
        });
      }
      validateConfig(record.config as Record<string, unknown>);
    },
    listActionCatalogSlim: () => slimFrom(actionSchemas),
    listEdgeCatalogSlim: () => slimFrom(edgeSchemas),
    describeAction: (type) => {
      const schema = actionSchemas[type];
      if (!schema) return null;
      return { type, paramsSchema: schema };
    },
    describeEdge: (type) => {
      const schema = edgeSchemas[type];
      if (!schema) return null;
      return { type, paramsSchema: schema };
    },
    applyGraphEdit: async (input: FsmGraphEditInputLike): Promise<FsmGraphEditResultLike> => {
      const id = typeof input.id === "string" ? input.id.trim() : "";
      const action = typeof input.action === "string" ? input.action.trim() : "";
      const existing = store.get(id);
      if (!existing) return { ok: false, error: `FSM graph not found: ${id}` };
      const config = structuredClone(existing.config) as {
        version: number;
        entryNodeId: string;
        nodes: Array<{
          id: string;
          actions?: Array<{ type: string; params?: Record<string, unknown> }>;
        }>;
        edges: Array<Record<string, unknown>>;
      };

      try {
        if (action === "append_action") {
          const nodeId =
            typeof input.nodeId === "string" ? input.nodeId.trim() : "";
          const type = typeof input.type === "string" ? input.type.trim() : "";
          const schema = actionSchemas[type];
          if (!schema) {
            return {
              ok: false,
              error: `Unknown NodeAction type "${type}"`,
              code: "UNKNOWN_ACTION",
            };
          }
          const node = config.nodes.find((n) => n.id === nodeId);
          if (!node) return { ok: false, error: `node not found: ${nodeId}` };
          const params =
            input.params &&
            typeof input.params === "object" &&
            !Array.isArray(input.params)
              ? (input.params as Record<string, unknown>)
              : undefined;
          const normalized = validateParams(
            schema,
            params,
            `append_action ${type}`,
          );
          node.actions = [...(node.actions ?? []), { type, params: normalized }];
        } else if (action === "add_edge") {
          const from = typeof input.from === "string" ? input.from.trim() : "";
          const to = typeof input.to === "string" ? input.to.trim() : "";
          const type = typeof input.type === "string" ? input.type.trim() : "";
          const schema = edgeSchemas[type];
          if (!schema) {
            return {
              ok: false,
              error: `Unknown Edge type "${type}"`,
              code: "UNKNOWN_EDGE",
            };
          }
          const params =
            input.params &&
            typeof input.params === "object" &&
            !Array.isArray(input.params)
              ? (input.params as Record<string, unknown>)
              : undefined;
          const normalized = validateParams(schema, params, `add_edge ${type}`);
          config.edges.push({ from, to, type, params: normalized });
        } else if (action === "add_node") {
          const nodeId =
            typeof input.nodeId === "string" ? input.nodeId.trim() : "";
          if (!nodeId) return { ok: false, error: "add_node requires nodeId" };
          config.nodes.push({ id: nodeId, actions: [] });
        } else {
          return { ok: false, error: `unsupported harness action: ${action}` };
        }
        validateConfig(config);
        const saved = {
          ...existing,
          config,
          updatedAt: Date.now(),
        } as StoreRecord;
        store.set(id, saved);
        return { ok: true, graph: saved };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code =
          err instanceof Error
            ? (err as { code?: unknown }).code
            : undefined;
        return typeof code === "string"
          ? { ok: false, error: message, code }
          : { ok: false, error: message };
      }
    },
    detachFsmGraphFromSessions: (graphId) => {
      detachLog.push(graphId);
      return [];
    },
  };

  return { deps, store, detachLog };
}

describe("fsm_graph tool wiring", () => {
  it("runTools threads the port: declared, destructured, forwarded", () => {
    const src = readFileSync(
      new URL("../agent/runTools.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      src,
      /fsmGraphLibrary\?: import\("\.\.\/tools\/fsmGraphTool\.js"\)\.FsmGraphLibraryPort/,
      "runTools input type must declare fsmGraphLibrary",
    );
    assert.match(
      src,
      /\n    fsmGraphLibrary,/,
      "runTools must destructure fsmGraphLibrary from input",
    );
    assert.match(
      src,
      /\.\.\.\(fsmGraphLibrary \? \{ fsmGraphLibrary \} : \{\}\)/,
      "runTools must forward fsmGraphLibrary into the tool context",
    );
  });
});

describe("fsm_graph tool", () => {
  it("rejects unknown actions with the action list", async () => {
    const { deps } = makeHarness();
    const result = await runFsmGraphTool({ action: "run" }, deps);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /action must be one of/);
    assert.match(result.error ?? "", /describe_action/);
    assert.doesNotMatch(result.error ?? "", /\bsave\b/);
  });

  it("list returns library entries", async () => {
    const { deps } = makeHarness();
    const empty = await runFsmGraphTool({ action: "list" }, deps);
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.graphs, []);

    await runFsmGraphTool({ action: "create", name: "Authored" }, deps);
    const listed = await runFsmGraphTool({ action: "list" }, deps);
    assert.equal(listed.ok, true);
    const graphs = listed.graphs as Array<{ name: string; enabled: boolean }>;
    assert.equal(graphs.length, 1);
    assert.equal(graphs[0]?.name, "Authored");
    assert.equal(graphs[0]?.enabled, false);
  });

  it("create persists an llm-authored disabled graph and says so", async () => {
    const { deps, store } = makeHarness();
    const result = await runFsmGraphTool(
      { action: "create", name: "Pipeline" },
      deps,
    );
    assert.equal(result.ok, true);
    const graph = result.graph as {
      origin: string;
      enabled: boolean;
      id: string;
    };
    assert.equal(graph.origin, "llm");
    assert.equal(graph.enabled, false);
    assert.match(result.note ?? "", /enable/);

    const stored = store.get(graph.id);
    assert.ok(stored);
    assert.equal(stored.origin, "llm");
    assert.equal(stored.enabled, false);
  });

  it("create supports forkMode and rejects bogus modes", async () => {
    const { deps } = makeHarness();
    const forked = await runFsmGraphTool(
      { action: "create", name: "Fork", forkMode: "react" },
      deps,
    );
    assert.equal(forked.ok, true);
    const graph = forked.graph as {
      origin: string;
      enabled: boolean;
      config: { forkedFrom?: string };
    };
    assert.equal(graph.origin, "llm");
    assert.equal(graph.enabled, false);
    assert.equal(graph.config.forkedFrom, "react");

    const bad = await runFsmGraphTool(
      { action: "create", name: "Bad", forkMode: "nope" },
      deps,
    );
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /forkMode must be one of/);
  });

  it("get resolves by id and reports unknown ids", async () => {
    const { deps } = makeHarness();
    const missing = await runFsmGraphTool({ action: "get", id: "nope" }, deps);
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? "", /not found/);

    const created = await runFsmGraphTool(
      { action: "create", name: "G" },
      deps,
    );
    const id = (created.graph as { id: string }).id;
    const found = await runFsmGraphTool({ action: "get", id }, deps);
    assert.equal(found.ok, true);
    assert.equal((found.graph as { id: string }).id, id);
  });

  it("delete runs the detach guard before removing", async () => {
    const { deps, store, detachLog } = makeHarness();
    const created = await runFsmGraphTool(
      { action: "create", name: "G" },
      deps,
    );
    const id = (created.graph as { id: string }).id;

    const removed = await runFsmGraphTool({ action: "delete", id }, deps);
    assert.equal(removed.ok, true);
    assert.equal(removed.deleted, id);
    assert.deepEqual(detachLog, [id]);
    assert.equal(store.has(id), false);
  });

  it("catalog returns slim action/edge indexes without nested properties", async () => {
    const { deps } = makeHarness();
    const result = await runFsmGraphTool({ action: "catalog" }, deps);
    assert.equal(result.ok, true);
    const catalog = result.catalog as FsmCatalogSlimEntryLike[];
    assert.ok(Array.isArray(catalog));
    assert.ok(catalog.some((e) => e.type === "ask_user"));
    const blob = JSON.stringify(result.catalog);
    assert.equal(blob.includes('"properties"'), false);
    assert.ok(Array.isArray(result.edges));
  });

  it("describe_action returns paramsSchema; unknown type fails", async () => {
    const { deps } = makeHarness();
    const ok = await runFsmGraphTool(
      { action: "describe_action", type: "ask_user" },
      deps,
    );
    assert.equal(ok.ok, true);
    const entry = ok.action as FsmActionCatalogEntryLike;
    assert.equal(entry.type, "ask_user");
    assert.ok(entry.paramsSchema.properties);

    const bad = await runFsmGraphTool(
      { action: "describe_action", type: "Nope" },
      deps,
    );
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /Unknown NodeAction/);
  });

  it("validate checks a stored graph by id (no client config)", async () => {
    const { deps, store } = makeHarness();
    const created = await runFsmGraphTool(
      { action: "create", name: "G" },
      deps,
    );
    const id = (created.graph as { id: string }).id;

    const valid = await runFsmGraphTool({ action: "validate", id }, deps);
    assert.equal(valid.ok, true);
    assert.equal(valid.valid, true);

    const broken = store.get(id)!;
    broken.config = { version: 1, nodes: [], edges: [] };
    store.set(id, broken);
    const invalid = await runFsmGraphTool({ action: "validate", id }, deps);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, "EMPTY_NODES");

    const missing = await runFsmGraphTool(
      { action: "validate", id: "ghost" },
      deps,
    );
    assert.equal(missing.ok, false);
  });
});

describe("fsm_graph_edit", () => {
  it("append_action rejects missing required params without writing", async () => {
    const { deps, store } = makeHarness();
    const created = await runFsmGraphTool(
      { action: "create", name: "G" },
      deps,
    );
    const id = (created.graph as { id: string }).id;
    const before = JSON.stringify(store.get(id)?.config);

    const bad = await runFsmGraphEditTool(
      {
        action: "append_action",
        id,
        nodeId: "n1",
        type: "ask_user",
        params: { extra: true },
      },
      deps,
    );
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /missing required|unexpected/i);
    assert.equal(JSON.stringify(store.get(id)?.config), before);
  });

  it("append_action succeeds after valid params", async () => {
    const { deps } = makeHarness();
    const created = await runFsmGraphTool(
      { action: "create", name: "G" },
      deps,
    );
    const id = (created.graph as { id: string }).id;

    const ok = await runFsmGraphEditTool(
      {
        action: "append_action",
        id,
        nodeId: "n1",
        type: "ask_user",
        params: { question: "Ready?" },
      },
      deps,
    );
    assert.equal(ok.ok, true);
    const graph = ok.graph as {
      config: {
        nodes: Array<{
          id: string;
          actions?: Array<{ type: string; params?: Record<string, unknown> }>;
        }>;
      };
    };
    const node = graph.config.nodes.find((n) => n.id === "n1");
    assert.equal(node?.actions?.at(-1)?.type, "ask_user");
    assert.deepEqual(node?.actions?.at(-1)?.params, { question: "Ready?" });
  });

  it("schema descriptions require describe before append_action / add_edge", async () => {
    const { fsmGraphEditDefinition } = await import("./builtin/fsmGraphEdit.js");
    const blob = JSON.stringify(fsmGraphEditDefinition.parameters);
    assert.match(blob, /describe_action/);
    assert.match(blob, /describe_edge/);
    assert.match(fsmGraphEditDefinition.description, /catalog/);
  });
});
