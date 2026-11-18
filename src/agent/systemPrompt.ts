import { displayPath } from "../tools/pathUtil.js";
import {
  WORKSPACE_PATH_PLACEHOLDER,
  clampSystemPrompt,
  getDefaultAgentSystemPrompt,
  getDefaultExecutorSystemPrompt,
  getDefaultIdentityPrompt,
  getDefaultAnalyserSystemPrompt,
  getDefaultPlannerSystemPrompt,
  getDefaultPlanWriterSystemPrompt,
  getDefaultPlanReviewerSystemPrompt,
  getDefaultReplannerSystemPrompt,
  getDefaultProjectPrompt,
  getDefaultSoulPrompt,
  getDefaultSubagentSystemPrompt,
  getDefaultUserPrompt,
} from "../settings/promptDefaults.js";
import type { RoleKind } from "./roles/types.js";

export type PersonaLabel =
  | "IDENTITY"
  | "SOUL"
  | "USER"
  | "PROJECT"
  | "AGENT"
  | "ANALYSER"
  | "PLANNER"
  | "PLAN_WRITER"
  | "PLAN_REVIEWER"
  | "EXECUTOR"
  | "REPLANNER"
  | "SUBAGENT";

export type BaseAgentSystemPromptInput = {
  workspacePath: string;
  template?: string;
};

export type LabeledPromptInput = {
  template?: string;
};

function workspacePathLabel(workspacePath: string): string {
  const root = workspacePath.trim();
  return root
    ? displayPath(root)
    : "(not set for this session)";
}

export function applyWorkspacePathToPrompt(
  template: string,
  workspacePath: string,
): string {
  const label = workspacePathLabel(workspacePath);
  if (template.includes(WORKSPACE_PATH_PLACEHOLDER)) {
    return template.split(WORKSPACE_PATH_PLACEHOLDER).join(label);
  }
  return `${template.trimEnd()}\n\nWorkspace root (absolute): ${label}`;
}

export function wrapPersonaPrompt(label: string, body: string): string {
  return `[${label}]\n${body}`;
}

function resolveTemplate(
  template: string | undefined,
  fallback: () => string,
): string {
  return typeof template === "string" && template.trim().length > 0
    ? template
    : fallback();
}

function roleToPersonaLabel(role: RoleKind): PersonaLabel {
  switch (role) {
    case "analyser":
      return "ANALYSER";
    case "planner":
      return "PLANNER";
    case "plan_writer":
      return "PLAN_WRITER";
    case "plan_reviewer":
      return "PLAN_REVIEWER";
    case "executor":
      return "EXECUTOR";
    case "replanner":
      return "REPLANNER";
    case "subagent":
      return "SUBAGENT";
    default:
      return "AGENT";
  }
}

function defaultTemplateForRole(role: RoleKind): () => string {
  switch (role) {
    case "analyser":
      return getDefaultAnalyserSystemPrompt;
    case "planner":
      return getDefaultPlannerSystemPrompt;
    case "plan_writer":
      return getDefaultPlanWriterSystemPrompt;
    case "plan_reviewer":
      return getDefaultPlanReviewerSystemPrompt;
    case "executor":
      return getDefaultExecutorSystemPrompt;
    case "replanner":
      return getDefaultReplannerSystemPrompt;
    case "subagent":
      return getDefaultSubagentSystemPrompt;
    default:
      return getDefaultAgentSystemPrompt;
  }
}

export function buildIdentitySystemPrompt(
  input?: LabeledPromptInput,
): string {
  const raw = resolveTemplate(input?.template, getDefaultIdentityPrompt);
  return wrapPersonaPrompt("IDENTITY", clampSystemPrompt(raw));
}

export function buildSoulSystemPrompt(input?: LabeledPromptInput): string {
  const raw = resolveTemplate(input?.template, getDefaultSoulPrompt);
  return wrapPersonaPrompt("SOUL", clampSystemPrompt(raw));
}

export function buildUserSystemPrompt(input?: LabeledPromptInput): string {
  const raw = resolveTemplate(input?.template, getDefaultUserPrompt);
  return wrapPersonaPrompt("USER", clampSystemPrompt(raw));
}

export function buildProjectSystemPrompt(input?: LabeledPromptInput): string {
  const raw = resolveTemplate(input?.template, getDefaultProjectPrompt);
  return wrapPersonaPrompt("PROJECT", clampSystemPrompt(raw));
}

export function buildRoleSystemPrompt(input: {
  role: RoleKind;
  personaLabel?: string;
  workspacePath: string;
  template?: string;
}): string {
  const label = input.personaLabel ?? roleToPersonaLabel(input.role);
  const raw = resolveTemplate(input.template, defaultTemplateForRole(input.role));
  const body = applyWorkspacePathToPrompt(
    clampSystemPrompt(raw),
    input.workspacePath,
  );
  return wrapPersonaPrompt(label, body);
}
