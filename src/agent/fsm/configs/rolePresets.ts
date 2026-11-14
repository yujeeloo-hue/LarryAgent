import {
  getDefaultAgentSystemPrompt,
  getDefaultAnalyserSystemPrompt,
  getDefaultExecutorSystemPrompt,
  getDefaultPlannerSystemPrompt,
  getDefaultPlanReviewerSystemPrompt,
  getDefaultPlanWriterSystemPrompt,
  getDefaultReplannerSystemPrompt,
  getDefaultSubagentSystemPrompt,
} from "../../../settings/promptDefaults.js";
import type { NodeActionConfig } from "../types.js";

/** Prompt sources are selected explicitly, independently of role identity. */
export const PROMPT_PRESETS: Readonly<Record<string, () => string>> = {
  agent: getDefaultAgentSystemPrompt,
  analyser: getDefaultAnalyserSystemPrompt,
  planner: getDefaultPlannerSystemPrompt,
  plan_writer: getDefaultPlanWriterSystemPrompt,
  plan_reviewer: getDefaultPlanReviewerSystemPrompt,
  executor: getDefaultExecutorSystemPrompt,
  replanner: getDefaultReplannerSystemPrompt,
  subagent: getDefaultSubagentSystemPrompt,
};

const ROLE_PRESETS: Readonly<Record<string, Record<string, unknown>>> = {
  agent: {
    personaLabel: "AGENT", modelBinding: "agent", promptPlacement: "persona",
    waitingMessage: "Waiting for model…",
  },
  analyser: {
    personaLabel: "ANALYSER", modelBinding: "agent", promptPlacement: "system",
    waitingMessage: "Analysing context…",
  },
  planner: {
    personaLabel: "PLANNER", modelBinding: "planner", promptPlacement: "system",
    waitingMessage: "Planning…",
  },
  plan_writer: {
    personaLabel: "PLAN_WRITER", modelBinding: "planWriter", promptPlacement: "system",
    waitingMessage: "Writing plan document…",
  },
  plan_reviewer: {
    personaLabel: "PLAN_REVIEWER", modelBinding: "planWriter", promptPlacement: "system",
    waitingMessage: "Reviewing plan…",
  },
  executor: {
    personaLabel: "EXECUTOR", modelBinding: "executor", promptPlacement: "system",
    waitingMessage: "Executing…",
  },
  replanner: {
    personaLabel: "REPLANNER", modelBinding: "replanner", promptPlacement: "system",
    waitingMessage: "Replanning…",
  },
  subagent: {
    personaLabel: "SUBAGENT", modelBinding: "subagent", promptPlacement: "persona",
    waitingMessage: "Waiting for model…",
  },
};

/** Expand a stock preset into serializable params before the graph runs. */
export function rolePresetParams(
  preset: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const template = preset === "custom" ? "agent" : preset;
  return {
    roleKind: preset,
    personaLabel: "ROLE",
    modelBinding: "sessionDefault",
    promptPlacement: "system",
    waitingMessage: "Waiting for model…",
    ...(Object.hasOwn(ROLE_PRESETS, template) ? ROLE_PRESETS[template] : {}),
    ...(Object.hasOwn(PROMPT_PRESETS, template) ? { promptPreset: template } : {}),
    ...overrides,
  };
}

/** Stock graph wiring; this decision is visible as a separate action. */
export function presetPlanStepAction(
  preset: string,
  waitingMessage?: unknown,
): NodeActionConfig {
  return {
    type: "NodeActionSyncPlanStep",
    params: preset === "executor"
      ? {
          mode: "current",
          ...(typeof waitingMessage !== "string" ? { waitingMessage: "Executing…" } : {}),
        }
      : { mode: "reset" },
  };
}
