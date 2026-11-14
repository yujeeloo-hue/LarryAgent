import type { SessionPlan } from "../../../session/types.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { NodeActionStubBase } from "./NodeActionStubBase.js";
import { scopeOf } from "./hostBridge.js";

export const NodeActionApplyToolEffectsSchema: FsmParamsSchema = {
  type: "object",
  title: "Apply tool effects",
  description:
    "Sync plan card visibility and scrape block_reason from tool results. Plan/doc persist happens in runTools.",
  "x-llmDescription": "Post-tools housekeeping after RunTools: scrape block_reason markers from tool results and re-sync plan-card visibility. No params; mount after RunTools.",
  details: `Post-tools housekeeping after runTools has already applied session patches. Scans the last tool message for a "block_reason:" marker into turnState.lastBlockReason and re-syncs session.plan.cardVisible to the turn's planCardVisible flag when SetPlanCard toggled it.

Routing is not its job — Run tools enqueues tool routeEvent patches; Emit route event flushes them; Check plan may add plan-state events. Plan/doc persist is handled inline by runTools via handler sessionPatch payloads.`,
  additionalProperties: false,
  properties: {},
};

function lastBlockReasonFromHost(host: {
  session: {
    messages: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  };
}): string | undefined {
  const messages = host.session.messages;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]!;
    if (msg.role !== "tool") continue;
    for (const part of msg.parts) {
      if (part.type !== "tool_result") continue;
      const content = part.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (
          c &&
          typeof c === "object" &&
          (c as { type?: string }).type === "text" &&
          typeof (c as { text?: string }).text === "string" &&
          (c as { text: string }).text.includes("block_reason:")
        ) {
          const m = /block_reason:(.+)$/m.exec((c as { text: string }).text);
          if (m) return m[1]!.trim();
        }
      }
    }
    break;
  }
  return undefined;
}

/**
 * Post-tool housekeeping only (card visibility, block_reason scrape).
 * Session plan/doc patches are applied inside runTools.
 */
export class NodeActionApplyToolEffects extends NodeActionStubBase {
  readonly type = "NodeActionApplyToolEffects";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const host = args.host;
    if (!host) {
      return { status: "continue" };
    }

    const reason = lastBlockReasonFromHost(host);
    if (reason) {
      scopeOf(args.turnContext).turnState.lastBlockReason = reason;
    }

    const visible = args.turnContext.planCardVisible;
    const plan = host.session.plan as SessionPlan | null | undefined;
    if (plan && typeof visible === "boolean" && plan.cardVisible !== visible) {
      host.applySessionPatch({ plan: { ...plan, cardVisible: visible } });
    }

    return { status: "continue" };
  }
}
