import { chatCompletionOnce } from "../llm/openaiCompatibleClient.js";
import { noReasoningExtraBody } from "../llm/reasoningDisable.js";
import { jsonSchemaResponseFormat } from "../llm/strictJsonSchema.js";
import type { OpenAiCompatibleClientConfig } from "../llm/types.js";
import { agentLogError, agentLogInfo, agentLogWarn } from "../logging/agentLog.js";
import { enqueueBackgroundExtract } from "../memory/backgroundExtractQueue.js";
import type { JsonObject, Message, MessagePart } from "../session/types.js";
import { getDefaultProjectMemoryExtractPrompt } from "../settings/promptDefaults.js";
import {
  formatProjectBody,
  parseProjectSections,
  restoreDocsGuideSection,
  synthesizeRecentSection,
} from "./sections.js";
import {
  appendProjectDocEntries,
  ensureProjectDocsSkeleton,
  loadProjectDoc,
  readProjectDocHead,
  replaceProjectDocBody,
} from "./docsStore.js";
import { loadProjectMemory, setProjectMemoryBody } from "./store.js";
import { summarizeProjectTextIfNeeded } from "./summarize.js";
import { PROJECT_MEMORY_CONTENT_SECTIONS } from "./types.js";

export type ProjectMemoryExtractInput = {
  sessionId: string;
  workspacePath: string;
  turnMessages: Message[];
  client: OpenAiCompatibleClientConfig;
};

type ExtractParsed = {
  /** Full updated PROJECT.md front matter (# Title + sections 1–4), or null when unchanged. */
  project: string | null;
  /** New one-line bullets, newest first. */
  worklog: string[];
  pitfalls: string[];
  /** Full replacement markdown for the docs file, or null when unchanged. */
  handoff: string | null;
  style: string | null;
  deploy: string | null;
};

function projectExtractQueueKey(workspacePath: string): string {
  return `project:${workspacePath.trim()}`;
}

const FALLBACK_EXTRACT_PROMPT = `You maintain one workspace's memory: PROJECT.md (five-section front matter) plus five docs log files. Output STRICT JSON only. Every field is null/empty when unchanged: {"project":"<full markdown: # Title then sections ## Basics / ## Structure / ## Conventions / ## Docs Guide — NEVER include ## Recent, code synthesizes it>","worklog":["one-line bullet",...],"pitfalls":[...],"handoff":"<full replacement markdown for docs/HANDOFF.md>","style":"<full replacement markdown for docs/STYLE.md>","deploy":"<full replacement markdown for docs/DEPLOY.md>"}. PROJECT.md front sections aim ≤3000 chars (soft; never truncated). worklog/pitfalls bullets are NEWEST-FIRST prepends, one line each; emit them only for meaningful progress / durable lessons this turn. handoff/style/deploy are FULL replacements — rewrite to current truth, drop finished items; deploy credentials: locations only, never plaintext passwords. Legacy bodies using ## Overview / ## Work log / ## Pitfalls / ## Handoff headings must be redistributed into the five sections + docs files. Exclude secrets and personal prefs.`;

export const PROJECT_MEMORY_EXTRACT_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    project: {
      type: ["string", "null"],
      description:
        "Full updated PROJECT.md front matter (# Title + sections Basics/Structure/Conventions/Docs Guide, no Recent) when anything in them changed; null otherwise.",
    },
    worklog: {
      type: ["array", "null"],
      items: { type: "string" },
      description:
        "New worklog bullets (newest first, one line each) for meaningful progress this turn; null/empty when none.",
    },
    pitfalls: {
      type: ["array", "null"],
      items: { type: "string" },
      description:
        "New pitfall bullets (one line each) for durable lessons discovered this turn; null/empty when none.",
    },
    handoff: {
      type: ["string", "null"],
      description:
        "Full replacement markdown for docs/HANDOFF.md (unfinished / next-step items only); null when unchanged.",
    },
    style: {
      type: ["string", "null"],
      description:
        "Full replacement markdown for docs/STYLE.md (code / tech-choice / interaction / visual style digest); null when unchanged.",
    },
    deploy: {
      type: ["string", "null"],
      description:
        "Full replacement markdown for docs/DEPLOY.md (accounts-as-locations, addresses, dirs, release flow); null when unchanged.",
    },
  },
  required: ["project", "worklog", "pitfalls", "handoff", "style", "deploy"],
  additionalProperties: false,
};

function textFromParts(parts: MessagePart[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      chunks.push(part.text);
    } else if (part.type === "attachment") {
      chunks.push(`[attachment ${part.kind}: ${part.name ?? part.uri}]`);
    } else if (part.type === "tool_call") {
      chunks.push(`[tool_call ${part.name}]`);
    } else if (part.type === "tool_result") {
      const body = textFromParts(part.content).trim();
      chunks.push(
        body
          ? `[tool_result rc=${part.returnCode}] ${body.slice(0, 400)}`
          : `[tool_result rc=${part.returnCode}]`,
      );
    }
  }
  return chunks.join("\n");
}

function buildUserFacingTurnText(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const trimmed = textFromParts(m.parts).trim();
    if (!trimmed) continue;
    lines.push(`[${m.role}] ${trimmed}`);
  }
  return lines.join("\n\n");
}

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

function parseExtractResponse(raw: string): ExtractParsed | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (!fence?.[1]) return null;
    try {
      parsed = JSON.parse(fence[1].trim());
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;

  // Legacy {no_change, body} responses → body maps to the project front matter.
  if (record.no_change === true) {
    return {
      project: null,
      worklog: [],
      pitfalls: [],
      handoff: null,
      style: null,
      deploy: null,
    };
  }
  if (typeof record.body === "string" && record.project === undefined) {
    const body = record.body.trim();
    return {
      project: body || null,
      worklog: [],
      pitfalls: [],
      handoff: null,
      style: null,
      deploy: null,
    };
  }

  const project =
    typeof record.project === "string" && record.project.trim()
      ? record.project.trim()
      : null;
  const handoff =
    typeof record.handoff === "string" && record.handoff.trim()
      ? record.handoff.trim()
      : null;
  const style =
    typeof record.style === "string" && record.style.trim()
      ? record.style.trim()
      : null;
  const deploy =
    typeof record.deploy === "string" && record.deploy.trim()
      ? record.deploy.trim()
      : null;
  return {
    project,
    worklog: parseStringArray(record.worklog),
    pitfalls: parseStringArray(record.pitfalls),
    handoff,
    style,
    deploy,
  };
}

function parsedIsEmpty(parsed: ExtractParsed): boolean {
  return (
    parsed.project === null &&
    parsed.worklog.length === 0 &&
    parsed.pitfalls.length === 0 &&
    parsed.handoff === null &&
    parsed.style === null &&
    parsed.deploy === null
  );
}

/** Compress a log doc when over its soft target (best-effort). */
async function summarizeLogDocIfNeeded(input: {
  workspacePath: string;
  sessionId: string;
  doc: "worklog" | "pitfalls";
  client: OpenAiCompatibleClientConfig;
}): Promise<boolean> {
  const body = await loadProjectDoc(input.workspacePath, input.doc);
  if (body.trim().length <= 4_000) return false;
  const summarized = await summarizeProjectTextIfNeeded({
    kind: input.doc,
    body,
    workspacePath: input.workspacePath,
    sessionId: input.sessionId,
    client: input.client,
  });
  if (!summarized.summarized) return false;
  await replaceProjectDocBody(input.workspacePath, input.doc, summarized.body);
  return true;
}

async function runExtract(input: ProjectMemoryExtractInput): Promise<void> {
  const workspacePath = input.workspacePath.trim();
  if (!workspacePath) {
    agentLogInfo("project_memory.extract.skip", {
      sessionId: input.sessionId,
      reason: "no_workspace",
    });
    return;
  }

  const turnText = buildUserFacingTurnText(input.turnMessages);
  if (!turnText.trim()) {
    agentLogInfo("project_memory.extract.skip", {
      sessionId: input.sessionId,
      reason: "empty_turn",
    });
    return;
  }

  try {
    await ensureProjectDocsSkeleton(workspacePath);
  } catch (err) {
    agentLogWarn("project_memory.extract.skeleton_failed", {
      sessionId: input.sessionId,
      workspacePath,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const current = await loadProjectMemory(workspacePath);
  const systemPrompt =
    getDefaultProjectMemoryExtractPrompt().trim() || FALLBACK_EXTRACT_PROMPT;

  const userContent = [
    `## WORKSPACE\n${workspacePath}`,
    "",
    "## CURRENT PROJECT.md",
    current.empty ? "(empty)" : current.body,
    "",
    "## CURRENT docs/WORKLOG.md (head)",
    await readProjectDocHead(workspacePath, "worklog", 1_400),
    "",
    "## CURRENT docs/PITFALLS.md (head)",
    await readProjectDocHead(workspacePath, "pitfalls", 1_400),
    "",
    "## CURRENT docs/HANDOFF.md",
    await readProjectDocHead(workspacePath, "handoff", 1_800),
    "",
    "## CURRENT docs/STYLE.md",
    await readProjectDocHead(workspacePath, "style", 1_800),
    "",
    "## CURRENT docs/DEPLOY.md",
    await readProjectDocHead(workspacePath, "deploy", 2_200),
    "",
    "## TURN",
    turnText.slice(0, 24_000),
  ].join("\n");

  agentLogInfo("project_memory.extract.start", {
    sessionId: input.sessionId,
    workspacePath,
    bodyChars: current.body.length,
    turnChars: turnText.length,
  });

  try {
    const result = await chatCompletionOnce(input.client, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      meta: {
        sessionId: input.sessionId,
        purpose: "project_memory_extract",
      },
      responseFormat: jsonSchemaResponseFormat(
        "project_memory_extract",
        PROJECT_MEMORY_EXTRACT_SCHEMA,
      ),
      // thinking-off; no forced temperature — Kimi K models allow exactly one
      // value per mode, any fixed number 400s on some provider.
      extraBody: noReasoningExtraBody(input.client.baseUrl),
    });

    const parsed = parseExtractResponse(result.content);
    if (!parsed) {
      agentLogWarn("project_memory.extract.parse_failed", {
        sessionId: input.sessionId,
        preview: result.content.slice(0, 240),
      });
      return;
    }
    if (parsedIsEmpty(parsed)) {
      agentLogInfo("project_memory.extract.no_change", {
        sessionId: input.sessionId,
      });
      return;
    }

    // ---- distribute into docs files ----
    if (parsed.worklog.length > 0) {
      await appendProjectDocEntries(workspacePath, "worklog", parsed.worklog);
    }
    if (parsed.pitfalls.length > 0) {
      await appendProjectDocEntries(workspacePath, "pitfalls", parsed.pitfalls);
    }
    if (parsed.handoff !== null) {
      await replaceProjectDocBody(workspacePath, "handoff", parsed.handoff);
    }
    if (parsed.style !== null) {
      await replaceProjectDocBody(workspacePath, "style", parsed.style);
    }
    if (parsed.deploy !== null) {
      await replaceProjectDocBody(workspacePath, "deploy", parsed.deploy);
    }

    await summarizeLogDocIfNeeded({
      workspacePath,
      sessionId: input.sessionId,
      doc: "worklog",
      client: input.client,
    });
    await summarizeLogDocIfNeeded({
      workspacePath,
      sessionId: input.sessionId,
      doc: "pitfalls",
      client: input.client,
    });

    // ---- rebuild PROJECT.md (front sections + code-synthesized mirror) ----
    const parsedPatch = parseProjectSections(parsed.project ?? "");
    const parsedCurrent = parseProjectSections(
      current.empty ? "" : current.body,
    );
    const preamble = parsedPatch.preamble || parsedCurrent.preamble;
    const sections: Record<string, string> = {};
    for (const id of PROJECT_MEMORY_CONTENT_SECTIONS) {
      // Patch section wins; sparse patches fall back to current content so a
      // partial LLM output can never wipe a front section.
      sections[id] =
        parsedPatch.sections[id].trim() || parsedCurrent.sections[id].trim();
    }
    const [worklogBody, handoffBody, pitfallsBody] = await Promise.all([
      loadProjectDoc(workspacePath, "worklog"),
      loadProjectDoc(workspacePath, "handoff"),
      loadProjectDoc(workspacePath, "pitfalls"),
    ]);
    sections.recent = synthesizeRecentSection({
      worklogBody,
      handoffBody,
      pitfallsBody,
    });

    let nextBody = formatProjectBody({ preamble, sections });
    nextBody = (
      await summarizeProjectTextIfNeeded({
        kind: "project",
        body: nextBody,
        workspacePath,
        sessionId: input.sessionId,
        client: input.client,
      })
    ).body;
    // Derivable-section guard (same as composeProjectMemoryWrite): an empty
    // or placeholder Docs Guide gets the canonical boilerplate restored.
    nextBody = restoreDocsGuideSection(nextBody);

    const before = current.body.trim();
    const after = nextBody.trim();
    if (after === before) {
      agentLogInfo("project_memory.extract.no_change", {
        sessionId: input.sessionId,
        reason: "identical",
      });
      return;
    }

    await setProjectMemoryBody(workspacePath, after);
    agentLogInfo("project_memory.extract.updated", {
      sessionId: input.sessionId,
      workspacePath,
      beforeChars: before.length,
      afterChars: after.length,
      worklogAdded: parsed.worklog.length,
      pitfallsAdded: parsed.pitfalls.length,
      docsReplaced: [
        parsed.handoff !== null && "handoff",
        parsed.style !== null && "style",
        parsed.deploy !== null && "deploy",
      ].filter(Boolean),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    agentLogError("project_memory.extract.error", {
      sessionId: input.sessionId,
      workspacePath,
      message,
    });
  }
}

/**
 * Fire-and-forget post-turn project-memory update (PROJECT.md + docs logs).
 * Shares a quiet-delay serial queue with user-memory extract; coalesces per
 * workspacePath (latest wins). Never throws to the caller.
 */
export function scheduleProjectMemoryExtract(
  input: ProjectMemoryExtractInput,
): void {
  const key = input.workspacePath.trim();
  if (!key) return;
  enqueueBackgroundExtract(projectExtractQueueKey(key), () => runExtract(input));
}
