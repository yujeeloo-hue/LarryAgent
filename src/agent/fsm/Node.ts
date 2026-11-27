import type { RunAgentTurnInput } from "../types.js";
import type { FsmHostCapabilities } from "./FsmHostCapabilities.js";
import { walkNodeActions, type NodeActionBase } from "./NodeActionBase.js";
import type { NodeContext, NodeRunResult, TurnContext } from "./types.js";

export type NodeOptions = {
  id: string;
  name?: string;
  actions?: NodeActionBase[];
  selfLoop?: boolean;
};

export type NodeRunDeps = {
  host?: FsmHostCapabilities;
  turnInput?: RunAgentTurnInput;
};

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

  private declaredRouteEvents(): string[] {
    const events = new Set<string>();
    for (const action of walkNodeActions(this.actions)) {
      for (const event of action.declaredRouteEvents?.() ?? []) {
        if (event) events.add(event);
      }
    }
    return [...events];
  }

  async run(
    turnContext: TurnContext,
    nodeContext: NodeContext = {},
    deps: NodeRunDeps = {},
  ): Promise<NodeRunResult> {
    let actionsExecuted = 0;
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
