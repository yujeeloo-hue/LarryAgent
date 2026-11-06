import type { RunAgentTurnInput } from "../types.js";
import type { FsmHostCapabilities } from "./FsmHostCapabilities.js";
import { walkNodeActions, type NodeActionBase } from "./NodeActionBase.js";
import type { NodeContext, NodeRunResult, TurnContext } from "./types.js";

export type NodeOptions = {
  id: string;
  /** Display / role label; defaults to `id`. */
  name?: string;
  actions?: NodeActionBase[];
  /** Zero-match routing fallback stays on this node (default false). */
  selfLoop?: boolean;
};

export type NodeRunDeps = {
  host?: FsmHostCapabilities;
  turnInput?: RunAgentTurnInput;
};

/**
 * FSMGraph Node (Role slot).
 * Owns an ordered list of NodeActionBase; runs them via injected Exec args.
 */
export class Node {
  readonly id: string;
  readonly name: string;
  readonly selfLoop: boolean;
  private readonly actions: NodeActionBase[];

  constructor(options: NodeOptions) {
    this.id = options.id;
    this.name = options.name ?? options.id;
    this.selfLoop = options.selfLoop === true;
    this.actions = options.actions ? [...options.actions] : [];
  }

  addAction(action: NodeActionBase): this {
    this.actions.push(action);
    return this;
  }

  getActions(): readonly NodeActionBase[] {
    return this.actions;
  }

  /** Union of the route events this node's routing Actions bind. */
  private declaredRouteEvents(): string[] {
    const events = new Set<string>();
    for (const action of walkNodeActions(this.actions)) {
      for (const event of action.declaredRouteEvents?.() ?? []) {
        if (event) events.add(event);
      }
    }
    return [...events];
  }

  /**
   * Run configured Actions in order.
   * Merges turnContextPatch / nodeContextPatch; stops early on `halt`.
   */
  async run(
    turnContext: TurnContext,
    nodeContext: NodeContext = {},
    deps: NodeRunDeps = {},
  ): Promise<NodeRunResult> {
    let actionsExecuted = 0;
    // Seeded before the round so RunTools can hand `fsm_route` the routes this
    // node can actually take (RouteTo runs last, after the tool).
    const boundRouteEvents = this.declaredRouteEvents();
    if (boundRouteEvents.length > 0) {
      nodeContext.boundRouteEvents = boundRouteEvents;
    }
    for (const action of this.actions) {
      const result = await action.Exec({
        turnContext,
        nodeContext,
        nodeId: this.id,
        ...(deps.host ? { host: deps.host } : {}),
        ...(deps.turnInput ? { turnInput: deps.turnInput } : {}),
      });
      actionsExecuted += 1;
      if (result.turnContextPatch) {
        Object.assign(turnContext, result.turnContextPatch);
      }
      if (result.nodeContextPatch) {
        Object.assign(nodeContext, result.nodeContextPatch);
      }
      if (result.status === "halt") {
        const out: NodeRunResult = {
          status: "halt",
          turnContext,
          nodeContext,
          actionsExecuted,
        };
        if (result.errorMessage !== undefined) {
          out.errorMessage = result.errorMessage;
        }
        return out;
      }
    }
    return {
      status: "continue",
      turnContext,
      nodeContext,
      actionsExecuted,
    };
  }
}
