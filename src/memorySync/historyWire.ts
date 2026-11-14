/**
 * Memory sync — pure core for the archive (history) channel (M2).
 *
 * The wire shape mirrors `relay/src/memory.ts HistoryRowInput` structurally
 * (camelCase) but is declared here on purpose: the relay module pulls in
 * node:sqlite and must never enter the Electron client bundle. If the
 * server-side envelope changes, update both.
 *
 * Docs: docs/plans/memory-sync-design.md §6–7.
 */
import type { SessionHistoryRecord } from "../session/db/index.js";

/** Wire envelope of one archive-summary row (client → server push). */
export type HistoryWireRow = {
  sessionId: string;
  title: string;
  workspaceName?: string;
  workspacePath?: string;
  providerId?: string;
  model?: string;
  deviceId?: string;
  deviceName?: string;
  deviceOs?: string;
  appVersion?: string;
  sessionCreatedAt?: number;
  sessionUpdatedAt?: number;
  firstMessageAt?: number | null;
  lastMessageAt?: number | null;
  deletedAt?: number;
  summary?: string | null;
  summarySource?: string | null;
  summaryModel?: string | null;
  inputTruncated?: boolean;
  summarizedAt?: number | null;
};

/** Server-side hard limits (memory.ts): batch 200 rows per push. */
export const HISTORY_PUSH_BATCH = 200;

/** Local → wire (push direction). Drops queue-internal fields. */
export function toHistoryWireRow(record: SessionHistoryRecord): HistoryWireRow {
  return {
    sessionId: record.sessionId,
    title: record.title,
    workspaceName: record.workspaceName,
    workspacePath: record.workspacePath,
    providerId: record.providerId,
    model: record.model,
    deviceId: record.deviceId,
    deviceName: record.deviceName,
    deviceOs: record.deviceOs,
    appVersion: record.appVersion,
    sessionCreatedAt: record.sessionCreatedAt,
    sessionUpdatedAt: record.sessionUpdatedAt,
    firstMessageAt: record.firstMessageAt,
    lastMessageAt: record.lastMessageAt,
    deletedAt: record.deletedAt,
    summary: record.summary,
    summarySource: record.summarySource,
    summaryModel: record.summaryModel,
    inputTruncated: record.inputTruncated,
    summarizedAt: record.summarizedAt,
  };
}

/** Shape accepted by upsertHistoryFromRemote (local merge direction). */
export type RemoteHistoryRow = {
  sessionId: string;
  title: string;
  workspaceName: string;
  workspacePath: string;
  providerId: string;
  model: string;
  deviceId: string;
  deviceName: string;
  deviceOs: string;
  appVersion: string;
  sessionCreatedAt: number;
  sessionUpdatedAt: number;
  firstMessageAt: number | null;
  lastMessageAt: number | null;
  deletedAt: number;
  summary: string | null;
  summarySource: string | null;
  summaryModel: string | null;
  inputTruncated: boolean;
  summarizedAt: number | null;
};

/** Relay sessionId constraint (memory.ts): 1–64 of [A-Za-z0-9_-]. */
export function isRelaySessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function wireStr(v: unknown, max: number, fallback = ""): string {
  if (typeof v !== "string") return fallback;
  return v.length <= max ? v : v.slice(0, max);
}

function wireNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
}

function wireNumOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

/**
 * Wire → merge input (pull direction). Unknown/malformed rows are rejected
 * with a reason instead of throwing — one bad payload must never kill the
 * sync cycle; the orchestrator counts and skips them.
 */
export function fromHistoryWireRow(
  wire: unknown,
): { ok: true; row: RemoteHistoryRow } | { ok: false; reason: string } {
  if (typeof wire !== "object" || wire === null || Array.isArray(wire)) {
    return { ok: false, reason: "not an object" };
  }
  const w = wire as Record<string, unknown>;
  if (!isRelaySessionId(w.sessionId)) {
    return { ok: false, reason: "bad sessionId" };
  }
  return {
    ok: true,
    row: {
      sessionId: w.sessionId,
      title: wireStr(w.title, 512, "(untitled)"),
      workspaceName: wireStr(w.workspaceName, 256),
      workspacePath: wireStr(w.workspacePath, 1024),
      providerId: wireStr(w.providerId, 128),
      model: wireStr(w.model, 128),
      deviceId: wireStr(w.deviceId, 64),
      deviceName: wireStr(w.deviceName, 128),
      deviceOs: wireStr(w.deviceOs, 128),
      appVersion: wireStr(w.appVersion, 64),
      sessionCreatedAt: wireNum(w.sessionCreatedAt),
      sessionUpdatedAt: wireNum(w.sessionUpdatedAt),
      firstMessageAt: wireNumOrNull(w.firstMessageAt),
      lastMessageAt: wireNumOrNull(w.lastMessageAt),
      deletedAt: wireNum(w.deletedAt),
      summary: w.summary == null ? null : wireStr(w.summary, 32 * 1024),
      summarySource: wireStr(w.summarySource, 32) || null,
      summaryModel: wireStr(w.summaryModel, 128) || null,
      inputTruncated: w.inputTruncated === true,
      summarizedAt: wireNumOrNull(w.summarizedAt),
    },
  };
}

/** Split rows into ≤batch push payloads (server cap 200/request). */
export function planPushBatches<T>(rows: T[], batch = HISTORY_PUSH_BATCH): T[][] {
  if (rows.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += batch) {
    out.push(rows.slice(i, i + batch));
  }
  return out;
}

/** One row of the relay changes feed (subset the client cares about). */
export type WireChange = {
  seq: number;
  entityType: string;
  entityId: string;
  op: string;
  payload: unknown;
};

/**
 * Partition a pull page into history changes (M2) and everything else.
 * doc-entry / doc-tombstone / purge changes are counted and skipped —
 * they light up in M3, never break the archive channel.
 */
export function selectHistoryChanges(
  changes: WireChange[],
): { history: WireChange[]; others: number } {
  const history: WireChange[] = [];
  let others = 0;
  for (const change of changes) {
    if (change.entityType === "history") history.push(change);
    else others += 1;
  }
  return { history, others };
}
