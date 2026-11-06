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
import { buildEnvironmentContextPrompt } from "../environmentContext.js";
import { getUserMemoryCached } from "../../memory/store.js";
import { getProjectMemoryCached } from "../../projectMemory/store.js";
import {
  resolveProjectPrompt,
  resolveUserPrompt,
} from "../../settings/types.js";

export type PersonaSlot = "agent" | "subagent";

/**
 * Full persona replacement for a dedicated agent (CoCo commander): drops the
 * shared IDENTITY, swaps SOUL and AGENT bodies, and puts `memory` where
 * PROJECT would go. USER stays.
 */
export type PersonaOverride = {
  soul: string;
  agent: string;
  memory: { label: string; body: string };
  /** Extra block right after AGENT (CoCo autonomous wake → `[AUTONOMOUS]`). */
  scenario?: { label: string; body: string };
  /** Drop the Environment workspace lines and the `[Turn handoff]` line. */
  lean?: boolean;
};

export type SystemPrefixBuildInput = {
  session: Session;
  /** Bucket0 AGENT.md vs SUBAGENT.md. Default agent. */
  personaSlot?: PersonaSlot;
  /** Optional body override (tests / child turns). */
  roleTemplate?: string;
  /** Explicit label for the base persona body; independent of role identity. */
  personaLabel?: string;
  /**
   * Caller-selected prompt blocks after the base persona slot.
   */
  roleSystemPrompt?: string;
  environmentContext?: {
    flags: import("../../settings/types.js").EnvironmentContextFlags;
    workspace: import("../environmentContext.js").EnvironmentWorkspaceSnapshot;
    locale: import("../environmentContext.js").EnvironmentLocaleSnapshot;
  };
  turnHookContext?: string;
  extraSystemPrompt?: string;
  persona?: PersonaOverride;
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

  // Per-turn turn_handoff availability declaration (plan
  // docs/plans/20260829-turn-handoff-tool.md item 8): shared prefix, so it
  // shows up identically in every run mode. Session gate: null/false = off.
  if (!lean) systemPrefix.push({
    role: "system",
    content:
      input.session.handoffEnabled === true
        ? "[Turn handoff]\nturn_handoff is available for this session: queue the next turn on an enabled FSM graph with a self-authored prompt; it starts automatically after this turn completes."
        : "[Turn handoff]\nturn_handoff is disabled for this session — calls will fail with handoff_disabled. The user can enable it in the composer Self Learning section.",
  });

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
