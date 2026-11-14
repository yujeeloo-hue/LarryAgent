import type { CocoBackgroundTask, CocoJob, CocoWork } from "../coco/types.js";
import type { CocoRepository } from "../coco/repository.js";
import { RECENT_BACKGROUND_FAILURE_MS } from "../coco/contextBudget.js";
import type { SessionStore } from "./sessionRuntime.js";

/**
 * Finished background operations are kept only as long as anything still
 * reads them: the wake context mentions failures for this window, and a
 * just-finished operation may be re-run with the same key and reuse its
 * session. The Background tasks UI shows running tasks only.
 */
export const BACKGROUND_SESSION_RETENTION_MS = RECENT_BACKGROUND_FAILURE_MS;

export type CocoBackgroundSession = {
  id: string; sessionId?: string | undefined; purpose: string; operationId?: string | undefined;
  workId?: string | undefined; at: number; startedAt?: number;
  status?: CocoBackgroundTask["status"]; summary?: string; endedAt?: number;
  contextSince?: number;
};

/**
 * Delete finished background records, their stored inputs and their
 * `coco_internal` session transcripts once past the retention window.
 * Keeps running turns, operations whose job is not done, and retention
 * analyses not yet cleared (cocoRetention owns those).
 */
export function pruneFinishedBackgroundSessions(repository: CocoRepository, store: SessionStore, now: number): { removed: number } {
  const records = repository.list<CocoBackgroundSession & { detailsClearedAt?: number }>("backgroundSession");
  const keep = (record: (typeof records)[number]): boolean => {
    if (record.purpose === "retention" && !record.detailsClearedAt) return true;
    if (record.sessionId && store.isTurnActive(record.sessionId)) return true;
    const job = repository.get<CocoJob>("job", record.operationId ?? record.id.split(":")[0] ?? "");
    if (job && job.status !== "done") return true;
    return now - (record.endedAt ?? record.at) < BACKGROUND_SESSION_RETENTION_MS;
  };
  const kept = records.filter(keep);
  const keptSessions = new Set(kept.flatMap(record => record.sessionId ? [record.sessionId] : []));
  const deleted = new Set<string>();
  let removed = 0;
  for (const record of records) {
    if (kept.includes(record)) continue;
    const sessionId = record.sessionId;
    if (sessionId && !keptSessions.has(sessionId) && !deleted.has(sessionId) && store.getSessionSummary(sessionId)) {
      if (!store.deleteCocoInternalSession(sessionId)) continue;
      deleted.add(sessionId);
    }
    repository.remove("backgroundInput", record.id);
    repository.remove("backgroundSession", record.id);
    removed++;
  }
  const live = new Set(repository.list<{ id: string }>("backgroundSession").map(record => record.id));
  for (const input of repository.list<{ id: string; at?: number }>("backgroundInput")) {
    if (!live.has(input.id) && now - (input.at ?? 0) >= BACKGROUND_SESSION_RETENTION_MS) repository.remove("backgroundInput", input.id);
  }
  return { removed };
}

/** Metadata only; full transcripts load lazily through the ordinary session reader. */
export function cocoBackgroundTasks(repository: CocoRepository, store: SessionStore, workspaceIds: string[]): CocoBackgroundTask[] {
  const contextSince = repository.meta("contextSince", 0);
  return repository.list<CocoBackgroundSession>("backgroundSession").flatMap(record => {
    if (record.purpose === "greet") return [];
    if (!record.sessionId || (record.contextSince ?? 0) !== contextSince) return [];
    const session = store.getSessionSummary(record.sessionId);
    if (!session || !workspaceIds.includes(session.workspaceId)) return [];
    const active = store.isTurnActive(session.id);
    const lifecycle = store.getTurnLifecycle(session.id);
    const status = active ? "running" : record.status === "running" ? "interrupted" : record.status
      ?? (session.status === "error" ? "error" : lifecycle?.state === "completed" ? "completed" : "interrupted");
    const work = record.workId ? repository.get<CocoWork>("work", record.workId) : undefined;
    return [{ id: record.id, sessionId: session.id, purpose: record.purpose, workId: record.workId,
      title: work?.title ?? ({ greet: "Catch up with you", plan: "Plan the goal", inspect: "Review project changes", report: "Prepare work report", retention: "Summarize older history" }[record.purpose] ?? "Check task progress"),
      status, startedAt: record.startedAt ?? record.at, updatedAt: Math.max(session.updatedAt, record.endedAt ?? record.at),
      progress: active ? session.progressText : "", summary: record.summary ?? (status === "error" ? lifecycle?.error ?? session.progressText : status === "interrupted" ? "The application stopped during this check. Its history is preserved." : ""),
    } satisfies CocoBackgroundTask];
  });
}
