import type { OpenAiToolDefinition } from "../../../llm/types.js";
import { reasoningScopeForClient } from "../../../llm/contextScope.js";
import type { RoleIterationSpec } from "../../roles/types.js";
import type { RoleLlmBinding } from "../../roles/types.js";
import { filterModelTools } from "../../policy/filterModelTools.js";
import { asToolNameList } from "../../policy/toolNameLists.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import { haltFromTurnResult } from "../FsmHostCapabilities.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { composeBucket0SystemExtras, composeTrailingOverlay } from "./overlayCompose.js";
import {
  boolParam,
  NodeActionStubBase,
  stringParamPrefer,
} from "./NodeActionStubBase.js";
import { scopeOf } from "./hostBridge.js";

/**
 * Compact + build model-facing messages (+ hard-truncate).
 * Requires tools already prepared (Prepare tools → Disable tools).
 * Runtime type: `NodeActionBuildModelWindow`.
 */
export const NodeActionBuildModelWindowSchema: FsmParamsSchema = {
  type: "object",
  title: "Build model window",
  description:
    "Compact context if needed, then build the model-facing message list (and hard-truncate when over budget). Requires tools[] already prepared.",
  "x-llmDescription": "Build the model-facing message list (compaction, then hard truncation when still over budget). Requires PrepareRole and PrepareTools to have run on this visit; halts otherwise. params: skipCompact, skipHardTruncate, waitingMessage.",
  details: `Builds the model-facing message list for this round. Requires an iterationSpec (halts with 'Missing iteration spec') and reads tools from nodeContext/turnContext — so run after Prepare tools / Disable tools.

Filters a copy of the prepared tools against nodeContext.allowTools and disabledTools, so token estimates use the permitted set while candidates remain available for later policy replacements. Calls host.prepareModelWindow with those tools and the explicit promptPlacement from Prepare role. persona replaces the base persona template (turnInput.agentSystemPrompt has priority); system adds the labeled body to Bucket0; overlay adds it to the wire tail. Role identity does not choose a channel. PromptInject blocks are composed in their configured channels. Compaction and hard truncation run inside the host. Success writes messages, estimatedTokens, compacted and modelWindowReady.`,
  additionalProperties: false,
  properties: {
    waitingMessage: {
      type: "string",
      title: "Waiting message",
      description:
        "Optional status text while preparing the window. Usually set on Prepare role instead.",
      "x-ui": "text",
    },
    skipCompact: {
      type: "boolean",
      default: false,
      title: "Skip compaction",
      description: "Do not run Cold/Warm LLM compaction for this round.",
      "x-ui": "toggle",
    },
    skipHardTruncate: {
      type: "boolean",
      default: false,
      title: "Skip hard-truncate",
      description:
        "Do not hard-truncate the conversation suffix when still over the trigger after compact.",
      "x-ui": "toggle",
    },
  },
};

export class NodeActionBuildModelWindow extends NodeActionStubBase {
  readonly type = "NodeActionBuildModelWindow";

  async Exec(args: NodeActionExecArgs): Promise<NodeActionExecResult> {
    const host = args.host;
    if (!host) {
      return {
        status: "continue",
        nodeContextPatch: {
          modelWindowReady: true,
          messages: [],
          skipCompact: boolParam(this.params, "skipCompact", false),
          skipHardTruncate: boolParam(this.params, "skipHardTruncate", false),
          ...(stringParamPrefer(this.params, "waitingMessage", "progressLabel")
            ? {
                progressLabel: stringParamPrefer(
                  this.params,
                  "waitingMessage",
                  "progressLabel",
                ),
              }
            : {}),
        },
      };
    }

    const spec = args.nodeContext.iterationSpec as RoleIterationSpec | undefined;
    if (!spec) {
      const result = await host.finish(
        "error",
        "Missing iteration spec",
        "error",
      );
      return haltFromTurnResult(result, "Missing iteration spec");
    }

    const toolsRaw =
      args.nodeContext.tools ?? args.turnContext.tools;
    const tools = filterModelTools(
      Array.isArray(toolsRaw) ? (toolsRaw as OpenAiToolDefinition[]) : [],
      {
        allowTools: asToolNameList(args.nodeContext.allowTools),
        denyTools: asToolNameList(args.nodeContext.disabledTools),
      },
    );

    const progressLabel =
      stringParamPrefer(this.params, "waitingMessage", "progressLabel") ??
      (typeof args.nodeContext.progressLabel === "string"
        ? args.nodeContext.progressLabel
        : typeof args.turnContext.progressLabel === "string"
          ? args.turnContext.progressLabel
          : undefined);

    // Persona placement is explicit; the turn-level template has priority.
    const rolePromptTemplate =
      typeof args.nodeContext.rolePromptTemplate === "string" &&
      args.nodeContext.rolePromptTemplate.trim() &&
      spec.promptPlacement === "persona"
        ? args.nodeContext.rolePromptTemplate
        : undefined;
    const agentTemplateOverride =
      args.turnInput?.agentSystemPrompt ?? rolePromptTemplate;

    const bucket0System = composeBucket0SystemExtras(spec);
    const skipCompact = boolParam(this.params, "skipCompact", false);
    const skipHardTruncate = boolParam(this.params, "skipHardTruncate", false);
    const activeLlm = (args.nodeContext.activeLlm as RoleLlmBinding | undefined)
      ?? (args.turnContext.turnScope ? scopeOf(args.turnContext).llmBundle.sessionDefault : undefined);
    const hostedTools = activeLlm
      ? filterModelTools(activeLlm.hostedTools(), {
          allowTools: asToolNameList(args.nodeContext.allowTools),
          denyTools: asToolNameList(args.nodeContext.disabledTools),
        })
      : [];
    const window = await host.prepareModelWindow({
      tools,
      ...(activeLlm ? { reasoningScope: reasoningScopeForClient(activeLlm.client) } : {}),
      ...(hostedTools.length ? { hostedTools } : {}),
      trailingOverlay: composeTrailingOverlay(spec),
      skipCompact,
      skipHardTruncate,
      ...(bucket0System ? { roleSystemPrompt: bucket0System } : {}),
      ...(agentTemplateOverride
        ? { agentTemplateOverride }
        : {}),
      ...(spec.promptPlacement === "persona" ? { personaLabel: spec.personaLabel } : {}),
      ...(progressLabel ? { progressLabel } : {}),
    });

    if (!window.ok) {
      return haltFromTurnResult(window.result);
    }

    return {
      status: "continue",
      nodeContextPatch: {
        modelWindowReady: true,
        messages: window.messages,
        modelWindowReasoningScope: window.reasoningScope,
        estimatedTokens: window.estimatedTokens,
        compacted: window.compacted,
        skipCompact: boolParam(this.params, "skipCompact", false),
        skipHardTruncate: boolParam(this.params, "skipHardTruncate", false),
        ...(progressLabel ? { progressLabel } : {}),
      },
    };
  }
}
