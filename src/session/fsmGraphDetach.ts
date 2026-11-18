import type { ComposerRunMode } from "../agent/ipcTypes.js";

export type FsmGraphDetachInputSession = {
  id: string;
  title: string;
  running: boolean;
  composerRunMode?: ComposerRunMode | null;
  composerFsmGraphId?: string | null;
};

export type FsmGraphDetachTarget = { id: string; title: string };

export type FsmGraphDetachPlan = {
  flip: FsmGraphDetachTarget[];
  blocked: FsmGraphDetachTarget[];
};

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
