import type { ComposerRunMode } from "../agent/ipcTypes.js";

/** Minimal session view needed to plan an FSM graph detach. */
export type FsmGraphDetachInputSession = {
  id: string;
  title: string;
  /** Mid-turn (status running / aborting) — blocks graph deletion. */
  running: boolean;
  composerRunMode?: ComposerRunMode | null;
  composerFsmGraphId?: string | null;
};

export type FsmGraphDetachTarget = { id: string; title: string };

export type FsmGraphDetachPlan = {
  /** Idle sessions to flip to Auto before the graph is deleted. */
  flip: FsmGraphDetachTarget[];
  /** Running sessions that must block the deletion entirely. */
  blocked: FsmGraphDetachTarget[];
};

/**
 * Split sessions pinning `graphId` as their composer graph
 * (`runMode === "custom"` + matching `composerFsmGraphId`) into
 * idle ones to flip to Auto and running ones that block deletion.
 */
export function planFsmGraphDetach(
  sessions: readonly FsmGraphDetachInputSession[],
  graphId: string,
): FsmGraphDetachPlan {
  const target = typeof graphId === "string" ? graphId.trim() : "";
  const plan: FsmGraphDetachPlan = { flip: [], blocked: [] };
  if (!target) return plan;
  for (const session of sessions) {
    if (
      session.composerRunMode !== "custom" ||
      session.composerFsmGraphId !== target
    ) {
      continue;
    }
    (session.running ? plan.blocked : plan.flip).push({
      id: session.id,
      title: session.title,
    });
  }
  return plan;
}
