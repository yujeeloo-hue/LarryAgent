import type { CocoRepository } from "../coco/repository.js";
import type { CocoWork } from "../coco/types.js";
import type { SessionStore } from "./sessionRuntime.js";

export function backfillCocoSessionSources(store: SessionStore, repository: CocoRepository): void {
  const linked = new Set<string>();
  for (const work of repository.list<CocoWork>("work")) if (work.sessionId) linked.add(work.sessionId);
  if (!linked.size) return;
  for (const summary of store.listSessions()) {
    if (summary.source || !linked.has(summary.id)) continue;
    store.setSessionSource(summary.id, "coco");
  }
}
