import type { CocoRepository } from "../coco/repository.js";
import type { CocoWork } from "../coco/types.js";
import type { SessionStore } from "./sessionRuntime.js";

/**
 * One-shot origin repair at CoCo service boot: sessions linked as execution
 * targets of saved CoCo work but still marked 'app' (created before the
 * marker was stamped automatically, or adopted before re-stamping existed)
 * get the CoCo origin badge back without manual SQL. Idempotent; only 'app'
 * rows ever change ('app' surfaces as an absent source field), so
 * loop/subagent/coco_chat markers stay untouched.
 */
export function backfillCocoSessionSources(store: SessionStore, repository: CocoRepository): void {
  const linked = new Set<string>();
  for (const work of repository.list<CocoWork>("work")) if (work.sessionId) linked.add(work.sessionId);
  if (!linked.size) return;
  for (const summary of store.listSessions()) {
    if (summary.source || !linked.has(summary.id)) continue;
    store.setSessionSource(summary.id, "coco");
  }
}
