
import type {
  AttachmentDraft,
  QueuedPrompt,
  QueuedPromptMode,
} from "../agent/ipcTypes.js";
import type { SessionStatus } from "../session/types.js";

export const PROMPT_QUEUE_MAX = 20;

export function normalizeQueuedPromptMode(mode: unknown): QueuedPromptMode {
  if (mode === "interrupt" || mode === "steer") return "interrupt";
  return "deferred";
}

export type EnqueueInput = {
  sessionId: string;
  userText: string;
  attachments: AttachmentDraft[];
  mode: QueuedPromptMode;
  id: string;
  createdAt: number;
  cocoWorkId?: string;
};

export type EnqueueResult =
  | { ok: true; items: QueuedPrompt[]; queued: QueuedPrompt }
  | { ok: false; reason: "empty" | "cap"; items: QueuedPrompt[] };

export function enqueuePrompt(
  items: QueuedPrompt[],
  input: EnqueueInput,
): EnqueueResult {
  const userText = input.userText.trim();
  if (!userText && input.attachments.length === 0) {
    return { ok: false, reason: "empty", items };
  }
  if (items.length >= PROMPT_QUEUE_MAX) {
    return { ok: false, reason: "cap", items };
  }
  const queued: QueuedPrompt = {
    id: input.id,
    sessionId: input.sessionId,
    userText,
    attachments: input.attachments,
    createdAt: input.createdAt,
    mode: normalizeQueuedPromptMode(input.mode),
    ...(input.cocoWorkId ? { cocoWorkId: input.cocoWorkId } : {}),
  };
  return { ok: true, items: [...items, queued], queued };
}

export function removeQueued(
  items: QueuedPrompt[],
  id: string,
): { ok: boolean; items: QueuedPrompt[] } {
  const next = items.filter((item) => item.id !== id);
  if (next.length === items.length) return { ok: false, items };
  return { ok: true, items: next };
}

export function updateQueuedText(
  items: QueuedPrompt[],
  id: string,
  text: string,
): { ok: boolean; items: QueuedPrompt[]; removed?: boolean } {
  const target = items.find((item) => item.id === id);
  if (!target) return { ok: false, items };
  const userText = text.trim();
  if (!userText && target.attachments.length === 0) {
    return { ok: true, items: items.filter((item) => item.id !== id), removed: true };
  }
  return {
    ok: true,
    items: items.map((item) =>
      item.id === id ? { ...item, userText } : item,
    ),
  };
}

export function setQueuedMode(
  items: QueuedPrompt[],
  id: string,
  mode: QueuedPromptMode,
): { ok: boolean; items: QueuedPrompt[] } {
  const target = items.find((item) => item.id === id);
  if (!target) return { ok: false, items };
  if (target.mode === mode) return { ok: true, items };
  return {
    ok: true,
    items: items.map((item) => (item.id === id ? { ...item, mode } : item)),
  };
}

export function moveQueuedToFront(
  items: QueuedPrompt[],
  id: string,
): { ok: boolean; items: QueuedPrompt[] } {
  const target = items.find((item) => item.id === id);
  if (!target) return { ok: false, items };
  if (items[0]?.id === id) return { ok: true, items };
  return {
    ok: true,
    items: [target, ...items.filter((item) => item.id !== id)],
  };
}

export function takeArmedInterrupts(
  items: QueuedPrompt[],
): { taken: QueuedPrompt[]; items: QueuedPrompt[] } {
  if (!items.some((item) => item.mode === "interrupt")) {
    return { taken: [], items };
  }
  return {
    taken: items.filter((item) => item.mode === "interrupt"),
    items: items.filter((item) => item.mode !== "interrupt"),
  };
}

export function hasArmedInterrupt(items: QueuedPrompt[]): boolean {
  return items.some((item) => item.mode === "interrupt");
}

export function demoteArmedOnTurnEnd(
  items: QueuedPrompt[],
): { changed: boolean; items: QueuedPrompt[] } {
  if (!hasArmedInterrupt(items)) return { changed: false, items };
  return {
    changed: true,
    items: items.map((item) =>
      item.mode === "interrupt" ? { ...item, mode: "deferred" as const } : item,
    ),
  };
}

export type PromptQueueDrainInput = {
  queueLength: number;
  status: SessionStatus;
  hasAbort: boolean;
  compacting: boolean;
  waitingInput: boolean;
  planApprovalTookPrecedence: boolean;
  draining: boolean;
};

export type PromptQueueDrainDecision = {
  drain: boolean;
  reason?:
    | "empty"
    | "already_draining"
    | "plan_approval"
    | "turn_in_flight"
    | "compacting"
    | "waiting_input"
    | "not_completed";
};

export function promptQueueDrainDecision(
  input: PromptQueueDrainInput,
): PromptQueueDrainDecision {
  if (input.queueLength === 0) return { drain: false, reason: "empty" };
  if (input.draining) return { drain: false, reason: "already_draining" };
  if (input.planApprovalTookPrecedence) {
    return { drain: false, reason: "plan_approval" };
  }
  if (input.hasAbort) return { drain: false, reason: "turn_in_flight" };
  if (input.compacting) return { drain: false, reason: "compacting" };
  if (input.waitingInput) return { drain: false, reason: "waiting_input" };
  if (input.status !== "idle") return { drain: false, reason: "not_completed" };
  return { drain: true };
}
