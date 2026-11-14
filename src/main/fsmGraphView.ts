import type { OrchestratorMode } from "../agent/roles/types.js";
import { graphConfigForMode } from "../agent/fsm/FsmGraphWorkflow.js";

/**
 * Serialized FSM topology for the DevTools FSM Graph tab. Mirrored as a
 * global interface in renderer env.d.ts (renderer never imports main code).
 */
export type FsmGraphViewNode = {
  id: string;
  name?: string;
  selfLoop: boolean;
  actionTypes: string[];
};

export type FsmGraphViewEdge = {
  from: string;
  to: string;
  type: string;
  /** EdgeWhen summary (e.g. `routeTarget=executor @node`); omitted for EdgeAlways. */
  when?: string;
};

export type FsmGraphView = {
  mode: OrchestratorMode;
  entryNodeId: string;
  terminalNodeId: string;
  nodes: FsmGraphViewNode[];
  edges: FsmGraphViewEdge[];
};

function summarizeWhen(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const record = params as Record<string, unknown>;
  const turnKey = typeof record.turnKey === "string" ? record.turnKey : null;
  if (!turnKey) return undefined;
  const parts = [turnKey];
  if ("equals" in record) {
    const equals =
      typeof record.equals === "string" ? record.equals : JSON.stringify(record.equals);
    parts.push(`=${equals}`);
  }
  if (record.source === "node") parts.push("@node");
  return parts.join("");
}

/** Build a renderer view DTO from any validated FSMGraphConfig. */
export function fsmGraphViewFromConfig(
  config: import("../agent/fsm/types.js").FSMGraphConfig,
): Omit<FsmGraphView, "mode"> & { mode: string } {
  return {
    mode: "custom",
    entryNodeId: config.entryNodeId,
    terminalNodeId: config.terminalNodeId ?? "end",
    nodes: config.nodes.map((node) => ({
      id: node.id,
      ...(node.name !== undefined ? { name: node.name } : {}),
      selfLoop: node.selfLoop === true,
      actionTypes: (node.actions ?? []).map((action) => action.type),
    })),
    edges: config.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      type: edge.type,
      ...(edge.type === "EdgeWhen"
        ? { when: summarizeWhen(edge.params) ?? "" }
        : {}),
    })),
  };
}

/** Same mode → identical structure; cache the serialized view per mode. */
const viewCache = new Map<OrchestratorMode, FsmGraphView>();

export function fsmGraphViewForMode(mode: OrchestratorMode): FsmGraphView {
  const cached = viewCache.get(mode);
  if (cached) return cached;

  const config = graphConfigForMode(mode);
  const view: FsmGraphView = {
    mode,
    entryNodeId: config.entryNodeId,
    terminalNodeId: config.terminalNodeId ?? "end",
    nodes: config.nodes.map((node) => ({
      id: node.id,
      ...(node.name !== undefined ? { name: node.name } : {}),
      selfLoop: node.selfLoop === true,
      actionTypes: (node.actions ?? []).map((action) => action.type),
    })),
    edges: config.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      type: edge.type,
      ...(edge.type === "EdgeWhen"
        ? { when: summarizeWhen(edge.params) ?? "" }
        : {}),
    })),
  };
  viewCache.set(mode, view);
  return view;
}

/** Parse an IPC `fsm:graphConfig` mode argument; null for unknown values. */
export function parseFsmGraphMode(raw: unknown): OrchestratorMode | null {
  return raw === "react" || raw === "ask" || raw === "plan_execute" ||
    raw === "subagent"
    ? raw
    : null;
}
