import type { OpenAiChatMessage } from "../../llm/types.js";
import type { Message, SessionPlan } from "../../session/types.js";
import {
  formatPlanSummary,
  isActivePlan,
  planStepStatusesKey,
} from "../../session/plan.js";
import { isClearMessage, isNewTaskMessage } from "./messagesToOpenAi.js";

export const PLAN_PIN_HEADER =
  "In-progress plan (kept verbatim across context compaction; any plan tool result after this point supersedes it):";

const PLAN_JSON_PREFIX = "plan_json:";

export type PlanPin = {
  toolCallId: string;
  text: string;
};

type PlanToolResult = PlanPin & {
  planId: string | null;
  statusesKey: string;
};

function withoutPlanJson(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(PLAN_JSON_PREFIX))
    .join("\n")
    .trim();
}

function parsePlanResult(message: Message): PlanToolResult | null {
  if (message.role !== "tool" || !message.toolCallId) return null;
  for (const part of message.parts) {
    if (part.type !== "tool_result" || part.returnCode !== 0) continue;
    const text = part.content
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    const jsonLine = text
      .split(/\r?\n/)
      .find((line) => line.startsWith(PLAN_JSON_PREFIX));
    if (!jsonLine) continue;
    let planId: string | null = null;
    let statusesKey = "";
    try {
      const parsed = JSON.parse(jsonLine.slice(PLAN_JSON_PREFIX.length)) as SessionPlan;
      planId = typeof parsed.id === "string" ? parsed.id : null;
      statusesKey = planStepStatusesKey(parsed);
    } catch {
    }
    const kept = withoutPlanJson(text);
    if (!kept) return null;
    return { toolCallId: message.toolCallId, text: kept, planId, statusesKey };
  }
  return null;
}

function newestResultOf(
  messages: Message[],
  planId: string,
): PlanToolResult | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (isClearMessage(message) || isNewTaskMessage(message)) return null;
    const result = parsePlanResult(message);
    if (result?.planId === planId) return result;
  }
  return null;
}

export function activePlanPin(
  scope: Message[],
  plan: SessionPlan | null | undefined,
  transcript: Message[] = scope,
): PlanPin | null {
  if (!isActivePlan(plan)) return null;
  const inScope = newestResultOf(scope, plan.id);
  if (!inScope) return null;
  const isNewest = newestResultOf(transcript, plan.id)?.toolCallId === inScope.toolCallId;
  if (isNewest && inScope.statusesKey !== planStepStatusesKey(plan)) {
    return {
      toolCallId: inScope.toolCallId,
      text: withoutPlanJson(formatPlanSummary(plan)),
    };
  }
  return { toolCallId: inScope.toolCallId, text: inScope.text };
}

export function formatPlanPin(pin: PlanPin): string {
  return `${PLAN_PIN_HEADER}\n${pin.text}`;
}

function wireText(content: OpenAiChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

export function ensurePlanPinOnWire(
  messages: OpenAiChatMessage[],
  insertAt: number,
  pin: PlanPin | null,
): OpenAiChatMessage[] {
  if (!pin) return messages;
  const pinText = formatPlanPin(pin);
  const present = messages.some(
    (m) =>
      (m.role === "tool" && m.tool_call_id === pin.toolCallId) ||
      (m.role === "system" && wireText(m.content).includes(pinText)),
  );
  if (present) return messages;
  const at = Math.max(0, Math.min(insertAt, messages.length));
  return [
    ...messages.slice(0, at),
    { role: "system", content: pinText },
    ...messages.slice(at),
  ];
}
