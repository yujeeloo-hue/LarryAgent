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


export type ArchiveWorkerDeps = {
  db: SessionDatabase;
  resolveClient: (
    workspacePath: string,
  ) => Promise<OpenAiCompatibleClientConfig>;
  getContextLimitTokens: () => Promise<number>;
  summarize?: typeof chatCompletionOnce;
  onTaskDone?: (sessionId: string) => void;
};

export type ArchiveWorker = {
  start: () => void;
  kick: () => void;
  retryNow: () => void;
  stop: () => void;
};

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
          const next = earliestHistoryAttemptAt(deps.db);
          if (next !== null) {
            schedule(Math.max(0, next - Date.now()));
          }
          return;
        }
        if (!markHistoryTaskRunning(deps.db, task.id)) {
          continue;
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
      forceDueAllHistoryTasks(deps.db);
      void pump();
    },
    kick() {
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
