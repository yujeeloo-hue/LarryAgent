import { chatCompletionOnce } from "../llm/openaiCompatibleClient.js";
import { noReasoningExtraBody } from "../llm/reasoningDisable.js";
import type { OpenAiCompatibleClientConfig } from "../llm/types.js";
import { agentLogError, agentLogInfo, agentLogWarn } from "../logging/agentLog.js";
import { getDefaultProjectMemorySummarizePrompt } from "../settings/promptDefaults.js";
import { PROJECT_DOC_MAX_CHARS, PROJECT_MEMORY_MAX_CHARS } from "./types.js";

export type ProjectMemorySummarizeClient = OpenAiCompatibleClientConfig;

export type ProjectSummarizeKind = "project" | "worklog" | "pitfalls";

const KIND_LIMITS: Record<ProjectSummarizeKind, number> = {
  project: PROJECT_MEMORY_MAX_CHARS,
  worklog: PROJECT_DOC_MAX_CHARS,
  pitfalls: PROJECT_DOC_MAX_CHARS,
};

const KIND_FALLBACK_PROMPTS: Record<ProjectSummarizeKind, string> = {
  project: `Compress PROJECT.md toward ≤3000 characters (soft target; output is stored as-is, never truncated). Keep the five section headings Basics / Structure / Conventions / Docs Guide / Recent; drop the Recent section entirely (code synthesizes it). Prefer high-signal facts; never invent; exclude secrets.`,
  worklog: `Compress the WORKLOG toward ≤4000 characters (soft target; stored as-is, never truncated). Keep the title and rule header lines. Keep the NEWEST entries verbatim; merge/compress the OLDEST entries into one-line summaries (they may be dropped only when truly redundant). Never invent. Output the complete markdown file only.`,
  pitfalls: `Compress the PITFALLS log toward ≤4000 characters (soft target; stored as-is, never truncated). Keep the title and rule header lines. Merge duplicate/similar pitfalls into one entry each (symptom → root cause → fix); drop stale/resolved ones only when clearly obsolete. Never invent. Output the complete markdown file only.`,
};

/**
 * Soft-target semantic compression per document kind — never a hard
 * truncation. Over the target with a chat client available → LLM compress;
 * the output is returned as-is even when still over target. Without a client
 * or on failure the original body is returned unchanged.
 */
export async function summarizeProjectTextIfNeeded(input: {
  kind: ProjectSummarizeKind;
  body: string;
  workspacePath: string;
  sessionId?: string;
  client?: ProjectMemorySummarizeClient | null;
  /** Force LLM pass even when under the soft target. */
  force?: boolean;
}): Promise<{ body: string; summarized: boolean; method: "none" | "llm" }> {
  const trimmed = input.body.trim();
  if (!trimmed) {
    return { body: "", summarized: false, method: "none" };
  }
  const limit = KIND_LIMITS[input.kind];
  if (trimmed.length <= limit && !input.force) {
    return { body: trimmed, summarized: false, method: "none" };
  }
  if (!input.client) {
    return { body: trimmed, summarized: false, method: "none" };
  }

  try {
    const systemPrompt =
      (input.kind === "project"
        ? getDefaultProjectMemorySummarizePrompt().trim()
        : "") || KIND_FALLBACK_PROMPTS[input.kind];
    agentLogInfo("project_memory.summarize.start", {
      kind: input.kind,
      workspacePath: input.workspacePath,
      sessionId: input.sessionId,
      beforeChars: trimmed.length,
    });
    const result = await chatCompletionOnce(input.client, {
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            `Soft target: ≤ ${limit} characters (guidance only; the output is stored as-is, never truncated).`,
            "",
            input.kind === "project"
              ? "## CURRENT PROJECT.md"
              : `## CURRENT ${input.kind.toUpperCase()} DOC`,
            trimmed.slice(0, 24_000),
          ].join("\n"),
        },
      ],
      meta: {
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        purpose: "project_memory_summarize",
      },
      // thinking-off; no forced temperature — Kimi K models allow exactly one
      // value per mode, any fixed number 400s on some provider.
      extraBody: noReasoningExtraBody(input.client.baseUrl),
    });
    const out = stripAccidentalFences(result.content).trim();
    if (out) {
      agentLogInfo("project_memory.summarize.llm", {
        kind: input.kind,
        workspacePath: input.workspacePath,
        sessionId: input.sessionId,
        beforeChars: trimmed.length,
        afterChars: out.length,
      });
      return { body: out, summarized: true, method: "llm" };
    }
    agentLogWarn("project_memory.summarize.empty_llm", {
      kind: input.kind,
      workspacePath: input.workspacePath,
      sessionId: input.sessionId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    agentLogError("project_memory.summarize.error", {
      kind: input.kind,
      workspacePath: input.workspacePath,
      sessionId: input.sessionId,
      message,
    });
  }

  // No client / LLM failed / empty output → keep the original body.
  return { body: trimmed, summarized: false, method: "none" };
}

function stripAccidentalFences(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)```$/i);
  return fence?.[1]?.trim() ?? trimmed;
}
