import type {
  RoleIterationSpec,
  RoleLlmBinding,
  RoleLlmBundle,
} from "../../roles/types.js";
import { applyWorkspacePathToPrompt, wrapPersonaPrompt } from "../../systemPrompt.js";
import { clampSystemPrompt } from "../../../settings/promptDefaults.js";
import { PROMPT_PRESETS } from "../configs/rolePresets.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import type { NodeActionExecArgs, NodeActionExecResult } from "../types.js";
import { scopeOf } from "./hostBridge.js";
import { NodeActionStubBase, stringParam } from "./NodeActionStubBase.js";
import { resolvePromptOverride } from "./rolePromptSource.js";

const MODEL_BINDINGS = [
  "sessionDefault", "agent", "planner", "planWriter", "executor", "replanner", "subagent",
] as const;
type ModelBindingKey = (typeof MODEL_BINDINGS)[number];

export const NodeActionPrepareRoleSchema: FsmParamsSchema = {
  type: "object",
  title: "Prepare role",
  description: "Prepare a model round from explicit prompt, identity, model and status settings.",
  "x-llmDescription": "Set this round's prompt, identity and model before anything else on the node: roleKind (required, identity label only), promptPreset or rolePromptInline / rolePromptFile, promptPlacement persona|system|overlay (default system), modelBinding / modelProviderId, waitingMessage.",
  details: `roleKind is an identity label only. It never selects a prompt, model, tool policy or plan behavior. Stock graph presets expand these settings into ordinary params.

Prompt source priority: rolePromptInline > rolePromptFile > promptPreset. promptPlacement selects the base persona, an extra system message, or the trailing overlay. personaLabel labels system/overlay prompt bodies. modelBinding selects an explicit bundle slot; modelProviderId overrides it with a configured provider. Tools belong to Prepare tools; plan-step state belongs to Sync plan step.`,
  additionalProperties: false,
  required: ["roleKind"],
  properties: {
    roleKind: {
      type: "string", minLength: 1, title: "Role identity",
      description: "Identity only; changing it does not change execution policy.",
      "x-ui": "text",
    },
    personaLabel: {
      type: "string", minLength: 1, default: "ROLE", title: "Prompt label",
      "x-ui": "text",
    },
    promptPreset: {
      type: "string", enum: ["none", ...Object.keys(PROMPT_PRESETS)], default: "none",
      title: "Prompt preset", "x-ui": "select",
    },
    rolePromptInline: {
      type: "string", title: "Prompt body",
      description: "Replaces the selected preset or file body.", "x-ui": "textarea",
    },
    rolePromptFile: {
      type: "string", title: "Prompt file (Markdown)", "x-ui": "text",
    },
    promptPlacement: {
      type: "string", enum: ["persona", "system", "overlay"], default: "system",
      title: "Prompt placement", "x-ui": "select",
    },
    modelBinding: {
      type: "string", enum: [...MODEL_BINDINGS], default: "sessionDefault",
      title: "Model binding", "x-ui": "select",
    },
    modelProviderId: {
      type: "string", minLength: 1, title: "Provider override",
      description: "Optional configured provider id, overriding the selected binding.",
      "x-ui": "text",
    },
    waitingMessage: {
      type: "string", default: "Waiting for model…", title: "Waiting message",
      "x-ui": "text",
    },
    requirePlanDocForCreatePlan: {
      type: "boolean", default: false, title: "Require plan doc for create_plan",
      "x-ui": "toggle",
    },
    requirePlanDocApprovalForCreatePlan: {
      type: "boolean",
      default: false,
      description: "Require approval of the current document revision before creating an execution checklist.",
    },
    includeSkills: {
      type: "boolean", default: false, title: "Include skills catalog",
      description: "Legacy flag; skills are discovered via search_skills → read_skill.",
      "x-ui": "hidden",
    },
  },
};

function configuredModel(
  bundle: RoleLlmBundle,
  params: Record<string, unknown>,
): RoleLlmBinding | undefined {
  const providerId = stringParam(params, "modelProviderId");
  if (providerId) {
    return Object.hasOwn(bundle.byProviderId, providerId)
      ? bundle.byProviderId[providerId]
      : undefined;
  }
  const slot = stringParam(params, "modelBinding", "sessionDefault") as ModelBindingKey;
  return (MODEL_BINDINGS as readonly string[]).includes(slot) ? bundle[slot] : undefined;
}

export class NodeActionPrepareRole extends NodeActionStubBase {
  readonly type = "NodeActionPrepareRole";

  async Exec(args: NodeActionExecArgs): Promise<NodeActionExecResult> {
    const roleKind = stringParam(this.params, "roleKind");
    if (!roleKind?.trim()) {
      return { status: "halt", errorMessage: "PrepareRole requires roleKind" };
    }
    const host = args.host;
    let body: string;
    try {
      body = (await resolvePromptOverride(this.params, host?.session.workspacePath)) ?? "";
      if (!body) {
        const preset = stringParam(this.params, "promptPreset") ?? "none";
        if (preset !== "none") {
          const source = Object.hasOwn(PROMPT_PRESETS, preset) ? PROMPT_PRESETS[preset] : undefined;
          if (!source) {
            return { status: "halt", errorMessage: `Unknown prompt preset "${preset}"` };
          }
          body = source();
        }
      }
    } catch (error) {
      if (host) throw error;
      return {
        status: "halt",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
    const placement = stringParam(this.params, "promptPlacement", "system");
    if (placement !== "persona" && placement !== "system" && placement !== "overlay") {
      return { status: "halt", errorMessage: "Invalid promptPlacement" };
    }
    const personaLabel = stringParam(this.params, "personaLabel") ?? "ROLE";
    const iterationSpec: RoleIterationSpec = {
      roleKind,
      personaLabel,
      promptPlacement: placement,
      roleSystemPrompt: body.trim()
        ? wrapPersonaPrompt(personaLabel, applyWorkspacePathToPrompt(
            clampSystemPrompt(body), host?.session.workspacePath ?? "",
          ))
        : "",
      includeSkills: this.params.includeSkills === true,
    };
    let activeLlm: RoleLlmBinding | undefined;
    if (host) {
      const scope = scopeOf(args.turnContext);
      activeLlm = configuredModel(scope.llmBundle, this.params);
      if (!activeLlm) {
        return { status: "halt", errorMessage: "PrepareRole model binding is unavailable" };
      }
      scope.turnState.activeRole = roleKind;
    }
    const progressLabel = stringParam(this.params, "waitingMessage", "Waiting for model…");
    if (progressLabel) host?.emitProgress?.(progressLabel);
    return {
      status: "continue",
      ...(this.params.requirePlanDocForCreatePlan === true || this.params.requirePlanDocApprovalForCreatePlan === true
        ? { turnContextPatch: {
            ...(this.params.requirePlanDocForCreatePlan === true ? { requirePlanDocForCreatePlan: true } : {}),
            ...(this.params.requirePlanDocApprovalForCreatePlan === true ? { requirePlanDocApprovalForCreatePlan: true } : {}),
          } }
        : {}),
      nodeContextPatch: {
        roleKind,
        activeRole: roleKind,
        includeSkills: iterationSpec.includeSkills,
        rolePromptTemplate: placement === "persona" && body.trim() ? body : undefined,
        iterationSpec,
        ...(activeLlm ? { activeLlm } : {}),
        progressLabel,
        iterationSpecReady: true,
      },
    };
  }
}
