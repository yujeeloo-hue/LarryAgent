/**
 * Memory store — the versioned cross-device memory database
 * (data/memory.db, SQLite via the built-in node:sqlite module).
 *
 * Design: docs/plans/memory-sync-design.md §3.
 *  - history_archive: plaintext archive-summary rows (session_history done).
 *  - memory_{worklog,pitfalls,style}_entry: three independent, structurally
 *    identical tables holding per-line project-memory records, encrypted
 *    client-side (record-level AES-256-GCM; the relay only ever stores and
 *    forwards opaque ciphertext).
 *  - changes: append-only global seq stream — the ONLY pull cursor source.
 *  - device_sync: per-device push/pull watermarks for the console.
 *
 * Degradation guard: node:sqlite is loaded lazily; on old Node (<22.13) the
 * relay still boots, `status()` reports {sqlite:false}, and every other
 * method fails fast with a clean error instead of crashing the process.
 */
import { mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  DOC_ENTRY_CAPS,
  MEMORY_DOC_IDS,
  isValidCipherEnvelope,
  type MemoryDocId,
} from "./memoryCipherCore.js";

// ── minimal typed surface over node:sqlite (no @types dependency) ──
interface StmtSync {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface DbSync {
  exec(sql: string): void;
  prepare(sql: string): StmtSync;
  close(): void;
}

let DatabaseSync: (new (path: string) => DbSync) | null | undefined;
function loadDatabaseSync(): (new (path: string) => DbSync) | null {
  if (DatabaseSync !== undefined) return DatabaseSync;
  try {
    // createRequire keeps it lazy: a missing/flagged module degrades to null.
    const require = createRequire(import.meta.url);
    const mod = require("node:sqlite") as { DatabaseSync: new (path: string) => DbSync };
    DatabaseSync = mod.DatabaseSync;
  } catch {
    DatabaseSync = null;
  }
  return DatabaseSync;
}

// ── row shapes ─────────────────────────────────────────────────
/** Wire envelope of one archive-summary row (client → server push). */
export interface HistoryRowInput {
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
}

export interface DocEntryInput {
  section?: string;
  ts?: number;
  entryHash: string;
  nonce: string;
  cipherText: string;
  keyVersion: string;
}

export interface PushEntryResult {
  accepted: number;
  noop: number;
  revived: number;
  tombstoned: number;
  capped: number;
}

export interface ChangeRecord {
  seq: number;
  entityType: string;
  entityId: string;
  op: string;
  payload: unknown;
  device: string;
  serverTs: number;
}

const MAX_TITLE = 512;
const MAX_SUMMARY = 32 * 1024;
const MAX_SECTION = 256;
const HISTORY_BATCH_MAX = 200;
const ENTRY_BATCH_MAX = 500;
const PULL_DEFAULT_LIMIT = 200;
const PULL_MAX_LIMIT = 500;
const SESSION_ID_MAX = 64;
const PROJECT_KEY_MAX = 256;

function str(v: unknown, max: number, fallback = ""): string {
  if (typeof v !== "string") return fallback;
  return v.length <= max ? v : v.slice(0, max);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
}

/** Canonical JSON for content hashing (key-sorted, stable). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS history_archive (
  session_id        TEXT PRIMARY KEY,
  rev               INTEGER NOT NULL,
  content_hash      TEXT NOT NULL,
  origin_device     TEXT NOT NULL,
  row_json          TEXT NOT NULL,
  server_updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_worklog_entry (
  project_key TEXT NOT NULL, entry_hash TEXT NOT NULL,
  section TEXT NOT NULL DEFAULT '', first_seq INTEGER NOT NULL, ts INTEGER NOT NULL,
  device TEXT NOT NULL, key_version TEXT NOT NULL, nonce TEXT NOT NULL, cipher_text TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, deleted_by TEXT, deleted_at INTEGER,
  PRIMARY KEY (project_key, entry_hash)
);
CREATE TABLE IF NOT EXISTS memory_pitfalls_entry (
  project_key TEXT NOT NULL, entry_hash TEXT NOT NULL,
  section TEXT NOT NULL DEFAULT '', first_seq INTEGER NOT NULL, ts INTEGER NOT NULL,
  device TEXT NOT NULL, key_version TEXT NOT NULL, nonce TEXT NOT NULL, cipher_text TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, deleted_by TEXT, deleted_at INTEGER,
  PRIMARY KEY (project_key, entry_hash)
);
CREATE TABLE IF NOT EXISTS memory_style_entry (
  project_key TEXT NOT NULL, entry_hash TEXT NOT NULL,
  section TEXT NOT NULL DEFAULT '', first_seq INTEGER NOT NULL, ts INTEGER NOT NULL,
  device TEXT NOT NULL, key_version TEXT NOT NULL, nonce TEXT NOT NULL, cipher_text TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, deleted_by TEXT, deleted_at INTEGER,
  PRIMARY KEY (project_key, entry_hash)
);
CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, rev INTEGER,
  op TEXT NOT NULL, payload TEXT, device TEXT NOT NULL, server_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_entity ON changes(entity_type, entity_id, seq);
CREATE TABLE IF NOT EXISTS device_sync (
  device_id TEXT PRIMARY KEY, key_id TEXT,
  last_push_at INTEGER, last_pull_seq INTEGER,
  last_seen_at INTEGER, ip TEXT, ua TEXT
);
`;

function entryTable(docId: MemoryDocId): string {
  return `memory_${docId}_entry`;
}

export class MemoryStore {
  readonly memoryDbPath: string;
  private db: DbSync | null = null;
  private loadError: string | null = null;

  constructor(dataDir: string) {
    this.memoryDbPath = join(dataDir, "memory.db");
    try {
      mkdirSync(dataDir, { recursive: true });
      const Ctor = loadDatabaseSync();
      if (!Ctor) {
        this.loadError = "node:sqlite unavailable (Node < 22.13?)";
        console.warn(`[jellybot-relay] memory disabled: ${this.loadError}`);
        return;
      }
      this.db = new Ctor(this.memoryDbPath);
      this.db.exec(SCHEMA);
    } catch (err) {
      this.db = null;
      this.loadError = err instanceof Error ? err.message : String(err);
      console.warn(`[jellybot-relay] memory disabled: ${this.loadError}`);
    }
  }

  get available(): boolean {
    return this.db !== null;
  }

  get unavailableReason(): string | null {
    return this.db ? null : (this.loadError ?? "memory store closed");
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private requireDb(): DbSync {
    if (!this.db) throw new Error(`memory unavailable: ${this.unavailableReason}`);
    return this.db;
  }

  // ── status / overview ────────────────────────────────────────
  status(): {
    sqlite: boolean;
    reason?: string;
    seq: number;
    historyRows: number;
    docEntries: Record<MemoryDocId, number>;
    tombstones: number;
    dbSizeBytes: number;
    devices: Array<{ deviceId: string; keyId: string | null; lastPushAt: number | null; lastPullSeq: number | null; lastSeenAt: number | null; ip: string | null }>;
  } {
    if (!this.db) {
      return {
        sqlite: false,
        reason: this.unavailableReason ?? "unknown",
        seq: 0,
        historyRows: 0,
        docEntries: { worklog: 0, pitfalls: 0, style: 0 },
        tombstones: 0,
        dbSizeBytes: 0,
        devices: [],
      };
    }
    const db = this.db;
    const seq = Number((db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM changes").get() as { s: number }).s);
    const historyRows = Number((db.prepare("SELECT COUNT(*) AS n FROM history_archive").get() as { n: number }).n);
    const docEntries = { worklog: 0, pitfalls: 0, style: 0 } as Record<MemoryDocId, number>;
    let tombstones = 0;
    for (const doc of MEMORY_DOC_IDS) {
      docEntries[doc] = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${entryTable(doc)}`).get() as { n: number }).n);
      tombstones += Number((db.prepare(`SELECT COUNT(*) AS n FROM ${entryTable(doc)} WHERE deleted = 1`).get() as { n: number }).n);
    }
    let dbSizeBytes = 0;
    try {
      dbSizeBytes = statSync(this.memoryDbPath).size;
    } catch { /* fresh file not flushed yet */ }
    const devices = (db.prepare("SELECT device_id, key_id, last_push_at, last_pull_seq, last_seen_at, ip FROM device_sync ORDER BY last_seen_at DESC").all() as Array<Record<string, unknown>>).map((r) => ({
      deviceId: String(r.device_id ?? ""),
      keyId: r.key_id == null ? null : String(r.key_id),
      lastPushAt: r.last_push_at == null ? null : Number(r.last_push_at),
      lastPullSeq: r.last_pull_seq == null ? null : Number(r.last_pull_seq),
      lastSeenAt: r.last_seen_at == null ? null : Number(r.last_seen_at),
      ip: r.ip == null ? null : String(r.ip),
    }));
    return { sqlite: true, seq, historyRows, docEntries, tombstones, dbSizeBytes, devices };
  }

  // ── device watermarks ────────────────────────────────────────
  noteDevice(deviceId: string, keyId: string | null, ip?: string, ua?: string): void {
    if (!this.db || !deviceId) return;
    this.db
      .prepare(
        `INSERT INTO device_sync (device_id, key_id, last_seen_at, ip, ua)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           key_id = excluded.key_id, last_seen_at = excluded.last_seen_at,
           ip = COALESCE(excluded.ip, device_sync.ip), ua = COALESCE(excluded.ua, device_sync.ua)`,
      )
      .run(deviceId, keyId, Date.now(), ip ?? null, ua ?? null);
  }

  notePush(deviceId: string): void {
    if (!this.db || !deviceId) return;
    this.db.prepare("UPDATE device_sync SET last_push_at = ? WHERE device_id = ?").run(Date.now(), deviceId);
  }

  notePull(deviceId: string, seq: number): void {
    if (!this.db || !deviceId) return;
    this.db
      .prepare("UPDATE device_sync SET last_pull_seq = MAX(COALESCE(last_pull_seq, 0), ?) WHERE device_id = ?")
      .run(seq, deviceId);
  }

  // ── changes stream ───────────────────────────────────────────
  private appendChange(db: DbSync, entityType: string, entityId: string, op: string, payload: string | null, device: string, rev?: number): number {
    const res = db
      .prepare("INSERT INTO changes (entity_type, entity_id, rev, op, payload, device, server_ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(entityType, entityId, rev ?? null, op, payload, device, Date.now());
    return Number(res.lastInsertRowid);
  }

  pull(since: number, limit: number): { changes: ChangeRecord[]; nextSince: number; hasMore: boolean } {
    const db = this.requireDb();
    const capped = Math.min(Math.max(1, Math.round(limit) || PULL_DEFAULT_LIMIT), PULL_MAX_LIMIT);
    const rows = db.prepare("SELECT seq, entity_type, entity_id, rev, op, payload, device, server_ts FROM changes WHERE seq > ? ORDER BY seq ASC LIMIT ?").all(since, capped) as Array<Record<string, unknown>>;
    const changes: ChangeRecord[] = rows.map((r) => {
      let payload: unknown = null;
      if (typeof r.payload === "string" && r.payload.length > 0) {
        try {
          payload = JSON.parse(r.payload);
        } catch {
          payload = r.payload;
        }
      }
      return {
        seq: Number(r.seq),
        entityType: String(r.entity_type),
        entityId: String(r.entity_id),
        op: String(r.op),
        payload,
        device: String(r.device),
        serverTs: Number(r.server_ts),
      };
    });
    const lastSeq = changes.length > 0 ? changes[changes.length - 1]!.seq : since;
    const hasMore = changes.length === capped;
    return { changes, nextSince: lastSeq, hasMore };
  }

  // ── history archive (plaintext rows) ─────────────────────────
  /**
   * Idempotent upsert by sessionId. Same content → noop; different content
   * → field arbitration keeps the more informative row (done + summary with
   * a newer summarizedAt wins, design §5), rev+1, change logged.
   */
  pushHistory(rows: unknown, device: string): { results: Array<{ sessionId: string; status: "accepted" | "noop" }>; } {
    const db = this.requireDb();
    if (!Array.isArray(rows)) throw new Error("rows must be an array");
    if (rows.length > HISTORY_BATCH_MAX) throw new Error(`batch too large (max ${HISTORY_BATCH_MAX})`);
    const results: Array<{ sessionId: string; status: "accepted" | "noop" }> = [];
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const raw of rows) {
        if (typeof raw !== "object" || raw === null) continue;
        const input = raw as HistoryRowInput;
        const sessionId = str(input.sessionId, SESSION_ID_MAX).trim();
        if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) continue;
        const row = {
          sessionId,
          title: str(input.title, MAX_TITLE, "(untitled)"),
          workspaceName: str(input.workspaceName, 256),
          workspacePath: str(input.workspacePath, 1024),
          providerId: str(input.providerId, 128),
          model: str(input.model, 128),
          deviceId: str(input.deviceId, 64),
          deviceName: str(input.deviceName, 128),
          deviceOs: str(input.deviceOs, 128),
          appVersion: str(input.appVersion, 64),
          sessionCreatedAt: num(input.sessionCreatedAt),
          sessionUpdatedAt: num(input.sessionUpdatedAt),
          firstMessageAt: typeof input.firstMessageAt === "number" && Number.isFinite(input.firstMessageAt) ? Math.round(input.firstMessageAt) : null,
          lastMessageAt: typeof input.lastMessageAt === "number" && Number.isFinite(input.lastMessageAt) ? Math.round(input.lastMessageAt) : null,
          deletedAt: num(input.deletedAt),
          summary: input.summary == null ? null : str(input.summary, MAX_SUMMARY),
          summarySource: str(input.summarySource, 32) || null,
          summaryModel: str(input.summaryModel, 128) || null,
          inputTruncated: input.inputTruncated === true,
          summarizedAt: typeof input.summarizedAt === "number" && Number.isFinite(input.summarizedAt) ? Math.round(input.summarizedAt) : null,
        };
        const contentHash = sha256Hex(canonicalJson(row));
        const existing = db.prepare("SELECT rev, content_hash, row_json FROM history_archive WHERE session_id = ?").get(sessionId) as { rev: number; content_hash: string; row_json: string } | undefined;
        if (existing && existing.content_hash === contentHash) {
          results.push({ sessionId, status: "noop" });
          continue;
        }
        if (existing) {
          // Arbitration: incoming wins only when strictly more informative.
          let prev: Partial<HistoryRowInput> = {};
          try {
            prev = JSON.parse(existing.row_json) as HistoryRowInput;
          } catch { /* keep prev empty → treat as less informative */ }
          const prevDone = prev.summarySource != null && prev.summary != null;
          const nextDone = row.summarySource != null && row.summary != null;
          const incomingBetter =
            (!prevDone && nextDone) ||
            (nextDone && (row.summarizedAt ?? 0) > (prev.summarizedAt ?? 0));
          if (!incomingBetter) {
            results.push({ sessionId, status: "noop" });
            continue;
          }
        }
        const rev = existing ? existing.rev + 1 : 1;
        const rowJson = JSON.stringify(row);
        // origin_device keeps its first-seen value: the ON CONFLICT branch
        // never touches that column, so `device` is simply ignored there.
        db.prepare(
          `INSERT INTO history_archive (session_id, rev, content_hash, origin_device, row_json, server_updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             rev = excluded.rev, content_hash = excluded.content_hash,
             row_json = excluded.row_json, server_updated_at = excluded.server_updated_at`,
        ).run(sessionId, rev, contentHash, device, rowJson, Date.now());
        this.appendChange(db, "history", sessionId, "upsert", rowJson, device, rev);
        results.push({ sessionId, status: "accepted" });
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return { results };
  }

  /**
   * Read archive rows for the console (plaintext, substring filter).
   * design §6: GET /api/console/memory/history?q=&limit=
   */
  listHistory(q: string, limit: number): Array<{ sessionId: string; rev: number; row: Partial<HistoryRowInput>; serverUpdatedAt: number; originDevice: string }> {
    const db = this.requireDb();
    const capped = Math.min(Math.max(1, Math.round(limit) || 100), 500);
    const pattern = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const rows = db
      .prepare(
        `SELECT session_id, rev, row_json, server_updated_at, origin_device FROM history_archive
         WHERE (? = '' OR row_json LIKE ? ESCAPE '\\')
         ORDER BY server_updated_at DESC LIMIT ?`,
      )
      .all(q, pattern, capped) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      let row: Partial<HistoryRowInput> = {};
      try {
        row = JSON.parse(String(r.row_json ?? "{}")) as HistoryRowInput;
      } catch { /* skip */ }
      return {
        sessionId: String(r.session_id ?? ""),
        rev: Number(r.rev ?? 0),
        row,
        serverUpdatedAt: Number(r.server_updated_at ?? 0),
        originDevice: String(r.origin_device ?? ""),
      };
    });
  }

  // ── encrypted doc entries ────────────────────────────────────
  /**
   * Entry upserts (union by entry_hash) + tombstones. Ciphertext is stored
   * as given — the relay never decrypts on this path. A push of an existing
   * hash is a noop unless it revives a tombstoned row (user re-added the
   * line); tombstones only mark, never physically delete (design §5).
   */
  pushDocEntries(
    projectKey: string,
    docId: MemoryDocId,
    entries: unknown,
    tombstones: unknown,
    device: string,
  ): PushEntryResult {
    const db = this.requireDb();
    const project = str(projectKey, PROJECT_KEY_MAX).trim();
    if (!project) throw new Error("projectKey required");
    if (!Array.isArray(entries) || entries.length > ENTRY_BATCH_MAX) {
      throw new Error(`entries must be an array (max ${ENTRY_BATCH_MAX})`);
    }
    if (!Array.isArray(tombstones)) throw new Error("tombstones must be an array");
    const table = entryTable(docId);
    const cap = DOC_ENTRY_CAPS[docId];
    const result: PushEntryResult = { accepted: 0, noop: 0, revived: 0, tombstoned: 0, capped: 0 };
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const raw of entries) {
        if (!isValidCipherEnvelope(raw)) continue;
        const env = raw;
        const ext = raw as { section?: unknown; ts?: unknown };
        const section = typeof ext.section === "string" ? str(ext.section, MAX_SECTION) : "";
        const ts = num(ext.ts) || Date.now();
        const existing = db.prepare(`SELECT deleted FROM ${table} WHERE project_key = ? AND entry_hash = ?`).get(project, env.entryHash) as { deleted: number } | undefined;
        if (existing && existing.deleted === 0) {
          result.noop += 1;
          continue;
        }
        const seq = this.appendChange(db, "doc-entry", `${project}/${docId}/${env.entryHash}`, existing ? "revive" : "upsert", JSON.stringify({ projectKey: project, docId, entryHash: env.entryHash, section, ts, nonce: env.nonce, cipherText: env.cipherText, keyVersion: env.keyVersion, deleted: 0 }), device);
        if (existing) {
          db.prepare(`UPDATE ${table} SET deleted = 0, deleted_by = NULL, deleted_at = NULL, section = ?, ts = ?, device = ? WHERE project_key = ? AND entry_hash = ?`).run(section, ts, device, project, env.entryHash);
          result.revived += 1;
        } else {
          db.prepare(
            `INSERT INTO ${table} (project_key, entry_hash, section, first_seq, ts, device, key_version, nonce, cipher_text, deleted)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          ).run(project, env.entryHash, section, seq, ts, device, env.keyVersion, env.nonce, env.cipherText);
          result.accepted += 1;
        }
      }
      for (const raw of tombstones) {
        if (typeof raw !== "object" || raw === null) continue;
        const hash = (raw as { entryHash?: unknown }).entryHash;
        if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) continue;
        const existing = db.prepare(`SELECT deleted FROM ${table} WHERE project_key = ? AND entry_hash = ?`).get(project, hash) as { deleted: number } | undefined;
        if (!existing || existing.deleted === 1) continue;
        db.prepare(`UPDATE ${table} SET deleted = 1, deleted_by = ?, deleted_at = ? WHERE project_key = ? AND entry_hash = ?`).run(device, Date.now(), project, hash);
        this.appendChange(db, "doc-tombstone", `${project}/${docId}/${hash}`, "tombstone", JSON.stringify({ projectKey: project, docId, entryHash: hash, deleted: 1 }), device);
        result.tombstoned += 1;
      }
      // Server-side cap: squeeze the oldest first_seq rows out.
      const over = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_key = ?`).get(project) as { n: number }).n) - cap;
      if (over > 0) {
        const evicted = db.prepare(`SELECT entry_hash FROM ${table} WHERE project_key = ? AND deleted = 0 ORDER BY first_seq ASC LIMIT ?`).all(project, over) as Array<{ entry_hash: string }>;
        for (const row of evicted) {
          db.prepare(`DELETE FROM ${table} WHERE project_key = ? AND entry_hash = ?`).run(project, row.entry_hash);
          this.appendChange(db, "doc-capped", `${project}/${docId}/${row.entry_hash}`, "purge", null, "server-cap");
          result.capped += 1;
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return result;
  }

  /** All entries of one doc (console view; ciphertext + clear metadata). */
  listDocEntries(projectKey: string, docId: MemoryDocId): Array<Record<string, unknown>> {
    const db = this.requireDb();
    const rows = db
      .prepare(`SELECT entry_hash, section, first_seq, ts, device, key_version, nonce, cipher_text, deleted, deleted_by, deleted_at FROM ${entryTable(docId)} WHERE project_key = ? ORDER BY first_seq ASC`)
      .all(str(projectKey, PROJECT_KEY_MAX)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      entryHash: String(r.entry_hash ?? ""),
      section: String(r.section ?? ""),
      firstSeq: Number(r.first_seq ?? 0),
      ts: Number(r.ts ?? 0),
      device: String(r.device ?? ""),
      keyVersion: String(r.key_version ?? ""),
      nonce: String(r.nonce ?? ""),
      cipherText: String(r.cipher_text ?? ""),
      deleted: Number(r.deleted ?? 0) === 1,
      deletedBy: r.deleted_by == null ? null : String(r.deleted_by),
      deletedAt: r.deleted_at == null ? null : Number(r.deleted_at),
    }));
  }

  /** Distinct projects with per-doc counts (console overview). */
  listProjects(): Array<{ projectKey: string; counts: Record<MemoryDocId, number> }> {
    const db = this.requireDb();
    const byProject = new Map<string, Record<MemoryDocId, number>>();
    for (const doc of MEMORY_DOC_IDS) {
      const rows = db.prepare(`SELECT project_key, COUNT(*) AS n FROM ${entryTable(doc)} GROUP BY project_key`).all() as Array<Record<string, unknown>>;
      for (const r of rows) {
        const key = String(r.project_key ?? "");
        const counts = byProject.get(key) ?? { worklog: 0, pitfalls: 0, style: 0 };
        counts[doc] = Number(r.n ?? 0);
        byProject.set(key, counts);
      }
    }
    return [...byProject.entries()].map(([projectKey, counts]) => ({ projectKey, counts }));
  }

  /**
   * Rotate re-key (design §4): decrypt every encrypted row with the old API
   * key, re-encrypt with the new one, single transaction. Rows the old key
   * cannot decrypt are left untouched (counted) — e.g. even older keys.
   * Returns per-table stats. Runs in-process on the relay because keys.json
   * lives here; everything else only ever sees ciphertext.
   */
  reEncryptAll(oldApiKey: string, newApiKey: string, decrypt: (docId: MemoryDocId, projectKey: string, env: { entryHash: string; nonce: string; cipherText: string; keyVersion: string }) => string | null, encrypt: (docId: MemoryDocId, projectKey: string, plaintext: string) => { nonce: string; cipherText: string; keyVersion: string }): { reEncrypted: number; skipped: number } {
    const db = this.requireDb();
    let reEncrypted = 0;
    let skipped = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const doc of MEMORY_DOC_IDS) {
        const table = entryTable(doc);
        const rows = db.prepare(`SELECT project_key, entry_hash, nonce, cipher_text, key_version FROM ${table}`).all() as Array<Record<string, unknown>>;
        for (const r of rows) {
          const projectKey = String(r.project_key ?? "");
          const env = { entryHash: String(r.entry_hash ?? ""), nonce: String(r.nonce ?? ""), cipherText: String(r.cipher_text ?? ""), keyVersion: String(r.key_version ?? "") };
          const plaintext = decrypt(doc, projectKey, env);
          if (plaintext === null) {
            skipped += 1;
            continue;
          }
          const next = encrypt(doc, projectKey, plaintext);
          db.prepare(`UPDATE ${table} SET nonce = ?, cipher_text = ?, key_version = ? WHERE project_key = ? AND entry_hash = ?`).run(next.nonce, next.cipherText, next.keyVersion, projectKey, env.entryHash);
          reEncrypted += 1;
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return { reEncrypted, skipped };
  }
}

