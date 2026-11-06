import type { NodeActionExecArgs, NodeActionExecResult } from "./types.js";

/**
 * Base class for every Action hung under a Node.
 * Concrete subclasses must be named `NodeActionXXX` and implement `Exec`.
 *
 * Dependency direction: Node → Action only. Do not reach up into Node / FSMGraph.
 * Topology-blind contract: an Action knows nothing about graph structure —
 * no Node ids, no edge targets, no imports from node-id constants. Routing
 * output is pin names on TurnContext (`routeTarget`); built-in graphs use
 * pin.name === target node id. Only Edges and graph configs may name nodes.
 */
export abstract class NodeActionBase {
  /** Stable type id registered in FSMRegistry (e.g. "NodeActionCallModel"). */
  abstract readonly type: string;

  /** Unified entrypoint. Turn/Node context arrive only through `args`. */
  abstract Exec(
    args: NodeActionExecArgs,
  ): NodeActionExecResult | Promise<NodeActionExecResult>;

  /**
   * Route event names this Action binds, if any (routing Actions only).
   * Node collects them before the round so `fsm_route` can reject a route the
   * node has nowhere to send. Pin names stay internal — this is the event
   * vocabulary, not topology.
   */
  declaredRouteEvents?(): readonly string[];

  /** The same ordered children declared by the registration's describeChildren hook. */
  getChildren(): readonly NodeActionBase[] {
    return [];
  }
}

/** Generic traversal for metadata; shared instances and cycles are visited once. */
export function* walkNodeActions(actions: readonly NodeActionBase[]): IterableIterator<NodeActionBase> {
  const seen = new Set<NodeActionBase>();
  function* walk(list: readonly NodeActionBase[]): IterableIterator<NodeActionBase> {
    for (const action of list) {
      if (seen.has(action)) continue;
      seen.add(action);
      yield action;
      yield* walk(action.getChildren());
    }
  }
  yield* walk(actions);
}
