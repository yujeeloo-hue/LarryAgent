import {
  findLatestClearIndex,
  isClearMessage,
  isCompactionMessage,
} from "../agent/contextCompaction/messagesToOpenAi.js";
import {
  coverageCursorId,
  findLatestIterationProtectCompaction,
  liveTurnUserPrefixes,
} from "../agent/contextCompaction/strategies/iterationProtectV1/messagesToOpenAi.js";
import type { CocoPorts } from "../coco/engine.js";
import { clipText } from "../coco/transcriptDigest.js";
import { dispatchLlmApi } from "../llm/apiDispatch.js";
import type { Message } from "../session/types.js";
import { getCocoPrompt } from "../settings/promptDefaults.js";
import { meteredStream } from "./cocoMetering.js";
import type { CocoServiceDeps } from "./cocoServiceDeps.js";
import { resolveClient } from "./sessionRuntime.js";

export const COCO_DECISION_TIMEOUT_MS = 60000;

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max: number): string | undefined => typeof value === "string" && value.trim() ? clipText(value.trim(), max) : undefined;

export type SessionDialogue = {
  summary?: string;
  dialogue: { role: "user" | "assistant"; text: string }[];
};

const bodyText = (message: Message): string =>
  message.parts.flatMap(part => part.type === "text" && part.text.trim() ? [part.text.trim()] : []).join("\n");

/**
 * The session's model-facing conversation with thinking and tool calls removed.
 * History is the rolling summary the session model already sees. Body text is
 * user prompts plus assistant replies, in that same window.
 */
export function sessionDialogue(messages: readonly Message[]): SessionDialogue {
  const clearIndex = findLatestClearIndex(messages as Message[]);
  const visible = clearIndex >= 0 ? messages.slice(clearIndex + 1) : messages;
  const latest = findLatestIterationProtectCompaction(visible as Message[]);
  const withoutMarkers = visible.filter(message => !isCompactionMessage(message) && !isClearMessage(message));
  let summary: string | undefined;
  let live: readonly Message[];
  if (latest?.part.summary.trim()) {
    summary = latest.part.summary.trim();
    const coveredId = coverageCursorId(latest.part);
    const coveredIdx = coveredId ? withoutMarkers.findIndex(message => message.id === coveredId) : -1;
    if (coveredIdx >= 0) live = withoutMarkers.slice(coveredIdx + 1);
    else {
      const afterMarker = visible.slice(latest.markerIndex + 1).filter(message => !isCompactionMessage(message));
      live = afterMarker.length > 0 ? afterMarker : withoutMarkers;
    }
    const firstUserIdx = withoutMarkers.findIndex(message => message.role === "user");
    if (firstUserIdx > 0) {
      const prefixIds = new Set(withoutMarkers.slice(0, firstUserIdx).map(message => message.id));
      live = live.filter(message => !prefixIds.has(message.id));
    }
    live = [...liveTurnUserPrefixes(withoutMarkers as Message[], live as Message[]), ...live];
  } else {
    live = withoutMarkers;
  }
  const dialogue: SessionDialogue["dialogue"] = [];
  for (const message of live) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const body = bodyText(message);
    if (body) dialogue.push({ role: message.role, text: body });
  }
  return { ...(summary ? { summary } : {}), dialogue };
}

/** Question plus the simplified session dialogue. No tool calls, reasoning, or separate work record. */
export function buildDecisionInput(question: unknown, messages: readonly Message[] | undefined): Record<string, unknown> {
  const q = record(question);
  const dialogue = messages ? sessionDialogue(messages) : { dialogue: [] };
  return {
    question: {
      question: text(q.question, 4000) ?? "",
      options: Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === "string").map(o => clipText(o, 500)).slice(0, 20) : [],
      allowCustom: q.allowCustom !== false,
      allowMultiple: q.allowMultiple === true,
    },
    ...(dialogue.summary ? { summary: dialogue.summary } : {}),
    dialogue: dialogue.dialogue,
  };
}

export function parseDecision(raw: string): Record<string, unknown> | undefined {
  const body = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try { const value: unknown = JSON.parse(body.slice(start, end + 1)); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
  catch { return undefined; }
}

/** Supervisory decision: one compact, low-effort, metered request — no background session or input paging. */
export function createCocoDecide(deps: CocoServiceDeps): NonNullable<CocoPorts["decide"]> {
  const { root, store } = deps;
  return async ({ work, question }, signal, usage, providerId) => {
    const workspace = store.listWorkspaces().find(w => w.id === work.workspaceId);
    const sessionId = typeof record(question).sessionId === "string" ? String(record(question).sessionId) : work.sessionId;
    const messages = sessionId ? store.getSession(sessionId)?.messages : undefined;
    const input = buildDecisionInput(question, messages);
    const client = await resolveClient(root, workspace?.path ?? root, providerId || undefined, { fallbackIfMissing: true });
    const timeout = AbortSignal.timeout(COCO_DECISION_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, timeout]);
    const extraBody = dispatchLlmApi(client).requestExtraBody({ ...client, reasoningEffort: "low", disableReasoning: false });
    let reply = "";
    try {
      for await (const event of meteredStream(combined, usage)(client, {
        messages: [{ role: "system", content: getCocoPrompt("decide") }, { role: "user", content: JSON.stringify(input) }],
        signal: combined,
        ...(extraBody ? { extraBody } : {}),
      })) {
        if (event.type === "text_delta") reply += event.text;
        if (event.type === "error") throw new Error(event.message);
      }
    } catch (error) {
      signal.throwIfAborted();
      if (timeout.aborted) return { action: "needs_user", reason: `CoCo could not decide within ${COCO_DECISION_TIMEOUT_MS / 1000} seconds.` };
      throw error;
    }
    signal.throwIfAborted();
    if (timeout.aborted) return { action: "needs_user", reason: `CoCo could not decide within ${COCO_DECISION_TIMEOUT_MS / 1000} seconds.` };
    return parseDecision(reply) ?? { action: "needs_user", reason: "No reliable supervisory answer" };
  };
}
