import type { OpenAiChatMessage } from "../../llm/types.js";
import type { Session } from "../../session/types.js";
import {
  buildIdentitySystemPrompt,
  buildProjectSystemPrompt,
  buildRoleSystemPrompt,
  buildSoulSystemPrompt,
  buildUserSystemPrompt,
  wrapPersonaPrompt,
} from "../systemPrompt.js";
import { clampSystemPrompt } from "../../settings/promptDefaults.js";
import { categorizeContextMessage } from "../contextMessageCategory.js";
import { buildEnvironmentContextPrompt } from "../environmentContext.js";
import { getUserMemoryCached } from "../../memory/store.js";
import { getProjectMemoryCached } from "../../projectMemory/store.js";
import {
  resolveProjectPrompt,
  resolveUserPrompt,
} from "../../settings/types.js";

export type PersonaSlot = "agent" | "subagent";

export type PersonaOverride = {
  soul: string;
  agent: string;
  memory: { label: string; body: string };
  scenario?: { label: string; body: string };
  lean?: boolean;
};

export type SystemPrefixBuildInput = {
  session: Session;
  personaSlot?: PersonaSlot;
  roleTemplate?: string;
  personaLabel?: string;
  roleSystemPrompt?: string;
  environmentContext?: {
    flags: import("../../settings/types.js").EnvironmentContextFlags;
    workspace: import("../environmentContext.js").EnvironmentWorkspaceSnapshot;
    locale: import("../environmentContext.js").EnvironmentLocaleSnapshot;
  };
  turnHookContext?: string;
  extraSystemPrompt?: string;
  persona?: PersonaOverride;
  skillCatalog?: string;
  knowledgeCatalog?: string;
  collaborative?: string;
};

export function buildSystemPrefix(
  input: SystemPrefixBuildInput,
): OpenAiChatMessage[] {
  const systemPrefix: OpenAiChatMessage[] = [];
  const lean = input.persona?.lean === true;
  if (input.environmentContext) {
    const envPrompt = buildEnvironmentContextPrompt({
      flags: lean ? { ...input.environmentContext.flags, workspace: false } : input.environmentContext.flags,
      workspace: input.environmentContext.workspace,
      locale: input.environmentContext.locale,
    });
    if (envPrompt) {
      systemPrefix.push({ role: "system", content: envPrompt });
    }
  }
  const persona = input.persona;
  if (!persona) {
    systemPrefix.push({
      role: "system",
      content: buildIdentitySystemPrompt(),
    });
  }
  systemPrefix.push({
    role: "system",
    content: buildSoulSystemPrompt(persona ? { template: persona.soul } : undefined),
  });
  systemPrefix.push({
    role: "system",
    content: buildUserSystemPrompt({
      template: resolveUserPrompt(getUserMemoryCached().profile),
    }),
  });

  const workspacePath = input.session.workspacePath?.trim() ?? "";
  if (persona) {
    systemPrefix.push({
      role: "system",
      content: wrapPersonaPrompt(persona.memory.label, clampSystemPrompt(persona.memory.body)),
    });
  } else if (workspacePath) {
    systemPrefix.push({
      role: "system",
      content: buildProjectSystemPrompt({
        template: resolveProjectPrompt(
          getProjectMemoryCached(workspacePath).body,
        ),
      }),
    });
  }

  systemPrefix.push({
    role: "system",
    content: buildRoleSystemPrompt({
      role: input.personaSlot ?? "agent",
      workspacePath: input.session.workspacePath,
      ...(persona ? { template: persona.agent } : input.roleTemplate ? { template: input.roleTemplate } : {}),
      ...(input.personaLabel ? { personaLabel: input.personaLabel } : {}),
    }),
  });

  const skillCatalog = input.skillCatalog?.trim() ?? "";
  if (skillCatalog) {
    systemPrefix.push(categorizeContextMessage({ role: "system", content: skillCatalog }, "skillPrompts"));
  }

  const knowledgeCatalog = input.knowledgeCatalog?.trim() ?? "";
  if (knowledgeCatalog) {
    systemPrefix.push({ role: "system", content: knowledgeCatalog });
  }

  const collaborative = input.collaborative?.trim() ?? "";
  if (collaborative) {
    systemPrefix.push({ role: "system", content: collaborative });
  }

  if (persona?.scenario?.body.trim()) {
    systemPrefix.push({
      role: "system",
      content: wrapPersonaPrompt(persona.scenario.label, clampSystemPrompt(persona.scenario.body)),
    });
  }

  const planRole = input.roleSystemPrompt?.trim() ?? "";
  if (planRole) {
    systemPrefix.push({ role: "system", content: planRole });
  }

  const extras = [input.extraSystemPrompt?.trim()].filter(
    (s): s is string => Boolean(s),
  );
  if (extras.length > 0) {
    systemPrefix.push({ role: "system", content: extras.join("\n\n") });
  }

  if (input.turnHookContext) {
    systemPrefix.push({
      role: "system",
      content: `[Hook context]\n${input.turnHookContext}`,
    });
  }

  return systemPrefix;
}
