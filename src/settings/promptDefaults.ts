import { readFileSync } from "node:fs";
import { join } from "node:path";

export const WORKSPACE_PATH_PLACEHOLDER = "{{workspacePath}}";

export const MAX_SYSTEM_PROMPT_CHARS = 32_000;

export const IDENTITY_PROMPT_FILENAME = "IDENTITY.md";
export const SOUL_PROMPT_FILENAME = "SOUL.md";
export const USER_PROMPT_FILENAME = "USER.md";
export const PROJECT_PROMPT_FILENAME = "PROJECT.md";
export const AGENT_SYSTEM_PROMPT_FILENAME = "AGENT.md";
export const SUBAGENT_SYSTEM_PROMPT_FILENAME = "SUBAGENT.md";
export const ANALYSER_SYSTEM_PROMPT_FILENAME = "ANALYSER.md";
export const PLANNER_SYSTEM_PROMPT_FILENAME = "PLANNER.md";
export const PLAN_WRITER_SYSTEM_PROMPT_FILENAME = "PLAN_WRITER.md";
export const PLAN_REVIEWER_SYSTEM_PROMPT_FILENAME = "PLAN_REVIEWER.md";
export const EXECUTOR_SYSTEM_PROMPT_FILENAME = "EXECUTOR.md";
export const REPLANNER_SYSTEM_PROMPT_FILENAME = "REPLANNER.md";
export const SKILL_REFLECT_PROMPT_FILENAME = "SKILL_REFLECT.md";
export const SKILL_CURATION_PROMPT_FILENAME = "skill-curation.md";
export const USER_MEMORY_EXTRACT_PROMPT_FILENAME = "user-memory-extract.md";
export const PROJECT_MEMORY_EXTRACT_PROMPT_FILENAME = "project-memory-extract.md";
export const PROJECT_MEMORY_SUMMARIZE_PROMPT_FILENAME =
  "project-memory-summarize.md";
export const SESSION_TITLE_PROMPT_FILENAME = "session-title.md";
export const COMMIT_MESSAGE_PROMPT_FILENAME = "commit-message.md";
export const COMPACT_COLD_PROMPT_FILENAME = "compact-cold.md";
export const COMPACT_WARM_PROMPT_FILENAME = "compact-warm.md";
export const COMPACT_ITERATION_PROTECT_PROMPT_FILENAME = "compact-iteration-protect.md";
export const TOPIC_BOUNDARY_PROMPT_FILENAME = "topic-boundary.md";
export const COCO_PROMPT_NAMES = ["plan", "verify", "decide", "recover", "report", "retention", "commander", "wake", "handover", "background", "AGENT", "SOUL", "COCO_MEMORY", "COCO_AUTONOMOUS_EXEC_PROMPT", "memory-consolidate", "project-digest", "project-analyze"] as const;
export type CocoPromptName = (typeof COCO_PROMPT_NAMES)[number];

export type PromptDefaults = {
  userPrompt: string;
  projectPrompt: string;
};

let promptsDirConfigured: string | null = null;

function readPromptMarkdown(filePath: string): string {
  try {
    const raw = readFileSync(filePath, "utf8");
    return raw.replace(/^\uFEFF/, "").replace(/\s+$/u, "");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[prompts] failed to read ${filePath}: ${message}`);
    return "";
  }
}

function readConfiguredPrompt(filename: string): string {
  if (!promptsDirConfigured) return "";
  return clampSystemPrompt(
    readPromptMarkdown(join(promptsDirConfigured, filename)),
  );
}

function requirePrompt(promptsDir: string, filename: string): void {
  const value = readPromptMarkdown(join(promptsDir, filename));
  if (!value) {
    console.error(`[prompts] missing or empty ${filename} in ${promptsDir}`);
  }
}

export function configurePromptDefaults(promptsDir: string): void {
  promptsDirConfigured = promptsDir;
  requirePrompt(promptsDir, IDENTITY_PROMPT_FILENAME);
  requirePrompt(promptsDir, SOUL_PROMPT_FILENAME);
  requirePrompt(promptsDir, USER_PROMPT_FILENAME);
  requirePrompt(promptsDir, PROJECT_PROMPT_FILENAME);
  requirePrompt(promptsDir, AGENT_SYSTEM_PROMPT_FILENAME);
  requirePrompt(promptsDir, SUBAGENT_SYSTEM_PROMPT_FILENAME);
  requirePrompt(promptsDir, ANALYSER_SYSTEM_PROMPT_FILENAME);
  requirePrompt(promptsDir, PLANNER_SYSTEM_PROMPT_FILENAME);
  requirePrompt(promptsDir, PLAN_WRITER_SYSTEM_PROMPT_FILENAME);
  requirePrompt(promptsDir, PLAN_REVIEWER_SYSTEM_PROMPT_FILENAME);
  requirePrompt(promptsDir, EXECUTOR_SYSTEM_PROMPT_FILENAME);
  requirePrompt(promptsDir, REPLANNER_SYSTEM_PROMPT_FILENAME);
  requirePrompt(promptsDir, SKILL_REFLECT_PROMPT_FILENAME);
  requirePrompt(promptsDir, SKILL_CURATION_PROMPT_FILENAME);
  requirePrompt(promptsDir, USER_MEMORY_EXTRACT_PROMPT_FILENAME);
  requirePrompt(promptsDir, PROJECT_MEMORY_EXTRACT_PROMPT_FILENAME);
  requirePrompt(promptsDir, PROJECT_MEMORY_SUMMARIZE_PROMPT_FILENAME);
  requirePrompt(promptsDir, SESSION_TITLE_PROMPT_FILENAME);
  requirePrompt(promptsDir, COMMIT_MESSAGE_PROMPT_FILENAME);
  requirePrompt(promptsDir, COMPACT_COLD_PROMPT_FILENAME);
  requirePrompt(promptsDir, COMPACT_WARM_PROMPT_FILENAME);
  requirePrompt(promptsDir, COMPACT_ITERATION_PROTECT_PROMPT_FILENAME);
  requirePrompt(promptsDir, TOPIC_BOUNDARY_PROMPT_FILENAME);
  for (const name of COCO_PROMPT_NAMES) requirePrompt(promptsDir, `coco/${name}.md`);
}

export function getCocoPrompt(name: CocoPromptName): string {
  return readConfiguredPrompt(`coco/${name}.md`);
}

export function getDefaultIdentityPrompt(): string {
  return readConfiguredPrompt(IDENTITY_PROMPT_FILENAME);
}

export function getDefaultSoulPrompt(): string {
  return readConfiguredPrompt(SOUL_PROMPT_FILENAME);
}

export function getDefaultUserPrompt(): string {
  return readConfiguredPrompt(USER_PROMPT_FILENAME);
}

export function getDefaultProjectPrompt(): string {
  return readConfiguredPrompt(PROJECT_PROMPT_FILENAME);
}

export function getDefaultAgentSystemPrompt(): string {
  return readConfiguredPrompt(AGENT_SYSTEM_PROMPT_FILENAME);
}

export function getDefaultSubagentSystemPrompt(): string {
  return readConfiguredPrompt(SUBAGENT_SYSTEM_PROMPT_FILENAME);
}

export function getDefaultAnalyserSystemPrompt(): string {
  return readConfiguredPrompt(ANALYSER_SYSTEM_PROMPT_FILENAME);
}

export function getDefaultPlannerSystemPrompt(): string {
  return readConfiguredPrompt(PLANNER_SYSTEM_PROMPT_FILENAME);
}

export function getDefaultPlanWriterSystemPrompt(): string {
  return readConfiguredPrompt(PLAN_WRITER_SYSTEM_PROMPT_FILENAME);
}

export function getDefaultPlanReviewerSystemPrompt(): string {
  return readConfiguredPrompt(PLAN_REVIEWER_SYSTEM_PROMPT_FILENAME);
}

export function getDefaultExecutorSystemPrompt(): string {
  return readConfiguredPrompt(EXECUTOR_SYSTEM_PROMPT_FILENAME);
}

export function getDefaultReplannerSystemPrompt(): string {
  return readConfiguredPrompt(REPLANNER_SYSTEM_PROMPT_FILENAME);
}

export function getDefaultSkillReflectPrompt(): string {
  return readConfiguredPrompt(SKILL_REFLECT_PROMPT_FILENAME);
}

export function getDefaultSkillCurationPrompt(): string {
  return readConfiguredPrompt(SKILL_CURATION_PROMPT_FILENAME);
}

export function getDefaultUserMemoryExtractPrompt(): string {
  return (
    readConfiguredPrompt(USER_MEMORY_EXTRACT_PROMPT_FILENAME) ||
    ""
  );
}

export function getDefaultProjectMemoryExtractPrompt(): string {
  return readConfiguredPrompt(PROJECT_MEMORY_EXTRACT_PROMPT_FILENAME) || "";
}

export function getDefaultProjectMemorySummarizePrompt(): string {
  return readConfiguredPrompt(PROJECT_MEMORY_SUMMARIZE_PROMPT_FILENAME) || "";
}

export function getDefaultSessionTitlePrompt(): string {
  return readConfiguredPrompt(SESSION_TITLE_PROMPT_FILENAME);
}

export function getDefaultCommitMessagePrompt(): string {
  return (
    readConfiguredPrompt(COMMIT_MESSAGE_PROMPT_FILENAME) ||
    "Write a concise git commit message (imperative subject, optional short body). Output the message only."
  );
}

export function getDefaultCompactIterationProtectPrompt(): string {
  return (
    readConfiguredPrompt(COMPACT_ITERATION_PROTECT_PROMPT_FILENAME) ||
    "Create a structured handoff summary. Preserve goals, decisions, file paths, tool outcomes, and open tasks. Be concise and factual. Do not invent details."
  );
}

export function getDefaultTopicBoundaryPrompt(): string {
  return readConfiguredPrompt(TOPIC_BOUNDARY_PROMPT_FILENAME);
}

export function getDefaultSessionArchiveSummarizePrompt(): string {
  return (
    "Create the final archival summary of a completed work session. Capture the overall goal, the work performed (key decisions, files touched, tool outcomes, fixes), the final outcome, and anything worth remembering for future work in this project. Be concise and factual. Do not invent details. " +
    "If — and only if — the session has no lasting value for the long-term record (pure greetings or small talk, a throwaway test with no findings, an aborted run with nothing learned, or trivial back-and-forth with no real work), do NOT write a summary: reply with exactly `NO_ARCHIVE: <one-line reason>` on the first line and nothing else. When in doubt, summarize."
  );
}

export function getPromptDefaults(): PromptDefaults {
  return {
    userPrompt: getDefaultUserPrompt(),
    projectPrompt: getDefaultProjectPrompt(),
  };
}

export function clampSystemPrompt(value: string): string {
  if (value.length <= MAX_SYSTEM_PROMPT_CHARS) return value;
  return value.slice(0, MAX_SYSTEM_PROMPT_CHARS);
}
