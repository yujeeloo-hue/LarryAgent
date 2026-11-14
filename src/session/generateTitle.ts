import { chatCompletionOnce } from "../llm/openaiCompatibleClient.js";
import { noReasoningExtraBody } from "../llm/reasoningDisable.js";
import type { OpenAiCompatibleClientConfig } from "../llm/types.js";
import { agentLogError, agentLogInfo, agentLogWarn } from "../logging/agentLog.js";
import { getDefaultSessionTitlePrompt } from "../settings/promptDefaults.js";
import type { Message, MessagePart } from "./types.js";
import { clipTitle } from "./plan.js";

/** Soft cap aligned with the heuristic `titleFromPrompt` in sessionRuntime. */
export const SESSION_TITLE_MAX = 60;

/** Soft cap for the turn payload sent to the title model. */
const TITLE_INPUT_MAX_CHARS = 12_000;

export type SessionTitleGenerateInput = {
  sessionId: string;
  /**
   * Messages from the first turn that just ended (user send through turn finish).
   * Title generation summarizes that turn only — scheduled once after the
   * first successful turn ends.
   */
  turnMessages: Message[];
  client: OpenAiCompatibleClientConfig;
  /** Apply a sanitized title to the live session + persist (caller-owned). */
  applyTitle: (title: string) => void;
};

const FALLBACK_TITLE_PROMPT = `Write a short English session title (3–8 words, max ~60 chars) for a coding agent sidebar from this turn's conversation. Always use English even if the user wrote in another language. Output the title only — never repeat labels or headings from the request.`;

/** Phrases / patterns that are scaffolding echo, not real titles. */
const SCAFFOLD_TITLE_RE =
  /^(?:#{1,6}\s*)?(?:user\s*prompt|first\s*turn|user\s*request|prompt|request|input|system|assistant|title|session(?:\s*title)?|this\s*turn|conversation(?:\s*so\s*far)?)\s*$/i;

/** Coalesce by sessionId: latest pending wins while one job is in flight. */
const pendingBySession = new Map<string, SessionTitleGenerateInput>();
const inFlightBySession = new Map<string, Promise<void>>();

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
      // Titles need tool presence, not full dumps.
      chunks.push(`[tool_result rc=${part.returnCode}]`);
    } else if (part.type === "reasoning") {
      // Skip CoT — noisy and unused for sidebar titles.
    }
  }
  return chunks.join("\n");
}

/** Project this turn's transcript into a compact role-tagged blob. */
export function buildConversationTextForTitle(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const trimmed = textFromParts(m.parts).trim();
    if (!trimmed) continue;
    if (m.role === "user") {
      lines.push(trimmed);
    } else {
      const body =
        trimmed.length > 800 ? `${trimmed.slice(0, 800)}…` : trimmed;
      lines.push(`[${m.role}] ${body}`);
    }
  }
  return lines.join("\n\n");
}

/** Keep head + tail when over budget. */
export function fitConversationForTitle(
  text: string,
  max = TITLE_INPUT_MAX_CHARS,
): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.35);
  const tail = max - head - 24;
  return `${text.slice(0, head)}\n\n…\n\n${text.slice(-tail)}`;
}

function isScaffoldTitle(text: string): boolean {
  const normalized = text.replace(/^#+\s*/, "").trim();
  if (!normalized) return true;
  if (SCAFFOLD_TITLE_RE.test(normalized)) return true;
  if (/^#+$/.test(normalized)) return true;
  return false;
}

/** Normalize model output into a single-line sidebar title. */
export function sanitizeSessionTitle(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;

  const fence = text.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    text = fence[1].trim();
  }

  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed.title === "string" && parsed.title.trim()) {
        text = parsed.title.trim();
      }
    } catch {
      // keep raw text
    }
  }

  const candidates = text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^(?:title|session)\s*[:：]\s*/i, "")
        .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
        .replace(/[.。!！?？:;：；]+$/u, "")
        .trim(),
    )
    .filter((line) => line.length > 0 && !isScaffoldTitle(line));

  text = candidates[0] ?? "";
  if (!text) return null;

  return clipTitle(text, SESSION_TITLE_MAX);
}

async function runGenerate(input: SessionTitleGenerateInput): Promise<void> {
  const turnText = fitConversationForTitle(
    buildConversationTextForTitle(input.turnMessages),
  );
  if (!turnText.trim()) {
    agentLogInfo("session.title.skip", {
      sessionId: input.sessionId,
      reason: "empty_turn",
    });
    return;
  }

  const systemPrompt =
    getDefaultSessionTitlePrompt().trim() || FALLBACK_TITLE_PROMPT;

  agentLogInfo("session.title.start", {
    sessionId: input.sessionId,
    turnChars: turnText.length,
    messageCount: input.turnMessages.length,
  });

  try {
    const result = await chatCompletionOnce(input.client, {
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            "This turn:",
            turnText,
            "",
            "Reply with the English sidebar title only.",
          ].join("\n"),
        },
      ],
      meta: {
        sessionId: input.sessionId,
        purpose: "session_title",
      },
      extraBody: noReasoningExtraBody(input.client.baseUrl),
    });

    const title = sanitizeSessionTitle(result.content);
    if (!title) {
      agentLogWarn("session.title.parse_failed", {
        sessionId: input.sessionId,
        preview: result.content.slice(0, 240),
      });
      return;
    }

    input.applyTitle(title);
    agentLogInfo("session.title.updated", {
      sessionId: input.sessionId,
      title,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    agentLogError("session.title.error", {
      sessionId: input.sessionId,
      message,
    });
  }
}

async function drainSession(sessionId: string): Promise<void> {
  const key = sessionId.trim();
  while (pendingBySession.has(key)) {
    const next = pendingBySession.get(key)!;
    pendingBySession.delete(key);
    await runGenerate(next);
  }
}

/**
 * Fire-and-forget title from the first turn's transcript after that turn ends.
 * Coalesces per sessionId (latest pending wins). Never throws to the caller.
 * Reasoning is disabled on the title LLM call.
 */
export function scheduleSessionTitle(input: SessionTitleGenerateInput): void {
  const key = input.sessionId.trim();
  if (!key) return;
  pendingBySession.set(key, input);
  if (inFlightBySession.has(key)) return;
  const flight = drainSession(key)
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      agentLogError("session.title.unhandled", {
        sessionId: input.sessionId,
        message,
      });
    })
    .finally(() => {
      inFlightBySession.delete(key);
      if (pendingBySession.has(key)) {
        scheduleSessionTitle(pendingBySession.get(key)!);
      }
    });
  inFlightBySession.set(key, flight);
}
