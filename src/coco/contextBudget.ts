import type { CocoBackgroundTask, CocoWork } from "./types.js";

/**
 * Coordination context is re-sent on every CoCo Chat model iteration as a
 * system prefix (never compacted), and overview tool results stay raw inside
 * the protect window. Every projection here must stay bounded regardless of
 * how many works / background tasks accumulate; full details remain
 * available through `coco_context` with `workspaceId` + `workId`/`sessionId`.
 */
export const WAKE_BACKGROUND_LIMIT = 12;
export const BACKGROUND_SUMMARY_CHARS = 300;
export const BACKGROUND_PROGRESS_CHARS = 200;
export const TIMELINE_TEXT_CHARS = 400;
export const OVERVIEW_WORK_LIMIT = 60;
export const OVERVIEW_SUMMARY_CHARS = 400;
export const OVERVIEW_OBJECTIVE_CHARS = 600;
export const OVERVIEW_STEP_LIMIT = 12;
export const OVERVIEW_STEP_CHARS = 120;

export function clipText(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function clipTimeline(timeline: CocoWork["timeline"], count: number, chars = TIMELINE_TEXT_CHARS): CocoWork["timeline"] {
  return timeline.slice(-count).map(entry => ({ at: entry.at, text: clipText(entry.text, chars) ?? "" }));
}

/** Failed / interrupted tasks stay relevant to a greeting only this long. */
export const RECENT_BACKGROUND_FAILURE_MS = 30 * 60_000;

/**
 * Model context only carries live background work: running tasks, plus
 * failures recent enough to mention. Completed and stale records stay in the
 * repository for the Background tasks UI but never reach the prompt.
 */
export function wakeBackgroundTasks(tasks: CocoBackgroundTask[], now: number, limit = WAKE_BACKGROUND_LIMIT): { tasks: CocoBackgroundTask[]; omitted: number } {
  const relevant = tasks.filter(task => task.status === "running"
    || ((task.status === "error" || task.status === "interrupted") && now - task.updatedAt <= RECENT_BACKGROUND_FAILURE_MS));
  const ordered = relevant.sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.updatedAt - a.updatedAt);
  const kept = ordered.slice(0, limit).map(task => ({
    ...task,
    progress: clipText(task.progress, BACKGROUND_PROGRESS_CHARS) ?? "",
    summary: clipText(task.summary, BACKGROUND_SUMMARY_CHARS) ?? "",
  }));
  return { tasks: kept, omitted: ordered.length - kept.length };
}

/** Bounded per-work projection for the `coco_context` overview. */
export function overviewWork(work: CocoWork) {
  return {
    id: work.id, title: work.title, workspaceId: work.workspaceId, status: work.status,
    objective: clipText(work.objective, OVERVIEW_OBJECTIVE_CHARS),
    steps: work.steps.slice(0, OVERVIEW_STEP_LIMIT).map(step => clipText(step, OVERVIEW_STEP_CHARS)),
    ...(work.steps.length > OVERVIEW_STEP_LIMIT ? { stepsOmitted: work.steps.length - OVERVIEW_STEP_LIMIT } : {}),
    summary: clipText(work.summary, OVERVIEW_SUMMARY_CHARS),
    ...(work.decision ? { decision: clipText(work.decision, OVERVIEW_SUMMARY_CHARS) } : {}),
    timeline: clipTimeline(work.timeline, 2),
    dependsOn: work.dependsOn, sessionId: work.sessionId, revision: work.revision, priority: work.priority,
    updatedAt: work.updatedAt,
  };
}

/** Newest works first, bounded count; `omitted` tells the model more exist. */
export function overviewWorks(works: CocoWork[], limit = OVERVIEW_WORK_LIMIT): { works: ReturnType<typeof overviewWork>[]; omitted: number } {
  const kept = works.slice(-limit);
  return { works: kept.map(overviewWork), omitted: works.length - kept.length };
}
