import type { FsmParamsSchema } from "../paramsSchema.js";
import { haltFromTurnResult } from "../FsmHostCapabilities.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import {
  boolParamPrefer,
  NodeActionStubBase,
} from "./NodeActionStubBase.js";

export const NodeActionAwaitSubagentsSchema: FsmParamsSchema = {
  type: "object",
  title: "Await subagents",
  description:
    "Drain or wait for parent subagent batches after tools. After a tools round, drain without blocking; on a bare-reply round may wait for incomplete batches.",
  "x-llmDescription": "Parent-side subagent barrier: after a tools round, drain ready batches without blocking; on a bare-reply round optionally block-wait (waitForBatches default true; timeoutMs is diagnostics-only). An injected batch sets the flag RouteTo's stay fallback keeps alive.",
  details: `Parent-side subagent barrier via host.awaitSubagentBatches. After a tools round (toolsRan / pending calls present) it drains ready batches without blocking; on a bare-reply round with waitForBatches it block-waits for the parent's incomplete batches (timeoutMs is recorded for diagnostics only).

'cancelled' halts the turn. 'injected' sets nodeContext.subagentInjected so Route to's stay fallback keeps the round alive for the landed batch. Otherwise records subagentAwaitDone on turnContext and clears the injected flag.`,
  additionalProperties: false,
  properties: {
    waitForBatches: {
      type: "boolean",
      default: true,
      title: "Wait for batches",
      description:
        "When true, block on incomplete batches if this round did not just run tools. When false, only drain what is already ready.",
      "x-ui": "toggle",
    },
    timeoutMs: {
      type: "integer",
      minimum: 0,
      title: "Timeout (ms)",
      description:
        "Optional wait bound (0 = no extra bound beyond Host defaults). Stored for diagnostics.",
      "x-ui": "number",
    },
  },
};

export class NodeActionAwaitSubagents extends NodeActionStubBase {
  readonly type = "NodeActionAwaitSubagents";

  async Exec(args: NodeActionExecArgs): Promise<NodeActionExecResult> {
    const wait = boolParamPrefer(this.params, "waitForBatches", "wait", true);
    const host = args.host;
    if (!host) {
      return {
        status: "continue",
        turnContextPatch: {
          subagentAwaitDone: true,
          ...(typeof this.params.timeoutMs === "number"
            ? { awaitTimeoutMs: this.params.timeoutMs }
            : {}),
        },
        nodeContextPatch: { subagentAwaitDone: true },
      };
    }

    // Round payload is node-scoped: after a tools round (toolsRan) drain
    // without blocking; idle / bare-reply rounds may block-wait for the
    // parent's outstanding subagent batches.
    const waitIfIncomplete =
      wait &&
      args.nodeContext.hasPendingToolCalls !== true &&
      args.nodeContext.toolsRan !== true;

    const sub = await host.awaitSubagentBatches({
      waitIfIncomplete,
    });

    if (sub === "cancelled") {
      const result = await host.finish("cancelled", "Cancelled", "cancelled");
      return haltFromTurnResult(result, "Cancelled");
    }

    if (sub === "injected") {
      return {
        status: "continue",
        turnContextPatch: { subagentAwaitDone: true },
        // Round-scoped rescue flag: Route to (same visit) reads it to keep
        // the round alive when a subagent batch lands after the domain decision.
        nodeContextPatch: { subagentAwaitDone: true, subagentInjected: true },
      };
    }

    return {
      status: "continue",
      turnContextPatch: {
        subagentAwaitDone: true,
        ...(typeof this.params.timeoutMs === "number"
          ? { awaitTimeoutMs: this.params.timeoutMs }
          : {}),
      },
      nodeContextPatch: { subagentInjected: false },
    };
  }
}
