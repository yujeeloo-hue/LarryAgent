import type { OpenAiCompatibleClientConfig } from "../../llm/types.js";
import type { chatCompletionOnce } from "../../llm/openaiCompatibleClient.js";
import { agentLogInfo, agentLogWarn } from "../../logging/agentLog.js";
import { summarizeSessionForArchive } from "../../agent/contextCompaction/summarizeForArchive.js";
import type { SessionDatabase } from "../db/index.js";
import {
  completeHistoryTask,
  earliestHistoryAttemptAt,
  failHistoryTask,
  forceDueAllHistoryTasks,
  getHistoryTaskPayload,
  markHistoryTaskRunning,
  pickNextHistoryTask,
  resetRunningHistoryTasks,
  type SessionHistoryRecord,
} from "../db/index.js";

/**
 * Serial worker for the session_history summarize queue (schema v22).
 *
 * Design (mirrors the loops daemon's global-serial-by-design stance):
 * - One task at a time, FIFO by deleted_at; `pumping` guards re-entry.
 * - Every state transition is written to the DB before the next step — no
 *   in-memory queue state, so a crash at any point loses nothing.
 * - Boot: running rows flip back to pending (a crash mid-summarize simply
 *   re-runs the task; the payload lives in the row itself).
 * - Failures back off patiently (30s / 2m / 10m → hourly) and retry
 *   forever — the data is already safe in the table, there is no deadline.
 * - kick() wakes the queue on every delete and on provider-settings
 *   changes so a fixed API key resumes digestion immediately.
 */

export type ArchiveWorkerDeps = {
  db: SessionDatabase;
  /** Default-provider client (resolveClient with providerId ""). */
  resolveClient: (
    workspacePath: string,
  ) => Promise<OpenAiCompatibleClientConfig>;
  /** Fresh context limit per task (settings may change between tasks). */
  getContextLimitTokens: () => Promise<number>;
  /** Inject for tests; forwarded to summarizeSessionForArchive. */
  summarize?: typeof chatCompletionOnce;
  /** Fired after each successful summarize (memory sync kick hook, M2). */
  onTaskDone?: (sessionId: string) => void;
};

export type ArchiveWorker = {
  /** Boot: recover interrupted rows, then pump. */
  start: () => void;
  /** Wake the queue now (new delete / provider settings changed). */
  kick: () => void;
  /**
   * Force-retry everything pending now, ignoring remaining backoff —
   * boot and provider-settings changes probe the provider immediately.
   */
  retryNow: () => void;
  /** Stop timers (app shutdown / tests). In-flight writes still land. */
  stop: () => void;
};

/** Patient backoff: 30s / 2m / 10m, then hourly forever. */
export function archiveBackoffMs(attempts: number): number {
  if (attempts <= 1) return 30_000;
  if (attempts === 2) return 120_000;
  if (attempts === 3) return 600_000;
  return 3_600_000;
}

export function createArchiveWorker(deps: ArchiveWorkerDeps): ArchiveWorker {
  let pumping = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (ms: number): void => {
    if (stopped) return;
    clearTimer();
    timer = setTimeout(() => {
      void pump();
    }, ms);
    timer.unref?.();
  };

  async function processTask(task: SessionHistoryRecord): Promise<void> {
    try {
      const client = await deps.resolveClient(task.workspacePath);
      const messages = getHistoryTaskPayload(deps.db, task.id);
      const result = await summarizeSessionForArchive({
        messages,
        sessionId: task.sessionId,
        client,
        contextLimitTokens: await deps.getContextLimitTokens(),
        ...(deps.summarize ? { summarize: deps.summarize } : {}),
      });
      if (result.kind === "empty") {
        completeHistoryTask(deps.db, task.id, {
          summary: `No recorded messages. Session title: ${task.title}`,
          summarySource: "empty",
          summaryModel: null,
          inputTruncated: false,
          now: Date.now(),
        });
        deps.onTaskDone?.(task.sessionId);
        agentLogInfo("archive.task.done", {
          sessionId: task.sessionId,
          empty: true,
        });
        return;
      }
      if (result.kind === "discarded") {
        // Terminal success: keep a tombstone (audit-friendly, search-hidden).
        completeHistoryTask(deps.db, task.id, {
          summary: result.reason.trim() || "(no reason given)",
          summarySource: "discarded",
          summaryModel: client.model || null,
          inputTruncated: false,
          now: Date.now(),
        });
        deps.onTaskDone?.(task.sessionId);
        agentLogInfo("archive.task.discarded", {
          sessionId: task.sessionId,
          reason: result.reason,
        });
        return;
      }
      completeHistoryTask(deps.db, task.id, {
        summary: result.summary,
        summarySource: "llm",
        summaryModel: client.model || null,
        inputTruncated: result.inputTruncated,
        now: Date.now(),
      });
      deps.onTaskDone?.(task.sessionId);
      agentLogInfo("archive.task.done", {
        sessionId: task.sessionId,
        truncated: result.inputTruncated,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = task.attempts + 1;
      const delayMs = archiveBackoffMs(attempts);
      const recorded = failHistoryTask(deps.db, task.id, {
        attempts,
        nextAttemptAt: Date.now() + delayMs,
        error: message,
      });
      agentLogWarn("archive.task.failed", {
        sessionId: task.sessionId,
        attempts,
        retryInMs: delayMs,
        error: message,
        recorded,
      });
    }
  }

  async function pump(): Promise<void> {
    if (pumping || stopped) return;
    pumping = true;
    try {
      while (!stopped) {
        const task = pickNextHistoryTask(deps.db, Date.now());
        if (!task) {
          // Idle: wake at the earliest scheduled retry, if any.
          const next = earliestHistoryAttemptAt(deps.db);
          if (next !== null) {
            schedule(Math.max(0, next - Date.now()));
          }
          return;
        }
        if (!markHistoryTaskRunning(deps.db, task.id)) {
          continue; // lost a claim race; re-pick
        }
        await processTask(task);
      }
    } finally {
      pumping = false;
    }
  }

  return {
    start() {
      stopped = false;
      const resumed = resetRunningHistoryTasks(deps.db);
      if (resumed > 0) {
        agentLogInfo("archive.boot.resumed", { resumed });
      }
      // Boot probes once immediately instead of waiting out stale backoff.
      forceDueAllHistoryTasks(deps.db);
      void pump();
    },
    kick() {
      // Immediate wake; if a pump is already looping, its next pick-up
      // absorbs the new task — the timer is only the idle-path safety net.
      schedule(0);
      void pump();
    },
    retryNow() {
      forceDueAllHistoryTasks(deps.db);
      schedule(0);
      void pump();
    },
    stop() {
      stopped = true;
      clearTimer();
    },
  };
}
