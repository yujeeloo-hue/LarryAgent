import { chatCompletionOnce } from "../llm/openaiCompatibleClient.js";
import { noReasoningExtraBody } from "../llm/reasoningDisable.js";
import { jsonSchemaResponseFormat } from "../llm/strictJsonSchema.js";
import type { OpenAiCompatibleClientConfig } from "../llm/types.js";
import { agentLogError, agentLogInfo, agentLogWarn } from "../logging/agentLog.js";
import type { JsonObject, Message, MessagePart } from "../session/types.js";
import { getDefaultUserMemoryExtractPrompt } from "../settings/promptDefaults.js";
import { enqueueBackgroundExtract } from "./backgroundExtractQueue.js";
import {
  loadUserMemory,
  setUserMemoryProfile,
} from "./store.js";

export type UserMemoryExtractInput = {
  sessionId: string;
  /** Messages belonging to the completed turn (user + following). */
  turnMessages: Message[];
  client: OpenAiCompatibleClientConfig;
};

type ExtractParsed =
  | { noChange: true }
  | { noChange: false; profile: string };

const USER_EXTRACT_QUEUE_KEY = "user";

const FALLBACK_EXTRACT_PROMPT = `You update a durable user profile. Output JSON only: {"no_change":true,"profile":null} or {"no_change":false,"profile":"<full markdown>"}. Record stable user facts only; exclude secrets and one-off tasks.`;

export const USER_MEMORY_EXTRACT_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    no_change: {
      type: "boolean",
      description:
        "True when the profile should stay unchanged; false when profile contains the full updated body.",
    },
    profile: {
      type: ["string", "null"],
      description:
        "Full updated markdown profile when no_change is false; null when no_change is true.",
    },
  },
  required: ["no_change", "profile"],
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

function parseExtractResponse(raw: string): ExtractParsed | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Tolerate accidental markdown fences from non-strict providers.
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
  if (record.no_change === true) {
    return { noChange: true };
  }
  if (record.no_change === false && typeof record.profile === "string") {
    const profile = record.profile.trim();
    if (!profile) return { noChange: true };
    return { noChange: false, profile };
  }
  // Legacy: {"profile":"..."} without no_change
  if (typeof record.profile === "string" && record.no_change === undefined) {
    const profile = record.profile.trim();
    if (!profile) return { noChange: true };
    return { noChange: false, profile };
  }
  return null;
}

async function runExtract(input: UserMemoryExtractInput): Promise<void> {
  const turnText = buildUserFacingTurnText(input.turnMessages);
  if (!turnText.trim()) {
    agentLogInfo("memory.extract.skip", {
      sessionId: input.sessionId,
      reason: "empty_turn",
    });
    return;
  }

  const current = await loadUserMemory();
  const systemPrompt =
    getDefaultUserMemoryExtractPrompt().trim() || FALLBACK_EXTRACT_PROMPT;

  const userContent = [
    "## CURRENT PROFILE",
    current.empty ? "(empty)" : current.profile,
    "",
    "## TURN",
    turnText.slice(0, 24_000),
  ].join("\n");

  agentLogInfo("memory.extract.start", {
    sessionId: input.sessionId,
    profileChars: current.profile.length,
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
        purpose: "user_memory_extract",
      },
      responseFormat: jsonSchemaResponseFormat(
        "user_memory_extract",
        USER_MEMORY_EXTRACT_SCHEMA,
      ),
      // thinking-off; no forced temperature — Kimi K models allow exactly one
      // value per mode, any fixed number 400s on some provider.
      extraBody: noReasoningExtraBody(input.client.baseUrl),
    });

    const parsed = parseExtractResponse(result.content);
    if (!parsed) {
      agentLogWarn("memory.extract.parse_failed", {
        sessionId: input.sessionId,
        preview: result.content.slice(0, 240),
      });
      return;
    }
    if (parsed.noChange) {
      agentLogInfo("memory.extract.no_change", {
        sessionId: input.sessionId,
      });
      return;
    }

    const before = current.profile.trim();
    const after = parsed.profile.trim();
    if (after === before) {
      agentLogInfo("memory.extract.no_change", {
        sessionId: input.sessionId,
        reason: "identical",
      });
      return;
    }

    await setUserMemoryProfile(after);
    agentLogInfo("memory.extract.updated", {
      sessionId: input.sessionId,
      beforeChars: before.length,
      afterChars: after.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    agentLogError("memory.extract.error", {
      sessionId: input.sessionId,
      message,
    });
  }
}

/**
 * Fire-and-forget post-turn profile update. Shares a quiet-delay serial queue
 * with project-memory extract (latest pending wins). Never throws to the caller.
 */
export function scheduleUserMemoryExtract(input: UserMemoryExtractInput): void {
  enqueueBackgroundExtract(USER_EXTRACT_QUEUE_KEY, () => runExtract(input));
}
