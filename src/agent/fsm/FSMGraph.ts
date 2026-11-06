import type { RunAgentTurnInput } from "../types.js";
import type { StreamFsmNodeEvent } from "../../llm/streamEvents.js";
import { getSessionPhase } from "../../session/sessionPhase.js";
import type { EdgeBase } from "./EdgeBase.js";
import type { FsmHostCapabilities } from "./FsmHostCapabilities.js";
import { Node } from "./Node.js";
import { resolveRegistry, defaultEdgeId, type FSMRegistries } from "./FSMRegistry.js";
import type { FSMRegistry } from "./FSMRegistry.js";
import type {
  FSMGraphConfig,
  FSMGraphRunResult,
  NodeContext,
  TurnContext,
} from "./types.js";
import { validateFSMGraphConfig } from "./validateFSMGraphConfig.js";

const DEFAULT_MAX_TRANSITIONS = 10_000;

export type FSMGraphRunOptions = {
  /**
   * Extra Action/Edge factories, or a full {@link FSMRegistry}
   * (cloned on top of defaults when a Partial map is passed).
   */
  registries?: Partial<FSMRegistries> | FSMRegistry;
  /** Safety cap on Node→Node transitions (not counting the entry visit). */
  maxTransitions?: number;
  /** Step 4: real TurnHost (or mock). Omitted → stub Action path. */
  host?: FsmHostCapabilities;
  /** Required with host for StartTurn. */
  turnInput?: RunAgentTurnInput;
};

/**
 * Hydrated finite-state topology. Prefer FSMGraph.run(config, turnContext).
 */
export class FSMGraph {
  readonly entryNodeId: string;
  readonly terminalNodeId: string;
  private readonly nodes: Map<string, Node>;
  private readonly edgesByFrom: Map<string, EdgeBase[]>;

  private constructor(options: {
    entryNodeId: string;
    terminalNodeId: string;
    nodes: Map<string, Node>;
    edgesByFrom: Map<string, EdgeBase[]>;
  }) {
    this.entryNodeId = options.entryNodeId;
    this.terminalNodeId = options.terminalNodeId;
    this.nodes = options.nodes;
    this.edgesByFrom = options.edgesByFrom;
  }

  getNode(id: string): Node | undefined {
    return this.nodes.get(id);
  }

  getOutgoing(fromNodeId: string): readonly EdgeBase[] {
    return this.edgesByFrom.get(fromNodeId) ?? [];
  }

  /**
   * Primary API: validate + hydrate config, then execute.
   */
  static async run(
    config: FSMGraphConfig,
    turnContext: TurnContext = {},
    options: FSMGraphRunOptions = {},
  ): Promise<FSMGraphRunResult> {
    const graph = FSMGraph.fromConfig(config, options.registries);
    return graph.execute(turnContext, {
      ...(options.maxTransitions !== undefined
        ? { maxTransitions: options.maxTransitions }
        : {}),
      ...(options.host ? { host: options.host } : {}),
      ...(options.turnInput ? { turnInput: options.turnInput } : {}),
    });
  }

  static fromConfig(
    config: FSMGraphConfig,
    registries?: Partial<FSMRegistries> | FSMRegistry,
  ): FSMGraph {
    const registry = resolveRegistry(registries);
    const { entryNodeId, terminalNodeId, preparedActionsByNode } =
      validateFSMGraphConfig(config, registry);

    const nodes = new Map<string, Node>();
    for (const nodeCfg of config.nodes) {
      const id = nodeCfg.id.trim();
      const actions = (preparedActionsByNode.get(id) ?? []).map(
        (action) => action.create(),
      );
      const nodeOptions: {
        id: string;
        name?: string;
        actions: typeof actions;
        selfLoop: boolean;
      } = { id, actions, selfLoop: nodeCfg.selfLoop === true };
      if (nodeCfg.name !== undefined) {
        nodeOptions.name = nodeCfg.name;
      }
      nodes.set(id, new Node(nodeOptions));
    }

    const edgesByFrom = new Map<string, EdgeBase[]>();
    config.edges.forEach((edgeCfg, index) => {
      const from = edgeCfg.from.trim();
      const to = edgeCfg.to.trim();
      const edge = registry.createEdge({
        type: edgeCfg.type,
        id: defaultEdgeId(edgeCfg, index),
        fromNodeId: from,
        toNodeId: to,
        ...(edgeCfg.params
          ? { params: edgeCfg.params as Record<string, unknown> }
          : {}),
      });
      const list = edgesByFrom.get(from) ?? [];
      list.push(edge);
      edgesByFrom.set(from, list);
    });

    return new FSMGraph({
      entryNodeId,
      terminalNodeId,
      nodes,
      edgesByFrom,
    });
  }

  async execute(
    turnContext: TurnContext,
    options: {
      maxTransitions?: number;
      host?: FsmHostCapabilities;
      turnInput?: RunAgentTurnInput;
    } = {},
  ): Promise<FSMGraphRunResult> {
    const maxTransitions = options.maxTransitions ?? DEFAULT_MAX_TRANSITIONS;
    const nodeDeps = {
      ...(options.host ? { host: options.host } : {}),
      ...(options.turnInput ? { turnInput: options.turnInput } : {}),
    };
    // DevTools FSM Graph tab telemetry. Subagent FSMs ride their own
    // channel — emitting here would cross-wire the parent session tab.
    const emitNode = (event: StreamFsmNodeEvent): void => {
      if (options.host?.isSubagentTurn) return;
      options.host?.onEvent?.(event);
    };

    let currentNodeId = this.entryNodeId;
    const nodesVisited: string[] = [];
    let transitions = 0;
    let enteredVia: { from: string; to: string } | undefined;

    for (;;) {
      const node = this.nodes.get(currentNodeId);
      if (!node) {
        return {
          reason: "error",
          turnContext,
          currentNodeId,
          errorMessage: `Missing node "${currentNodeId}"`,
          nodesVisited,
        };
      }

      nodesVisited.push(currentNodeId);
      emitNode({
        type: "fsm_node",
        nodeId: currentNodeId,
        phase: "enter",
        ...(enteredVia ? { transition: enteredVia } : {}),
      });
      const nodeContext: NodeContext = {};
      const nodeResult = await node.run(turnContext, nodeContext, nodeDeps);

      if (nodeResult.status === "halt") {
        const out: FSMGraphRunResult = {
          reason: "halt",
          turnContext,
          currentNodeId,
          nodesVisited,
        };
        if (nodeResult.errorMessage !== undefined) {
          out.errorMessage = nodeResult.errorMessage;
        }
        return out;
      }

      if (currentNodeId === this.terminalNodeId) {
        return {
          reason: "end_node",
          turnContext,
          currentNodeId,
          nodesVisited,
        };
      }

      const outgoing = this.edgesByFrom.get(currentNodeId) ?? [];
      if (outgoing.length === 0 && !node.selfLoop) {
        return {
          reason: "error",
          turnContext,
          currentNodeId,
          errorMessage: `Node "${currentNodeId}" has no outgoing edges and is not terminal "${this.terminalNodeId}"`,
          nodesVisited,
        };
      }

      const matched: EdgeBase[] = [];
      const session =
        nodeDeps.host?.session != null
          ? {
              phase: getSessionPhase(nodeDeps.host.session),
              plan: nodeDeps.host.session.plan ?? null,
            }
          : undefined;
      for (const edge of outgoing) {
        const ok = edge.Eval({
          edgeId: edge.id,
          fromNodeId: edge.fromNodeId,
          toNodeId: edge.toNodeId,
          turnContext,
          nodeContext,
          ...(session ? { session } : {}),
        });
        if (ok) {
          matched.push(edge);
        }
      }

      if (matched.length > 1) {
        return {
          reason: "error",
          turnContext,
          currentNodeId,
          errorMessage: `Node "${currentNodeId}" expected exactly 1 matching outgoing edge, got ${matched.length}`,
          nodesVisited,
        };
      }

      const next = matched[0];
      if (next === undefined && !node.selfLoop) {
        return {
          reason: "error",
          turnContext,
          currentNodeId,
          errorMessage: `Node "${currentNodeId}" expected exactly 1 matching outgoing edge, got 0`,
          nodesVisited,
        };
      }

      // Zero matched + selfLoop → default self-loop: stay on this node and
      // re-run its Actions (nodeContext rebuilt per visit). Counted as a
      // transition so maxTransitions still bounds runaway loops — identical
      // accounting to the explicit from===to edges this flag replaces.
      const nextNodeId = next !== undefined ? next.toNodeId : currentNodeId;
      enteredVia = { from: currentNodeId, to: nextNodeId };

      transitions += 1;
      if (transitions > maxTransitions) {
        return {
          reason: "error",
          turnContext,
          currentNodeId,
          errorMessage: `Exceeded maxTransitions (${maxTransitions})`,
          nodesVisited,
        };
      }

      currentNodeId = nextNodeId;
    }
  }
}
