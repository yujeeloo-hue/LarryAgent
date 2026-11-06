import { FSMConfigError } from "./FSMConfigError.js";
import { NodeActionBase } from "./NodeActionBase.js";
import type { NodeActionExecArgs, NodeActionExecResult } from "./types.js";

/** Ordered composition. Child instances are supplied by the owning registry. */
export abstract class CompositeNodeActionBase extends NodeActionBase {
  private children: readonly NodeActionBase[] | undefined;

  constructor(private readonly childSource: readonly NodeActionBase[] | (() => readonly NodeActionBase[])) {
    super();
  }

  override getChildren(): readonly NodeActionBase[] {
    this.children ??= Object.freeze([...(typeof this.childSource === "function" ? this.childSource() : this.childSource)]);
    return this.children;
  }

  async Exec(args: NodeActionExecArgs): Promise<NodeActionExecResult> {
    let children: readonly NodeActionBase[];
    try {
      children = this.getChildren();
    } catch (error) {
      // Direct constructors keep the ordinary Action halt result for bad configuration.
      if (error instanceof FSMConfigError) return { status: "halt", errorMessage: error.message };
      throw error;
    }
    const turnContext = { ...args.turnContext };
    const nodeContext = { ...args.nodeContext };
    for (const child of children) {
      const result = await child.Exec({ ...args, turnContext, nodeContext });
      if (result.turnContextPatch) Object.assign(turnContext, result.turnContextPatch);
      if (result.nodeContextPatch) Object.assign(nodeContext, result.nodeContextPatch);
      if (result.status === "halt") {
        return { ...result, turnContextPatch: turnContext, nodeContextPatch: nodeContext };
      }
    }
    return { status: "continue", turnContextPatch: turnContext, nodeContextPatch: nodeContext };
  }
}
