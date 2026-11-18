import { chatCompletionOnce } from "../llm/openaiCompatibleClient.js";
import { noReasoningExtraBody } from "../llm/reasoningDisable.js";
import { jsonSchemaResponseFormat } from "../llm/strictJsonSchema.js";
import type { OpenAiCompatibleClientConfig } from "../llm/types.js";
import { agentLogInfo, agentLogWarn } from "../logging/agentLog.js";
import {
  isClearMessage,
  isNewTaskMessage,
  messagesAfterModelWindowFloor,
} from "./contextCompaction/messagesToOpenAi.js";
import {
  findLatestIterationProtectCompaction,
} from "./contextCompaction/strategies/iterationProtectV1/messagesToOpenAi.js";
import type {
  JsonObject,
  Message,
  Session,
} from "../session/types.js";
import { isActivePlan } from "../session/plan.js";
import { getDefaultTopicBoundaryPrompt } from "../settings/promptDefaults.js";

export const TOPIC_BOUNDARY_TIMEOUT_MS = 15_000;
const TOPIC_BOUNDARY_BLOCK_CHARS = 1_500;

export const TOPIC_BOUNDARY_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    related: {
      type: "boolean",
      description:
        "True when the new message continues the current conversation task; false only when the task clearly changed.",
    },
  },
  required: ["related"],
  additionalProperties: false,
};

export type TopicBoundaryJudgeInput = {
  session: Session;
  client: OpenAiCompatibleClientConfig;
  userText: string;
  hasAttachments: boolean;
  signal?: AbortSignal;
  complete?: typeof chatCompletionOnce;
};

function messageText(message: Message): string {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.type !== "text") continue;
    if (part.id === "file_body" || part.id === "file_diff") continue;
    const text = part.text.trim();
    if (text) chunks.push(text);
  }
  return chunks.join("\n").trim();
}

function clip(value: string): string {
  const text = value.trim();
  return text.length > TOPIC_BOUNDARY_BLOCK_CHARS
    ? `${text.slice(0, TOPIC_BOUNDARY_BLOCK_CHARS)}\n[…truncated…]`
    : text;
}

function findLastIndex<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && predicate(item)) return i;
  }
  return -1;
}

export function topicBoundaryMaterial(
  messages: Message[],
): { summary?: string; user?: string; assistant?: string } {
  const scope = messagesAfterModelWindowFloor(messages).filter(
    (message) => !isClearMessage(message) && !isNewTaskMessage(message),
  );
  if (scope.length === 0) return {};
  const latest = findLatestIterationProtectCompaction(scope);
  const userIndex = findLastIndex(scope, (message) => message.role === "user");
  const user =
    userIndex >= 0 ? clip(messageText(scope[userIndex]!)) : "";
  const assistantIndex = findLastIndex(
    scope,
    (message) => message.role === "assistant",
  );
  const assistant =
    assistantIndex >= 0 ? clip(messageText(scope[assistantIndex]!)) : "";
  return {
    ...(latest?.part.summary.trim()
      ? { summary: clip(latest.part.summary) }
      : {}),
    ...(user ? { user } : {}),
    ...(assistant ? { assistant } : {}),
  };
}

export type TopicBoundaryDecision = {
  split: boolean;
  skipped?:
    | "no_prior_user_text"
    | "active_plan"
    | "unavailable"
    | "failed";
};

export async function judgeTopicBoundary(
  input: TopicBoundaryJudgeInput,
): Promise<TopicBoundaryDecision> {
  const scope = messagesAfterModelWindowFloor(input.session.messages);
  const hasPriorUserText = scope.some(
    (message) => message.role === "user" && messageText(message).length > 0,
  );
  if (!hasPriorUserText) return { split: false, skipped: "no_prior_user_text" };
  if (isActivePlan(input.session.plan)) {
    return { split: false, skipped: "active_plan" };
  }

  const systemPrompt = getDefaultTopicBoundaryPrompt().trim();
  if (!systemPrompt) {
    return { split: false, skipped: "unavailable" };
  }

  const material = topicBoundaryMaterial(input.session.messages);
  const current = clip(input.userText);
  const userContent = [
    "## PREVIOUS TASK",
    material.summary ? `Summary so far:\n${material.summary}` : "(no summary)",
    material.user ? `Last user message:\n${material.user}` : "",
    material.assistant ? `Last assistant reply:\n${material.assistant}` : "",
    "",
    "## NEW MESSAGE",
    current || "(attachment only)",
    input.hasAttachments ? "(the new message also carries attachments)" : "",
  ]
    .filter((block) => block.length > 0)
    .join("\n");

  try {
    const result = await (input.complete ?? chatCompletionOnce)(input.client, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      meta: { sessionId: input.session.id, purpose: "topic_boundary" },
      responseFormat: jsonSchemaResponseFormat(
        "topic_boundary",
        TOPIC_BOUNDARY_SCHEMA,
      ),
      extraBody: noReasoningExtraBody(input.client.baseUrl),
      timeoutMs: TOPIC_BOUNDARY_TIMEOUT_MS,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const related = parseRelated(result.content);
    if (related === null) {
      agentLogWarn("topic_boundary.parse_failed", {
        sessionId: input.session.id,
        preview: result.content.slice(0, 200),
      });
      return { split: false, skipped: "failed" };
    }
    agentLogInfo("topic_boundary.judged", {
      sessionId: input.session.id,
      related,
      scopeMessages: scope.length,
    });
    return { split: !related };
  } catch (err) {
    agentLogWarn("topic_boundary.failed", {
      sessionId: input.session.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { split: false, skipped: "failed" };
  }
}

export function parseRelated(content: string): boolean | null {
  const text = content.trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>).related;
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        const lowered = value.trim().toLowerCase();
        if (lowered === "true" || lowered === "false") return lowered === "true";
      }
    }
  } catch {
  }
  const match = text.match(/"related"\s*:\s*(true|false)/i);
  if (match?.[1]) return match[1].toLowerCase() === "true";
  return null;
}

export type NewTaskBoundaryResult = {
  markerId: string;
  hiddenMessageCount: number;
};

export function applyNewTaskBoundary(input: {
  session: Session;
  createId: () => string;
}): NewTaskBoundaryResult {
  const { session, createId } = input;
  const hiddenMessageCount = session.messages.length;
  const markerId = createId();
  session.messages.push({
    id: markerId,
    role: "system",
    createdAt: Date.now(),
    parts: [
      {
        type: "context_new_task",
        id: createId(),
        reason: "unrelated_prompt",
        hiddenMessageCount,
      },
    ],
  });
  if (session.planDoc) session.planDoc = null;
  session.fsmBlackboard = null;
  if (session.phase) session.phase = null;
  session.contextUsage = {
    usedTokens: 0,
    displayUsedTokens: 0,
    source: "estimate",
  };
  session.contextBuckets = {
    hotTurnCount: 0,
    warmTurnCount: 0,
    hot: 0,
    warm: 0,
    cold: 0,
    updatedAt: Date.now(),
  };
  session.updatedAt = Date.now();
  return { markerId, hiddenMessageCount };
}
