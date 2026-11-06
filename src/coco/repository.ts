import type { DatabaseSync } from "node:sqlite";
import type { CocoHistoryPage, CocoLegacyRun } from "./types.js";

/** Same connection as session checkpoints; no second database to partially commit. */
export class CocoRepository {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS coco_records (
      kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS coco_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coco_runtime_lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);`);
    db.exec("CREATE INDEX IF NOT EXISTS coco_record_time ON coco_records(kind,json_extract(payload,'$.at'))");
    db.exec("CREATE INDEX IF NOT EXISTS coco_record_status ON coco_records(kind,json_extract(payload,'$.status'))");
    db.exec("CREATE INDEX IF NOT EXISTS coco_record_work ON coco_records(kind,json_extract(payload,'$.workId'))");
    db.exec("CREATE INDEX IF NOT EXISTS coco_legacy_history ON coco_records(kind,json_extract(payload,'$.ruleId'),json_extract(payload,'$.startedAt'),id)");
  }
  list<T>(kind: string): T[] {
    return (this.db.prepare("SELECT payload FROM coco_records WHERE kind=? ORDER BY rowid").all(kind) as { payload: string }[]).map(r => JSON.parse(r.payload) as T);
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare("SELECT payload FROM coco_records WHERE kind=? AND id=?").get(kind, id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as T : undefined;
  }
  forWork<T>(kind: string, workId: string): T[] {
    return (this.db.prepare("SELECT payload FROM coco_records WHERE kind=? AND json_extract(payload,'$.workId')=? ORDER BY rowid").all(kind, workId) as { payload: string }[]).map(row => JSON.parse(row.payload) as T);
  }
  since<T>(kind: string, at: number): T[] {
    return (this.db.prepare("SELECT payload FROM coco_records WHERE kind=? AND json_extract(payload,'$.at')>=? ORDER BY rowid").all(kind, at) as { payload:string }[]).map(r=>JSON.parse(r.payload) as T);
  }
  pending<T>(kind: string): T[] {
    return (this.db.prepare("SELECT payload FROM coco_records WHERE kind=? AND json_extract(payload,'$.status') IN ('queued','running') ORDER BY rowid").all(kind) as { payload:string }[]).map(r=>JSON.parse(r.payload) as T);
  }
  history(ruleId: string, cursor?: { at: number; id: string }): CocoHistoryPage {
    if (typeof ruleId !== "string" || !ruleId || (cursor && (!Number.isSafeInteger(cursor.at) || typeof cursor.id !== "string"))) throw new Error("Invalid history cursor");
    const rows = this.db.prepare("SELECT payload FROM coco_records WHERE kind='legacyRun' AND json_extract(payload,'$.ruleId')=? AND (json_extract(payload,'$.startedAt')<? OR (json_extract(payload,'$.startedAt')=? AND id<?)) ORDER BY json_extract(payload,'$.startedAt') DESC,id DESC LIMIT 31").all(ruleId, cursor?.at ?? Number.MAX_SAFE_INTEGER, cursor?.at ?? Number.MAX_SAFE_INTEGER, cursor?.id ?? "");
    const runs = rows.slice(0,30).map(r => JSON.parse(String(r.payload)) as CocoLegacyRun), last = runs.at(-1);
    return { runs, ...(rows.length > 30 && last ? { nextCursor:{ at:last.startedAt, id:last.id } } : {}) };
  }
  put<T extends { id: string }>(kind: string, value: T): T {
    if (kind === "work") {
      const revision = (value as T & { revision?: number }).revision;
      if (Number.isSafeInteger(revision)) this.db.prepare("INSERT OR IGNORE INTO coco_records(kind,id,payload) VALUES('workRevision',?,?)").run(`${value.id}:${revision}`, JSON.stringify(value));
    }
    this.db.prepare("INSERT INTO coco_records(kind,id,payload) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload").run(kind, value.id, JSON.stringify(value));
    return value;
  }
  /** Newest-first archived memory entries whose text contains every term (case-insensitive). */
  searchMemoryArchive<T>(terms: string[], limit: number): T[] {
    const where = terms.map(() => " AND lower(json_extract(payload,'$.text')) LIKE ? ESCAPE '\\'").join("");
    const args = terms.map(t => `%${t.toLowerCase().replace(/[\\%_]/g, c => `\\${c}`)}%`);
    return (this.db.prepare(`SELECT payload FROM coco_records WHERE kind='memoryArchive'${where} ORDER BY json_extract(payload,'$.at') DESC, rowid DESC LIMIT ?`).all(...args, limit) as { payload: string }[]).map(r => JSON.parse(r.payload) as T);
  }
  remove(kind: string, id: string): void { this.db.prepare("DELETE FROM coco_records WHERE kind=? AND id=?").run(kind, id); }
  meta<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value FROM coco_meta WHERE key=?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : fallback;
  }
  setMeta(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO coco_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  acquireLease(owner: string, now: number): boolean {
    this.db.prepare("INSERT INTO coco_runtime_lease(id,owner,expires_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE coco_runtime_lease.expires_at<=? OR coco_runtime_lease.owner=?").run(owner, now + 15000, now, owner);
    return this.ownsLease(owner, now);
  }
  ownsLease(owner: string, now: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM coco_runtime_lease WHERE id=1 AND owner=? AND expires_at>?").get(owner, now);
  }
  renewLease(owner: string, now: number): boolean {
    this.db.prepare("UPDATE coco_runtime_lease SET expires_at=? WHERE id=1 AND owner=?").run(now + 15000, owner);
    return this.ownsLease(owner, now);
  }
  releaseLease(owner: string): void { this.db.prepare("DELETE FROM coco_runtime_lease WHERE id=1 AND owner=?").run(owner); }
}
