/**
 * Single-mutation edits for LLM-authored FSM graphs.
 * Validates action/edge params against registry schemas before persist.
 */

import { createDefaultActionRegistry } from "../actions/createDefaultActionRegistry.js";
import { normalizeAndValidateParams } from "../paramsSchema.js";
import type { FSMGraphConfig, FSMGraphEdgeConfig, FSMGraphNodeConfig } from "../types.js";
import { getFsmGraph, saveFsmGraph } from "./manager.js";
import type { FsmGraphLibraryRecord } from "./types.js";

export type FsmGraphEditInput = {
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

export type FsmGraphEditResult =
  | { ok: true; graph: FsmGraphLibraryRecord }
  | { ok: false; error: string; code?: string };

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asParams(
  value: unknown,
): Record<string, unknown> | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return "invalid";
  return value as Record<string, unknown>;
}

function cloneConfig(config: FSMGraphConfig): FSMGraphConfig {
  return structuredClone(config);
}

function findNode(
  nodes: FSMGraphNodeConfig[],
  nodeId: string,
): FSMGraphNodeConfig | undefined {
  return nodes.find((n) => n.id === nodeId);
}

function toError(err: unknown): FsmGraphEditResult {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string"
      ? { ok: false, error: err.message, code }
      : { ok: false, error: err.message };
  }
  return { ok: false, error: String(err) };
}

/**
 * Apply one structural edit to a stored graph, validating params then
 * persisting via saveFsmGraph (full graph validate on write).
 */
export async function applyGraphEdit(
  input: FsmGraphEditInput,
): Promise<FsmGraphEditResult> {
  const id = trimmed(input.id);
  if (!id) return { ok: false, error: "id is required" };
  const action = trimmed(input.action);
  if (!action) return { ok: false, error: "action is required" };

  const existing = await getFsmGraph(id);
  if (!existing) return { ok: false, error: `FSM graph not found: ${id}` };

  const registry = createDefaultActionRegistry();
  const config = cloneConfig(existing.config);

  try {
    switch (action) {
      case "set_meta": {
        const name = trimmed(input.name);
        const description = trimmed(input.description);
        const { description: _prevDesc, ...rest } = existing;
        void _prevDesc;
        const next: FsmGraphLibraryRecord = {
          ...rest,
          ...(name ? { name } : {}),
          ...(description
            ? { description }
            : input.description === ""
              ? {}
              : existing.description
                ? { description: existing.description }
                : {}),
        };
        const saved = await saveFsmGraph(next);
        return { ok: true, graph: saved };
      }

      case "add_node": {
        const nodeId = trimmed(input.nodeId);
        if (!nodeId) return { ok: false, error: "add_node requires nodeId" };
        if (findNode(config.nodes, nodeId)) {
          return { ok: false, error: `node already exists: ${nodeId}` };
        }
        const name = trimmed(input.name);
        const node: FSMGraphNodeConfig = {
          id: nodeId,
          ...(name ? { name } : {}),
          ...(input.selfLoop === true ? { selfLoop: true } : {}),
          actions: [],
        };
        config.nodes.push(node);
        break;
      }

      case "remove_node": {
        const nodeId = trimmed(input.nodeId);
        if (!nodeId) return { ok: false, error: "remove_node requires nodeId" };
        if (nodeId === config.entryNodeId) {
          return { ok: false, error: "cannot remove the entry node" };
        }
        const terminal = config.terminalNodeId ?? "end";
        if (nodeId === terminal) {
          return { ok: false, error: "cannot remove the terminal node" };
        }
        if (!findNode(config.nodes, nodeId)) {
          return { ok: false, error: `node not found: ${nodeId}` };
        }
        config.nodes = config.nodes.filter((n) => n.id !== nodeId);
        config.edges = config.edges.filter(
          (e) => e.from !== nodeId && e.to !== nodeId,
        );
        break;
      }

      case "add_pin": {
        const nodeId = trimmed(input.nodeId);
        const pinName = trimmed(input.pinName);
        if (!nodeId || !pinName) {
          return { ok: false, error: "add_pin requires nodeId and pinName" };
        }
        const node = findNode(config.nodes, nodeId);
        if (!node) return { ok: false, error: `node not found: ${nodeId}` };
        const pins = node.pins ? [...node.pins] : [];
        if (pins.some((p) => p.name === pinName)) {
          return { ok: false, error: `pin already exists: ${pinName}` };
        }
        pins.push({ name: pinName });
        node.pins = pins;
        break;
      }

      case "remove_pin": {
        const nodeId = trimmed(input.nodeId);
        const pinName = trimmed(input.pinName);
        if (!nodeId || !pinName) {
          return { ok: false, error: "remove_pin requires nodeId and pinName" };
        }
        const node = findNode(config.nodes, nodeId);
        if (!node) return { ok: false, error: `node not found: ${nodeId}` };
        const before = node.pins?.length ?? 0;
        node.pins = (node.pins ?? []).filter((p) => p.name !== pinName);
        if ((node.pins?.length ?? 0) === before) {
          return { ok: false, error: `pin not found: ${pinName}` };
        }
        if (node.pins.length === 0) delete node.pins;
        break;
      }

      case "append_action": {
        const nodeId = trimmed(input.nodeId);
        const type = trimmed(input.type);
        if (!nodeId || !type) {
          return {
            ok: false,
            error: "append_action requires nodeId and type",
          };
        }
        const node = findNode(config.nodes, nodeId);
        if (!node) return { ok: false, error: `node not found: ${nodeId}` };
        if (!registry.hasAction(type)) {
          const known = registry.listActionTypes().join(", ");
          return {
            ok: false,
            error: `Unknown NodeAction type "${type}". Known: ${known}. Call fsm_graph describe_action first.`,
            code: "UNKNOWN_ACTION",
          };
        }
        const rawParams = asParams(input.params);
        if (rawParams === "invalid") {
          return { ok: false, error: "params must be a JSON object" };
        }
        const prepared = registry.prepareAction(type, rawParams, `append_action ${type}`);
        const actions = node.actions ? [...node.actions] : [];
        actions.push({ type: prepared.type, params: { ...prepared.params } });
        node.actions = actions;
        break;
      }

      case "remove_action": {
        const nodeId = trimmed(input.nodeId);
        if (!nodeId) return { ok: false, error: "remove_action requires nodeId" };
        const index =
          typeof input.index === "number" && Number.isInteger(input.index)
            ? input.index
            : NaN;
        if (!Number.isInteger(index) || index < 0) {
          return {
            ok: false,
            error: "remove_action requires a non-negative integer index",
          };
        }
        const node = findNode(config.nodes, nodeId);
        if (!node) return { ok: false, error: `node not found: ${nodeId}` };
        const actions = node.actions ? [...node.actions] : [];
        if (index >= actions.length) {
          return {
            ok: false,
            error: `action index ${index} out of range (length ${actions.length})`,
          };
        }
        actions.splice(index, 1);
        node.actions = actions;
        break;
      }

      case "add_edge": {
        const from = trimmed(input.from);
        const to = trimmed(input.to);
        const type = trimmed(input.type);
        if (!from || !to || !type) {
          return {
            ok: false,
            error: "add_edge requires from, to, and type",
          };
        }
        if (!registry.hasEdge(type)) {
          const known = registry.listEdgeTypes().join(", ");
          return {
            ok: false,
            error: `Unknown Edge type "${type}". Known: ${known}. Call fsm_graph describe_edge first.`,
            code: "UNKNOWN_EDGE",
          };
        }
        const rawParams = asParams(input.params);
        if (rawParams === "invalid") {
          return { ok: false, error: "params must be a JSON object" };
        }
        const schema = registry.getEdgeParamsSchema(type);
        const normalized = normalizeAndValidateParams(
          schema,
          rawParams,
          `add_edge ${type}`,
        );
        const edge = {
          from,
          to,
          type,
          params: normalized,
        } as FSMGraphEdgeConfig;
        config.edges.push(edge);
        break;
      }

      case "remove_edge": {
        const from = trimmed(input.from);
        const to = trimmed(input.to);
        if (!from || !to) {
          return { ok: false, error: "remove_edge requires from and to" };
        }
        const matches = config.edges
          .map((e, i) => ({ e, i }))
          .filter(({ e }) => e.from === from && e.to === to);
        if (matches.length === 0) {
          return { ok: false, error: `no edge from ${from} to ${to}` };
        }
        let removeAt = matches[0]!.i;
        if (input.index !== undefined && input.index !== null) {
          const index =
            typeof input.index === "number" && Number.isInteger(input.index)
              ? input.index
              : NaN;
          if (!Number.isInteger(index) || index < 0 || index >= matches.length) {
            return {
              ok: false,
              error: `remove_edge index must be 0..${matches.length - 1} among matching edges`,
            };
          }
          removeAt = matches[index]!.i;
        }
        config.edges = config.edges.filter((_, i) => i !== removeAt);
        break;
      }

      default:
        return {
          ok: false,
          error:
            "action must be one of: set_meta, add_node, remove_node, add_pin, remove_pin, append_action, remove_action, add_edge, remove_edge",
        };
    }

    const saved = await saveFsmGraph({ ...existing, config });
    return { ok: true, graph: saved };
  } catch (err) {
    return toError(err);
  }
}
