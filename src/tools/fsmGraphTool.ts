/**
 * `fsm_graph` tool: library CRUD + slim catalog + per-type describe.
 *
 * LLM-authored graphs persist with origin "llm" and enabled: false.
 * Whole-graph `save` / client `config` validate are retired — use
 * `fsm_graph_edit` for mutations and `describe_action` / `describe_edge`
 * before filling action/edge params.
 *
 * Tools never statically import agent/fsm — the host wires the port.
 */

export type FsmGraphEntryLike = {
  id: string;
  name: string;
  updatedAt: number;
  origin: "user" | "llm";
  enabled: boolean;
};

export type FsmGraphRecordLike = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  origin: "user" | "llm";
  config: unknown;
};

export type FsmGraphForkMode = "react" | "ask" | "plan_execute" | "subagent";

/** Full catalog entry (fsm_graph describe_action; editor uses the IPC catalog). */
export type FsmActionCatalogEntryLike = {
  type: string;
  description?: string;
  paramsSchema: Record<string, unknown>;
};

/** Slim catalog for LLM list (no nested paramsSchema). */
export type FsmCatalogSlimEntryLike = {
  type: string;
  description?: string;
  required?: string[];
};

export type FsmGraphEditInputLike = {
  action?: unknown;
  id?: unknown;
  name?: unknown;
  description?: unknown;
  nodeId?: unknown;
  pinName?: unknown;
  type?: unknown;
  params?: unknown;
  index?: unknown;
  from?: unknown;
  to?: unknown;
  selfLoop?: unknown;
};

export type FsmGraphEditResultLike =
  | { ok: true; graph: FsmGraphRecordLike }
  | { ok: false; error: string; code?: string };

export type FsmGraphLibraryPort = {
  listFsmGraphs(): Promise<FsmGraphEntryLike[]>;
  getFsmGraph(id: string): Promise<FsmGraphRecordLike | null>;
  createNewGraphRecord(
    name: string,
    opts?: { origin?: "user" | "llm" },
  ): FsmGraphRecordLike;
  createForkFromBuiltin(
    mode: FsmGraphForkMode,
    name?: string,
  ): FsmGraphRecordLike;
  saveFsmGraph(record: Record<string, unknown>): Promise<FsmGraphRecordLike>;
  deleteFsmGraph(id: string): Promise<void>;
  /** Validate a stored graph by id (no client-supplied config). */
  validateStoredGraph(id: string): Promise<void>;
  listActionCatalogSlim(): FsmCatalogSlimEntryLike[];
  listEdgeCatalogSlim(): FsmCatalogSlimEntryLike[];
  describeAction(type: string): FsmActionCatalogEntryLike | null;
  describeEdge(type: string): FsmActionCatalogEntryLike | null;
  applyGraphEdit(input: FsmGraphEditInputLike): Promise<FsmGraphEditResultLike>;
  detachFsmGraphFromSessions(graphId: string): string[];
};

export type FsmGraphToolDeps = FsmGraphLibraryPort;

export type FsmGraphToolInput = {
  action?: unknown;
  id?: unknown;
  name?: unknown;
  description?: unknown;
  forkMode?: unknown;
  type?: unknown;
};

export type FsmGraphToolResult = {
  ok: boolean;
  error?: string;
  code?: string;
  graphs?: unknown;
  graph?: unknown;
  deleted?: string;
  valid?: boolean;
  catalog?: unknown;
  edges?: unknown;
  action?: unknown;
  edge?: unknown;
  note?: string;
};

export const FSM_GRAPH_TOOL_ACTIONS = [
  "list",
  "get",
  "create",
  "delete",
  "validate",
  "catalog",
  "describe_action",
  "describe_edge",
] as const;

const BUILTIN_FORK_MODES: readonly FsmGraphForkMode[] = [
  "react",
  "ask",
  "plan_execute",
  "subagent",
];

function errorOut(error: string, code?: string): FsmGraphToolResult {
  return code ? { ok: false, error, code } : { ok: false, error };
}

function toErrorResult(err: unknown): FsmGraphToolResult {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string"
      ? { ok: false, error: err.message, code }
      : errorOut(err.message);
  }
  return errorOut(String(err));
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseForkMode(value: unknown): FsmGraphForkMode | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && value.trim()) {
    const mode = value.trim() as FsmGraphForkMode;
    if (BUILTIN_FORK_MODES.includes(mode)) return mode;
  }
  return "invalid";
}

export async function runFsmGraphTool(
  input: FsmGraphToolInput,
  deps: FsmGraphToolDeps,
): Promise<FsmGraphToolResult> {
  const action = trimmedString(input.action);
  if (!action || !FSM_GRAPH_TOOL_ACTIONS.includes(action as never)) {
    return errorOut(
      `action must be one of: ${FSM_GRAPH_TOOL_ACTIONS.join(", ")}`,
    );
  }

  try {
    switch (action) {
      case "list": {
        const graphs = await deps.listFsmGraphs();
        return {
          ok: true,
          graphs,
          note: "open a graph with action:'get'; mutate with fsm_graph_edit; params via describe_action / describe_edge",
        };
      }

      case "get": {
        const id = trimmedString(input.id);
        if (!id) return errorOut("get requires a non-empty id");
        const record = await deps.getFsmGraph(id);
        return record
          ? { ok: true, graph: record }
          : errorOut(`FSM graph not found: ${id}`);
      }

      case "create": {
        const name = trimmedString(input.name);
        if (!name) return errorOut("create requires a non-empty name");
        const forkMode = parseForkMode(input.forkMode);
        if (forkMode === "invalid") {
          return errorOut(
            `forkMode must be one of: ${BUILTIN_FORK_MODES.join(", ")}`,
          );
        }
        const base = forkMode
          ? deps.createForkFromBuiltin(forkMode, name)
          : deps.createNewGraphRecord(name, { origin: "llm" });
        const description = trimmedString(input.description);
        const saved = await deps.saveFsmGraph({
          ...base,
          origin: "llm",
          enabled: false,
          ...(description ? { description } : {}),
        });
        return {
          ok: true,
          graph: saved,
          note: 'saved disabled (origin "llm") — edit with fsm_graph_edit; user must enable in Graphs editor before it can run',
        };
      }

      case "delete": {
        const id = trimmedString(input.id);
        if (!id) return errorOut("delete requires a non-empty id");
        deps.detachFsmGraphFromSessions(id);
        await deps.deleteFsmGraph(id);
        return { ok: true, deleted: id };
      }

      case "validate": {
        const id = trimmedString(input.id);
        if (!id) return errorOut("validate requires a non-empty id (stored graph)");
        await deps.validateStoredGraph(id);
        return { ok: true, valid: true };
      }

      case "catalog": {
        return {
          ok: true,
          catalog: deps.listActionCatalogSlim(),
          edges: deps.listEdgeCatalogSlim(),
          note: "slim index only — call describe_action / describe_edge with a type before append_action / add_edge",
        };
      }

      case "describe_action": {
        const type = trimmedString(input.type);
        if (!type) return errorOut("describe_action requires type");
        const entry = deps.describeAction(type);
        if (!entry) {
          const known = deps
            .listActionCatalogSlim()
            .map((e) => e.type)
            .join(", ");
          return errorOut(
            `Unknown NodeAction type "${type}". Known: ${known}. Call catalog first.`,
          );
        }
        return { ok: true, action: entry };
      }

      case "describe_edge": {
        const type = trimmedString(input.type);
        if (!type) return errorOut("describe_edge requires type");
        const entry = deps.describeEdge(type);
        if (!entry) {
          const known = deps
            .listEdgeCatalogSlim()
            .map((e) => e.type)
            .join(", ");
          return errorOut(
            `Unknown Edge type "${type}". Known: ${known}. Call catalog first.`,
          );
        }
        return { ok: true, edge: entry };
      }

      default:
        return errorOut(
          `action must be one of: ${FSM_GRAPH_TOOL_ACTIONS.join(", ")}`,
        );
    }
  } catch (err) {
    return toErrorResult(err);
  }
}
