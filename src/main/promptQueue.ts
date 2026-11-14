/**
 * Pure prompt-queue core: the reducer + decision table behind a session's FIFO
 * queue of user prompts submitted while a turn is running.
 *
 * Extracted as pure functions (same precedent as `turnHandoffDrain.ts`) so the
 * ordering / mode / drain rules are unit-testable without booting the session
 * runtime. `sessionRuntime` owns the live array and all side effects
 * (broadcast, startTurn); nothing here touches sessions, IPC or the DB.
 *
 * Two modes, one queue (see {@link QueuedPromptMode}):
 * - `deferred` — the default. Drains in the turn `finally` as a **new turn**.
 * - `interrupt` — armed for immediate mid-turn insertion. Enqueueing fires
 *   the turn's interrupt signal (aborts the in-flight model stream /
 *   interruptible tool calls); at the next graph round boundary ALL armed
 *   items drain together as one merged user message.
 *
 * The FSM kernel only ever sees armed items ({@link takeNextSteer} /
 * {@link takeArmedInterrupts}), so a deferred prompt can never leak into a
 * running turn. Legacy `"steer"` values normalize to `interrupt` on intake.
 */

import type {
  AttachmentDraft,
  QueuedPrompt,
  QueuedPromptMode,
} from "../agent/ipcTypes.js";
import type { SessionStatus } from "../session/types.js";

/**
 * Hard cap on queued prompts per session. The queue is in-memory and drains
 * one item per turn, so an unbounded queue would be both a memory leak and an
 * unreviewable pile of stale intent.
 */
export const PROMPT_QUEUE_MAX = 20;

/**
 * Intake shim: legacy `"steer"` (the pre-interrupt boundary-insert mode)
 * maps to `interrupt`; anything unrecognized falls back to `deferred`.
 * Runtime values arrive untyped over IPC/relay, so this guards the wire.
 */
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

/**
 * Append one prompt. Never replaces an existing item — the single-slot
 * last-wins behavior of the old `pendingSteer` is intentionally gone, so two
 * quick submissions both survive in submission order.
 */
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

/** Drop one item by id. `ok:false` when the id is already gone (drained/race). */
export function removeQueued(
  items: QueuedPrompt[],
  id: string,
): { ok: boolean; items: QueuedPrompt[] } {
  const next = items.filter((item) => item.id !== id);
  if (next.length === items.length) return { ok: false, items };
  return { ok: true, items: next };
}

/**
 * Inline edit from the queue row. Empty text with no attachments removes the
 * item (matches the composer rule that an empty prompt is not a prompt).
 */
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

/** Arm / disarm one item for mid-turn insertion. */
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

/** Reorder so this item drains first; relative order of the rest is kept. */
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

/**
 * Merge drain (round boundary): take ALL armed interrupt items in FIFO
 * order for ONE merged user-message insertion — rapid multi-sends land
 * together instead of burning an aborted round each.
 */
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

/** Read-only companion of the armed takers (host `hasPendingSteer`). */
export function hasArmedInterrupt(items: QueuedPrompt[]): boolean {
  return items.some((item) => item.mode === "interrupt");
}

/**
 * Turn ended: an item armed for *this* turn's round boundaries missed its
 * window (the turn stopped / errored / paused before draining it). Demote it
 * back to `deferred` rather than silently carrying the armed state into the
 * next turn — the user re-arms explicitly if they still want that.
 */
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
  /** Queue length at drain time. */
  queueLength: number;
  /** Terminal status of the just-finished turn ("idle" = completed cleanly). */
  status: SessionStatus;
  /** A follow-up turn is already in flight (abort controller still set). */
  hasAbort: boolean;
  /** A /compact pass is running — turn start would throw. */
  compacting: boolean;
  /** A persisted ask_user / permission card is still waiting on the user. */
  waitingInput: boolean;
  /** A queued plan approval already started a turn — it wins this slot. */
  planApprovalTookPrecedence: boolean;
  /** A drain is already in flight (single-flight guard). */
  draining: boolean;
};

export type PromptQueueDrainDecision = {
  drain: boolean;
  /**
   * Why the drain was skipped. Never surfaced as a transcript message: the
   * queue is *kept*, visibly, so the row itself is the user-facing signal.
   * Logged only.
   */
  reason?:
    | "empty"
    | "already_draining"
    | "plan_approval"
    | "turn_in_flight"
    | "compacting"
    | "waiting_input"
    | "not_completed";
};

/**
 * Should the turn `finally` start a follow-up turn from the queue?
 *
 * Deliberately conservative: anything other than a cleanly completed, fully
 * quiescent session keeps the queue as-is. A user who hit Stop, hit an error,
 * or paused mid-turn gets their prompts back on screen instead of an
 * unexpected new turn (product decision — non-clean end never auto-starts).
 */
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
  // Agent turns finish "idle" on success. "completed" belongs to subagent runs
  // and must not drain a session queue either.
  if (input.status !== "idle") return { drain: false, reason: "not_completed" };
  return { drain: true };
}
