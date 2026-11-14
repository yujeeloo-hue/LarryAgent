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
  /** Custom template from settings; empty / omit → default. */
  template?: string;
};

export type LabeledPromptInput = {
  /** Custom template; empty / omit → default for that persona. */
  template?: string;
};

function workspacePathLabel(workspacePath: string): string {
  const root = workspacePath.trim();
  return root
    ? displayPath(root)
    : "(not set for this session)";
}

/**
 * Substitute {@link WORKSPACE_PATH_PLACEHOLDER}. If the template omits it,
 * append a workspace root line so the model still sees the path.
 */
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

/** Wrap a persona body with a stable `[LABEL]` marker for prefix hashing. */
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

/** Ephemeral IDENTITY.md for every model iteration (not persisted). */
export function buildIdentitySystemPrompt(
  input?: LabeledPromptInput,
): string {
  const raw = resolveTemplate(input?.template, getDefaultIdentityPrompt);
  return wrapPersonaPrompt("IDENTITY", clampSystemPrompt(raw));
}

/** Ephemeral SOUL.md for every model iteration (not persisted). */
export function buildSoulSystemPrompt(input?: LabeledPromptInput): string {
  const raw = resolveTemplate(input?.template, getDefaultSoulPrompt);
  return wrapPersonaPrompt("SOUL", clampSystemPrompt(raw));
}

/**
 * Ephemeral USER.md body. Prefer a non-empty user-memory profile;
 * otherwise use the markdown default.
 */
export function buildUserSystemPrompt(input?: LabeledPromptInput): string {
  const raw = resolveTemplate(input?.template, getDefaultUserPrompt);
  return wrapPersonaPrompt("USER", clampSystemPrompt(raw));
}

/**
 * Ephemeral PROJECT.md body. Prefer a non-empty workspace PROJECT.md;
 * otherwise use the markdown default.
 */
export function buildProjectSystemPrompt(input?: LabeledPromptInput): string {
  const raw = resolveTemplate(input?.template, getDefaultProjectPrompt);
  return wrapPersonaPrompt("PROJECT", clampSystemPrompt(raw));
}

/**
 * Role prompt for AGENT / PLANNER / EXECUTOR / REPLANNER / SUBAGENT.
 * Bucket0 always uses AGENT (parent) or SUBAGENT (child). Plan-role bodies
 * (`planner` / `executor` / …) are an extra system message after that slot.
 */
export function buildRoleSystemPrompt(input: {
  role: RoleKind;
  personaLabel?: string;
  workspacePath: string;
  /** Override template body. */
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
