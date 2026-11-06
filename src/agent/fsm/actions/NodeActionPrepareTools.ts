import type { OpenAiToolDefinition } from "../../../llm/types.js";
import {
  asToolNameList,
  composeToolPredicate,
} from "../../policy/toolNameLists.js";
import { subagentToolPredicate } from "../../subagents/toolFilter.js";
import type { SubagentRole } from "../../subagents/types.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { boolParam, NodeActionStubBase, stringParam } from "./NodeActionStubBase.js";

/**
 * Assemble this iteration's tools[] via Host.prepareTools (explicit policy / offer).
 * Runs before DisableTools and PrepareModelWindow.
 *
 * Optional `allowTools` is a graph-configured whitelist (exact or `*` globs).
 * Denylist belongs on NodeActionDisableTools — not here.
 * toolPolicy composes with the allowlist independently of role identity.
 */
export const NodeActionPrepareToolsSchema: FsmParamsSchema = {
  type: "object",
  title: "Prepare tools",
  description:
    "Assemble this iteration’s tools[] from an explicit tool policy, offer set and optional allowlist.",
  "x-llmDescription": "Assemble this round's tools[]: toolPolicy none | subagent_general | subagent_explore | subagent_worker, allowTools exact-or-* whitelist, useOfferSet (default true). Writes nodeContext.tools; run before BuildModelWindow.",
  details: `Assembles tools via host.prepareTools. toolPolicy selects a named eager-tool policy; allowTools intersects it using exact names or * globs. useOfferSet is an explicit setting. Neither role identity nor turn type selects this action's policy; Host-level permission boundaries still apply.

Writes nodeContext.tools + toolsReady and carries nodeContext.disabledTools through untouched, so Disable tools can run after this without losing the deny list.`,
  additionalProperties: false,
  properties: {
    useOfferSet: {
      type: "boolean",
      default: true,
      title: "Use tool offer set",
      description:
        "Intersect with Hot/offer baseline (parent agent). Mid-turn activation is not used. Turn off for a closed allowTools list that includes tools outside the Hot set (e.g. skill_reflect).",
      "x-ui": "toggle",
    },
    allowTools: {
      type: "array",
      items: { type: "string" },
      default: [],
      title: "Allow tools (whitelist)",
      description:
        "When non-empty, only matching tool names are offered (exact or * globs). Empty = no whitelist filter. Use Disable tools for denylist.",
      "x-ui": "string-list",
    },
    toolPolicy: {
      type: "string",
      enum: ["none", "subagent_general", "subagent_explore", "subagent_worker"],
      default: "none",
      title: "Tool policy",
      description: "Explicit eager-tool policy, independent of role identity and turn type.",
      "x-ui": "select",
    },
  },
};

export class NodeActionPrepareTools extends NodeActionStubBase {
  readonly type = "NodeActionPrepareTools";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const disabled = Array.isArray(args.nodeContext.disabledTools)
      ? (args.nodeContext.disabledTools as string[])
      : [];
    const useOfferSet = boolParam(this.params, "useOfferSet", true);
    const allowTools = asToolNameList(this.params.allowTools);
    const policy = stringParam(this.params, "toolPolicy") ?? "none";
    if (!["none", "subagent_general", "subagent_explore", "subagent_worker"].includes(policy)) {
      return { status: "halt", errorMessage: `Unknown tool policy "${policy}"` };
    }

    const host = args.host;
    if (!host) {
      return {
        status: "continue",
        nodeContextPatch: {
          toolsReady: true,
          tools: [],
          disabledTools: disabled,
          useOfferSet,
          allowTools,
          toolPolicy: policy,
        },
      };
    }

    const policyPredicate = policy === "none"
      ? undefined
      : subagentToolPredicate(policy.slice("subagent_".length) as SubagentRole);
    const toolPredicate = composeToolPredicate(policyPredicate, {
      allowTools,
    });

    const prepared = host.prepareTools({
      ...(toolPredicate ? { toolPredicate } : {}),
      useOfferSet,
    });

    return {
      status: "continue",
      nodeContextPatch: {
        toolsReady: true,
        tools: prepared.tools as OpenAiToolDefinition[],
        disabledTools: disabled,
        useOfferSet,
        allowTools,
        toolPolicy: policy,
      },
    };
  }
}
