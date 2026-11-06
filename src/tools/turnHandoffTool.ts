/**
 * `turn_handoff` tool implementation: queue this session's next turn on a
 * chosen FSM graph with an LLM-authored user prompt (self-harness last mile).
 *
 * Safety model (approved plan docs/plans/20260829-turn-handoff-tool.md):
 * - Session gate: disabled by default in every run mode; the user enables it
 *   per session via the composer Self Learning toggle. Gate-off calls fail
 *   with `handoff_disabled`.
 * - Graph gate: only library graphs with `enabled === true` can be queued
 *   (same bar as composer custom mode); LLM-authored graphs stay disabled
 *   until the user enables them — no self-authored auto-run bypass.
 * - Queue semantics: in-memory, last-wins (mirrors pendingSteer), dropped on
 *   real user input / cancel, drained only after a `completed` turn. The
 *   drain itself lives in sessionRuntime; this module only validates and
 *   queues.
 *
 * The host wires the port (`TurnHandoffPort`) in sessionRuntime — the tools
 * layer never statically imports agent/fsm (see isolation.boundaries).
 * The handler resolves and never throws: every failure lands in
 * `{ ok: false, error, code? }` (pattern: `runFsmGraphTool`).
 */

import type { FsmGraphRecordLike } from "./fsmGraphTool.js";

/** A validated handoff request, as stored on the live session. */
export type TurnHandoffRequest = {
  graphId: string;
  prompt: string;
  note?: string;
};

/** Structural port injected by the main-process host (sessionRuntime). */
export type TurnHandoffPort = {
  /** Session gate: composer Self Learning toggle state for this session. */
  isHandoffEnabled(sessionId: string): boolean;
  /** Library lookup for validation (same source as the fsm_graph tool). */
  getFsmGraph(id: string): Promise<FsmGraphRecordLike | null>;
  /** Queue (last-wins); returns whether a previous handoff was replaced. */
  queueHandoff(
    sessionId: string,
    handoff: TurnHandoffRequest,
  ): { replaced: boolean };
  /** Clear a queued handoff; returns whether one was queued. */
  cancelHandoff(sessionId: string): { cancelled: boolean };
};

export type TurnHandoffToolDeps = TurnHandoffPort;

export type TurnHandoffToolInput = {
  action?: unknown;
  graphId?: unknown;
  prompt?: unknown;
  note?: unknown;
};

export type TurnHandoffToolResult = {
  ok: boolean;
  error?: string;
  code?: string;
  queued?: boolean;
  cancelled?: boolean;
  replaced?: boolean;
  graphId?: string;
  graphName?: string;
  note?: string;
};

export const TURN_HANDOFF_TOOL_ACTIONS = ["queue", "cancel"] as const;

/** Hard cap on consecutive handoff-chained turns (runaway-loop guard). */
export const TURN_HANDOFF_CHAIN_DEPTH_CAP = 8;

function errorOut(error: string, code?: string): TurnHandoffToolResult {
  return code ? { ok: false, error, code } : { ok: false, error };
}

/** Host port failures throw; surface the message (and code when present). */
function toErrorResult(err: unknown): TurnHandoffToolResult {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string"
      ? { ok: false, error: err.message, code }
      : errorOut(err.message);
  }
  return errorOut(String(err));
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function runTurnHandoffTool(
  input: TurnHandoffToolInput,
  sessionId: string,
  deps: TurnHandoffToolDeps,
): Promise<TurnHandoffToolResult> {
  const action = trimmedString(input.action);
  if (!action || !TURN_HANDOFF_TOOL_ACTIONS.includes(action as never)) {
    return errorOut(
      `action must be one of: ${TURN_HANDOFF_TOOL_ACTIONS.join(", ")}`,
    );
  }

  try {
    // Session gate first: default-off in every run mode; the composer Self
    // Learning toggle is the only switch.
    if (!deps.isHandoffEnabled(sessionId)) {
      return errorOut(
        "turn_handoff is disabled for this session — ask the user to enable Turn Handoff in the composer (Self Learning section) first",
        "handoff_disabled",
      );
    }

    switch (action) {
      case "queue": {
        const graphId = trimmedString(input.graphId);
        if (!graphId) return errorOut("queue requires a non-empty graphId");
        const prompt = trimmedString(input.prompt);
        if (!prompt) return errorOut("queue requires a non-empty prompt");
        const note = trimmedString(input.note);

        const graph = await deps.getFsmGraph(graphId);
        if (!graph) {
          return errorOut(
            `FSM graph not found: ${graphId}`,
            "graph_not_found",
          );
        }
        if (!graph.enabled) {
          return errorOut(
            `FSM graph "${graph.name}" (${graphId}) is disabled — the user must enable it in the Graphs editor before it can run`,
            "graph_disabled",
          );
        }

        const { replaced } = deps.queueHandoff(sessionId, {
          graphId,
          prompt,
          ...(note ? { note } : {}),
        });
        return {
          ok: true,
          queued: true,
          graphId,
          graphName: graph.name,
          ...(replaced ? { replaced: true } : {}),
          note: "queued — starts automatically when the current turn completes; the follow-up turn inherits this turn's full-permissions state",
        };
      }

      case "cancel": {
        const { cancelled } = deps.cancelHandoff(sessionId);
        return { ok: true, cancelled };
      }

      default:
        return errorOut(
          `action must be one of: ${TURN_HANDOFF_TOOL_ACTIONS.join(", ")}`,
        );
    }
  } catch (err) {
    return toErrorResult(err);
  }
}
