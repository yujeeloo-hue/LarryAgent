import { haltFromTurnResult } from "../FsmHostCapabilities.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { NodeActionStubBase } from "./NodeActionStubBase.js";
import { titledEmptySchema } from "./schemaHelpers.js";

export const NodeActionFinishIdleSchema = titledEmptySchema(
  "Finish idle",
  "End the turn successfully: session status idle, done reason completed.",
  `Terminal success node. Calls host.finish('idle', '', 'completed'), then reads host.getCounters and records finishedIdle / finishedStatus / modelIterations plus a haltResult-shaped summary on turnContext for diagnostics. No other session mutations.`,
  "Terminal success closer for the End node: ends the turn as idle with done reason completed. No params.",
);

export class NodeActionFinishIdle extends NodeActionStubBase {
  readonly type = "NodeActionFinishIdle";

  async Exec(args: NodeActionExecArgs): Promise<NodeActionExecResult> {
    const host = args.host;
    if (!host) {
      return {
        status: "continue",
        turnContextPatch: { finishedIdle: true },
      };
    }

    const result = await host.finish("idle", "", "completed");
    if (result.status !== "idle") {
      return haltFromTurnResult(result, "Finish idle failed");
    }
    const counters = host.getCounters();
    return {
      status: "continue",
      turnContextPatch: {
        finishedIdle: true,
        finishedStatus: "idle",
        modelIterations: counters.modelIterations,
        haltResult: {
          status: "idle" as const,
          modelIterations: counters.modelIterations,
        },
      },
    };
  }
}
