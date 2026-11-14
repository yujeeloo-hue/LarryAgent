import { createHash } from "node:crypto";
import type { CocoSnapshot } from "./types.js";

export const SMALL_TALK_INTERVAL = 60 * 60 * 1000;
export type VisitState = { fingerprint: string; spokenAt: number };

/** Ignore polling timestamps, budgets used, and background check lifecycles. */
export function visitWake(snapshot: CocoSnapshot, previous: VisitState | undefined, lastInteractionAt: number, now: number): { fingerprint: string; mode?: "progress" | "smalltalk" } {
  const work = snapshot.work.filter(w => snapshot.workspaces.some(p => p.id === w.workspaceId) && !["draft", "cancelled"].includes(w.status)).sort((a,b) => a.id.localeCompare(b.id));
  const plans = [...(snapshot.pendingPlans ?? [])].sort((a,b) => a.requestId.localeCompare(b.requestId));
  const fingerprint = createHash("sha256").update(JSON.stringify({
    work: work.map(w => [w.id, w.status, w.revision, w.summary, w.decision]),
    plans: plans.map(p => [p.requestId, p.status, p.title]),
    question: snapshot.chat?.question?.requestId,
    approval: snapshot.chat?.approval?.requestId,
    access: snapshot.workspaces.length ? "available" : "no-projects",
    cooldown: Boolean(snapshot.resumeAt),
  })).digest("hex");
  const interactionAt = Math.max(lastInteractionAt, previous?.spokenAt ?? 0);
  const latestChange = Math.max(0, ...work.map(w => w.updatedAt));
  const changed = previous ? fingerprint !== previous.fingerprint : latestChange > interactionAt || (!interactionAt && (plans.length > 0 || Boolean(snapshot.resumeAt)));
  // An existing baseline distinguishes actual progress from a repeated visit.
  if (changed) return { fingerprint, mode: "progress" };
  const busy = work.some(w => w.status !== "completed") || plans.length > 0 || snapshot.chat?.question || snapshot.chat?.approval || snapshot.resumeAt;
  if (!busy && (!interactionAt || now - interactionAt >= SMALL_TALK_INTERVAL)) return { fingerprint, mode: "smalltalk" };
  return { fingerprint };
}
