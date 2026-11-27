import type { NodeActionExecArgs, NodeActionExecResult } from "./types.js";

export abstract class NodeActionBase {
  abstract readonly type: string;

  abstract Exec(
    args: NodeActionExecArgs,
  ): NodeActionExecResult | Promise<NodeActionExecResult>;

  declaredRouteEvents?(): readonly string[];

  getChildren(): readonly NodeActionBase[] {
    return [];
  }
}

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
