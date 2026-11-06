/**
 * Memory sync engine — thin IO shell around the pure wire core (M2:
 * archive channel). Push local done rows (pushed_at = 0) to the relay,
 * pull the changes feed and merge remote rows back, tracking the cursor
 * per serverUrl+deviceId island in `memory_sync_state` (schema v24).
 *
 * Scheduling mirrors the archive worker's stance: serial by design,
 * patient backoff (30s / 2m / 10m → hourly), never blocks anything.
 * Docs: docs/plans/memory-sync-design.md §7.
 */
import { randomUUID } from "node:crypto";
import type { SessionDatabase } from "../session/db/index.js";
import {
  loadUnpushedHistory,
  markHistoryPushed,
  upsertHistoryFromRemote,
  resetAllHistoryPushed,
  getMemorySyncState,
  setMemorySyncState,
} from "../session/db/index.js";
import {
  toHistoryWireRow,
  fromHistoryWireRow,
  planPushBatches,
  selectHistoryChanges,
  type WireChange,
} from "./historyWire.js";

/** What the engine needs to know about the current remote config. */
export type MemorySyncConfig = {
  /** Base origin as configured for the WS bridge (`wss://host[/path]`). */
  serverUrl: string;
  deviceId: string;
  deviceName: string;
};

export type SyncOutcome = {
  kind: "ok" | "error" | "off";
  reason?: string;
  pushed: number;
  inserted: number;
  updated: number;
  skipped: number;
  badRows: number;
  others: number;
  nextSince: number;
  ranAt: number;
};

export type MemorySyncStatusLine = {
  lastRunAt: number | null;
  lastResult: "ok" | "error" | "off" | null;
  lastError: string | null;
  pushed: number;
  inserted: number;
  updated: number;
  cursor: number;
  pendingPush: number;
};

export type MemorySyncDeps = {
  db: SessionDatabase;
  /** null/undefined when memory sync is off or relay is unconfigured. */
  getSyncConfig: () => Promise<MemorySyncConfig | null>;
  getApiKey: () => Promise<string | null>;
  appVersion: () => string;
  fetchImpl?: typeof fetch;
  newId?: () => string;
  now?: () => number;
  log?: (level: "info" | "warn", event: string, data?: Record<string, unknown>) => void;
};

/** Patient backoff, same ladder as the archive worker. */
export function memorySyncBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 1) return 30_000;
  if (consecutiveFailures === 2) return 120_000;
  if (consecutiveFailures === 3) return 600_000;
  return 3_600_000;
}

/** `wss://host/path` → `https://host/path` (strip trailing slash). */
export function restBase(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, "");
  return trimmed
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://")
    .replace(/^http:\/\//i, "http://")
    .replace(/^https:\/\//i, "https://");
}

function islandKey(config: MemorySyncConfig): string {
  return `${config.serverUrl.trim().replace(/\/+$/, "")}|${config.deviceId}`;
}

const STATUS_KEY = "status";
const cursorKey = (island: string): string => `cursor:${island}`;

/** Max rows pushed per cycle (3 server batches); the rest ride the next tick. */
const PUSH_ROWS_PER_CYCLE = 600;
const PULL_LIMIT = 200;
const BOOT_DELAY_MS = 30_000;
const TICK_MS = 5 * 60_000;

export function createMemorySync(deps: MemorySyncDeps) {
  const db = deps.db;
  const doFetch = deps.fetchImpl ?? fetch;
  const newId = deps.newId ?? (() => randomUUID());
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});

  let running = false;
  let dirty = false;
  let stopped = true;
  let failures = 0;
  let bootTimer: ReturnType<typeof setTimeout> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let nextAttemptAt = 0;

  const writeStatus = (outcome: SyncOutcome): void => {
    setMemorySyncState(
      db,
      STATUS_KEY,
      JSON.stringify({
        lastRunAt: outcome.ranAt,
        lastResult: outcome.kind,
        lastError: outcome.reason ?? null,
        pushed: outcome.pushed,
        inserted: outcome.inserted,
        updated: outcome.updated,
        cursor: outcome.nextSince,
      }),
    );
  };

  const readStatus = (): MemorySyncStatusLine => {
    const raw = getMemorySyncState(db, STATUS_KEY);
    if (!raw) {
      return {
        lastRunAt: null, lastResult: null, lastError: null,
        pushed: 0, inserted: 0, updated: 0, cursor: 0,
        pendingPush: loadUnpushedHistory(db, 1_000_000).length,
      };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<MemorySyncStatusLine> & { cursor?: number };
      return {
        lastRunAt: parsed.lastRunAt ?? null,
        lastResult: parsed.lastResult ?? null,
        lastError: parsed.lastError ?? null,
        pushed: parsed.pushed ?? 0,
        inserted: parsed.inserted ?? 0,
        updated: parsed.updated ?? 0,
        cursor: parsed.cursor ?? 0,
        pendingPush: loadUnpushedHistory(db, 1_000_000).length,
      };
    } catch {
      return {
        lastRunAt: null, lastResult: null, lastError: "corrupt status",
        pushed: 0, inserted: 0, updated: 0, cursor: 0,
        pendingPush: loadUnpushedHistory(db, 1_000_000).length,
      };
    }
  };

  async function apiPost<T>(
    base: string,
    apiKey: string,
    deviceId: string,
    path: string,
    body: unknown,
  ): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        ...(typeof body === "object" && body !== null ? body : {}),
        deviceId,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${path} → HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async function pushAll(
    base: string,
    apiKey: string,
    deviceId: string,
    outcome: SyncOutcome,
  ): Promise<void> {
    const rows = loadUnpushedHistory(db, PUSH_ROWS_PER_CYCLE);
    if (rows.length === 0) return;
    for (const batch of planPushBatches(rows)) {
      await apiPost<{ results: Array<{ sessionId: string; status: string }> }>(
        base, apiKey, deviceId,
        "/api/memory/history:push",
        { rows: batch.map(toHistoryWireRow) },
      );
    }
    // Server "noop" still means the content is there — mark everything sent.
    markHistoryPushed(db, rows.map((row) => row.sessionId), now());
    outcome.pushed += rows.length;
  }

  async function pullAll(
    base: string,
    apiKey: string,
    deviceId: string,
    island: string,
    outcome: SyncOutcome,
  ): Promise<void> {
    let since = Number(getMemorySyncState(db, cursorKey(island))) || 0;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = await apiPost<{
        changes: WireChange[];
        nextSince: number;
        hasMore: boolean;
      }>(base, apiKey, deviceId, "/api/memory/pull", { since, limit: PULL_LIMIT });
      const { history, others } = selectHistoryChanges(page.changes ?? []);
      outcome.others += others;
      for (const change of history) {
        const parsed = fromHistoryWireRow(change.payload);
        if (!parsed.ok) {
          outcome.badRows += 1;
          continue;
        }
        const merged = upsertHistoryFromRemote(
          db,
          parsed.row,
          { newId: newId(), now: now() },
        );
        if (merged === "inserted") outcome.inserted += 1;
        else if (merged === "updated") outcome.updated += 1;
        else outcome.skipped += 1;
      }
      since = page.nextSince ?? since;
      setMemorySyncState(db, cursorKey(island), String(since));
      outcome.nextSince = since;
      if (!page.hasMore) break;
    }
  }

  async function run(reason: string): Promise<SyncOutcome> {
    const outcome: SyncOutcome = {
      kind: "ok", pushed: 0, inserted: 0, updated: 0, skipped: 0,
      badRows: 0, others: 0, nextSince: 0, ranAt: now(),
    };
    const config = await deps.getSyncConfig();
    if (!config) {
      outcome.kind = "off";
      writeStatus(outcome);
      return outcome;
    }
    const apiKey = await deps.getApiKey();
    if (!apiKey) {
      outcome.kind = "error";
      outcome.reason = "No relay API key saved";
      writeStatus(outcome);
      return outcome;
    }
    const base = restBase(config.serverUrl);
    try {
      await pushAll(base, apiKey, config.deviceId, outcome);
      await pullAll(base, apiKey, config.deviceId, islandKey(config), outcome);
      failures = 0;
      nextAttemptAt = 0;
      log("info", "memorySync.ok", {
        reason, pushed: outcome.pushed, inserted: outcome.inserted,
        updated: outcome.updated, cursor: outcome.nextSince,
      });
    } catch (err) {
      outcome.kind = "error";
      outcome.reason = err instanceof Error ? err.message : String(err);
      failures += 1;
      nextAttemptAt = now() + memorySyncBackoffMs(failures);
      log("warn", "memorySync.failed", {
        reason, error: outcome.reason, retryInMs: memorySyncBackoffMs(failures),
      });
    }
    writeStatus(outcome);
    return outcome;
  }

  async function syncOnce(reason: string): Promise<SyncOutcome> {
    // Manual syncs bypass the backoff gate but still respect serialization.
    while (running) {
      dirty = true;
      // The in-flight cycle will re-run once it finishes (dirty loop below).
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    running = true;
    dirty = false;
    try {
      let outcome = await run(reason);
      // A kick that landed mid-cycle gets honored with one immediate rerun.
      let reruns = 0;
      while (dirty && outcome.kind !== "off" && reruns < 2) {
        dirty = false;
        outcome = await run(`${reason}+rerun`);
        reruns += 1;
      }
      return outcome;
    } finally {
      running = false;
    }
  }

  function kick(reason = "kick"): void {
    if (stopped) return;
    void syncOnce(reason).catch(() => {});
  }

  return {
    /** Manual / IPC-triggered sync (awaits the result for the status line). */
    syncOnce,
    /** Fire-and-forget wake (archive worker hook, timer tick). */
    kick,
    /** Boot: first run after 30s, then every 5 minutes. */
    start() {
      stopped = false;
      bootTimer = setTimeout(() => kick("boot"), BOOT_DELAY_MS);
      bootTimer.unref?.();
      tickTimer = setInterval(() => {
        if (stopped) return;
        if (nextAttemptAt > now()) return; // patient backoff gate
        kick("tick");
      }, TICK_MS);
      tickTimer.unref?.();
    },
    stop() {
      stopped = true;
      if (bootTimer) clearTimeout(bootTimer);
      if (tickTimer) clearInterval(tickTimer);
      bootTimer = null;
      tickTimer = null;
    },
    /** Zero the cursor + re-push every done row (server is idempotent). */
    async fullResync(): Promise<SyncOutcome> {
      const reset = resetAllHistoryPushed(db);
      const config = await deps.getSyncConfig();
      if (config) {
        setMemorySyncState(db, cursorKey(islandKey(config)), "0");
      }
      log("info", "memorySync.fullResync", { resetRows: reset });
      return syncOnce("full-resync");
    },
    /** Snapshot for the Settings status line. */
    status: readStatus,
  };
}

export type MemorySync = ReturnType<typeof createMemorySync>;
