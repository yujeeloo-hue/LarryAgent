/**
 * Persistent state: shared API key, device registry, audit log.
 * Deliberately zero native dependencies — JSON files + JSONL, sized for a
 * single-user relay (<10 devices, bounded audit ring).
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import type { AuditEntry, DeviceSummary, KeySummary, PromptLogEntry } from "./protocol.js";

const AUDIT_RING = 2000; // kept in memory + rewritten to file when oversized
const AUDIT_REWRITE_AT = 4000;
const PROMPT_RING = 500;
const PROMPT_REWRITE_AT = 1000;
const IP_HISTORY_MAX = 20;

export interface DeviceRecord extends DeviceSummary {}

export interface KeyRecord {
  id: string;
  name: string;
  key: string;
  createdAt: number;
}

interface KeyFileV1 {
  key: string;
  createdAt: number;
}

interface KeysFile {
  keys: KeyRecord[];
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { encoding: "utf8" });
  renameSync(tmp, path);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function newKeyId(): string {
  return randomBytes(5).toString("hex");
}

export class RelayStore {
  readonly dataDir: string;
  private keys: KeyRecord[] = [];
  private devices: Map<string, DeviceRecord> = new Map();
  private audit: AuditEntry[] = [];
  private prompts: PromptLogEntry[] = [];
  private auditPath: string;
  private promptsPath: string;
  private keysPath: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.auditPath = join(dataDir, "audit.jsonl");
    this.promptsPath = join(dataDir, "prompts.jsonl");
    this.keysPath = join(dataDir, "keys.json");
    this.loadKeys();
    this.loadDevices();
    this.loadAudit();
    this.loadPrompts();
  }

  // ── keys ───────────────────────────────────────────────────
  private loadKeys(): void {
    if (existsSync(this.keysPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.keysPath, "utf8")) as KeysFile;
        if (Array.isArray(parsed?.keys) && parsed.keys.length > 0) {
          this.keys = parsed.keys.filter((k) => k?.id && k?.key && typeof k.name === "string");
          if (this.keys.length > 0) {
            this.saveKeys();
            return;
          }
        }
      } catch {
        /* fall through to migration/fresh */
      }
    }
    // Migrate the legacy single-key file, or mint the first key.
    const legacyPath = join(this.dataDir, "api-key.json");
    let first: KeyRecord;
    if (existsSync(legacyPath)) {
      try {
        const legacy = JSON.parse(readFileSync(legacyPath, "utf8")) as KeyFileV1;
        first = {
          id: newKeyId(),
          name: "Default",
          key: legacy.key,
          createdAt: legacy.createdAt ?? Date.now(),
        };
      } catch {
        first = this.mintKey("Default");
      }
    } else {
      first = this.mintKey("Default");
    }
    this.keys = [first];
    this.saveKeys();
  }

  private mintKey(name: string): KeyRecord {
    return {
      id: newKeyId(),
      name,
      key: `jbr_${randomBytes(18).toString("hex")}`,
      createdAt: Date.now(),
    };
  }

  private saveKeys(): void {
    atomicWrite(this.keysPath, JSON.stringify({ keys: this.keys }, null, 2));
    chmodSync(this.keysPath, 0o600);
  }

  /** Constant-time check against every key; returns the matching record. */
  checkKey(candidate: string): KeyRecord | null {
    if (!candidate) return null;
    const hash = sha256(candidate);
    let match: KeyRecord | null = null;
    for (const k of this.keys) {
      try {
        if (timingSafeEqual(hash, sha256(k.key))) match = k;
      } catch {
        /* length mismatch — skip */
      }
    }
    return match;
  }

  keyById(id: string): KeyRecord | undefined {
    return this.keys.find((k) => k.id === id);
  }

  keySummaries(): KeySummary[] {
    const counts = new Map<string, number>();
    for (const d of this.devices.values()) {
      if (d.keyId) counts.set(d.keyId, (counts.get(d.keyId) ?? 0) + 1);
    }
    return this.keys.map((k) => ({
      id: k.id,
      name: k.name,
      keyTail: k.key.slice(-4),
      createdAt: k.createdAt,
      deviceCount: counts.get(k.id) ?? 0,
    }));
  }

  createKey(name: string): KeyRecord {
    const rec = this.mintKey(name.trim() || "Key");
    this.keys.push(rec);
    this.saveKeys();
    return rec;
  }

  renameKey(id: string, name: string): boolean {
    const rec = this.keyById(id);
    if (!rec) return false;
    rec.name = name.trim() || rec.name;
    this.saveKeys();
    return true;
  }

  /** Deleting is refused while it would leave zero keys. */
  deleteKey(id: string): { ok: boolean; reason?: string } {
    if (!this.keyById(id)) return { ok: false, reason: "no such key" };
    if (this.keys.length <= 1) return { ok: false, reason: "cannot delete the last key" };
    this.keys = this.keys.filter((k) => k.id !== id);
    this.saveKeys();
    return { ok: true };
  }

  rotateKeyById(id: string): KeyRecord | null {
    const rec = this.keyById(id);
    if (!rec) return null;
    rec.key = `jbr_${randomBytes(18).toString("hex")}`;
    rec.createdAt = Date.now();
    this.saveKeys();
    return rec;
  }

  get keyTail(): string {
    return this.keys[0]?.key.slice(-4) ?? "";
  }

  // ── devices ────────────────────────────────────────────────
  private loadDevices(): void {
    const path = join(this.dataDir, "devices.json");
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { devices?: DeviceRecord[] };
      for (const d of parsed?.devices ?? []) {
        if (d?.deviceId) {
          this.devices.set(d.deviceId, {
            ...d,
            online: false,
            ipHistory: Array.isArray(d.ipHistory) ? d.ipHistory : [],
          });
        }
      }
    } catch {
      /* corrupt registry — start fresh rather than crash */
    }
  }

  private saveDevices(): void {
    const path = join(this.dataDir, "devices.json");
    atomicWrite(path, JSON.stringify({ devices: [...this.devices.values()] }, null, 2));
  }

  upsertDevice(
    rec: Omit<DeviceRecord, "online" | "firstSeen" | "lastSeen" | "blocked" | "ipHistory">,
  ): DeviceRecord {
    const existing = this.devices.get(rec.deviceId);
    const now = Date.now();
    const ipHistory = mergeIpHistory(existing?.ipHistory ?? [], rec.ip);
    const next: DeviceRecord = existing
      ? {
          ...existing,
          ...rec,
          ip: rec.ip ?? existing.ip,
          ua: rec.ua ?? existing.ua,
          // A reconnect that advertises nothing (older build) must not wipe
          // the caps a newer build left behind.
          caps: rec.caps ?? existing.caps,
          ipHistory,
          online: true,
          lastSeen: now,
        }
      : { ...rec, ip: rec.ip, ua: rec.ua, ipHistory, online: true, firstSeen: now, lastSeen: now, blocked: false };
    this.devices.set(rec.deviceId, next);
    this.saveDevices();
    return next;
  }

  markSeen(deviceId: string): void {
    const rec = this.devices.get(deviceId);
    if (rec) {
      rec.lastSeen = Date.now();
      this.saveDevices();
    }
  }

  markOffline(deviceId: string): void {
    const rec = this.devices.get(deviceId);
    if (rec && rec.online) {
      rec.online = false;
      rec.lastSeen = Date.now();
      this.saveDevices();
    }
  }

  setBlocked(deviceId: string, blocked: boolean): boolean {
    const rec = this.devices.get(deviceId);
    if (!rec) return false;
    rec.blocked = blocked;
    this.saveDevices();
    return true;
  }

  removeDevice(deviceId: string): boolean {
    if (!this.devices.has(deviceId)) return false;
    this.devices.delete(deviceId);
    this.saveDevices();
    return true;
  }

  isBlocked(deviceId: string): boolean {
    return this.devices.get(deviceId)?.blocked ?? false;
  }

  deviceSummaries(): DeviceSummary[] {
    return [...this.devices.values()].map((d) => ({
      ...d,
      keyName: d.keyId ? (this.keyById(d.keyId)?.name ?? undefined) : undefined,
    }));
  }

  // ── audit ──────────────────────────────────────────────────
  private loadAudit(): void {
    this.audit = this.loadJsonl<AuditEntry>(this.auditPath, AUDIT_RING);
  }

  appendAudit(entry: AuditEntry): void {
    this.appendJsonl(this.audit, this.auditPath, entry, AUDIT_RING, AUDIT_REWRITE_AT);
  }

  recentAudit(limit = 200): AuditEntry[] {
    return this.audit.slice(-limit).reverse();
  }

  /** Wipe the audit ring (memory + jsonl). The caller re-appends the
     "auditClear" entry itself so the wipe stays attributable. */
  clearAudit(): void {
    this.audit = [];
    atomicWrite(this.auditPath, "");
  }

  // ── remote prompts ─────────────────────────────────────────
  private loadPrompts(): void {
    this.prompts = this.loadJsonl<PromptLogEntry>(this.promptsPath, PROMPT_RING);
  }

  appendPrompt(entry: PromptLogEntry): void {
    this.appendJsonl(this.prompts, this.promptsPath, entry, PROMPT_RING, PROMPT_REWRITE_AT);
  }

  recentPrompts(limit = 200): PromptLogEntry[] {
    return this.prompts.slice(-limit).reverse();
  }

  // ── JSONL helpers ──────────────────────────────────────────
  private loadJsonl<T>(path: string, ring: number): T[] {
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const start = Math.max(0, lines.length - ring);
    const out: T[] = [];
    for (const line of lines.slice(start)) {
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        /* skip broken line */
      }
    }
    return out;
  }

  private appendJsonl<T>(list: T[], path: string, entry: T, ring: number, rewriteAt: number): void {
    list.push(entry);
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
    if (list.length >= rewriteAt) {
      list.splice(0, list.length - ring);
      // Full rewrite keeps the file bounded.
      atomicWrite(path, list.map((e) => JSON.stringify(e)).join("\n") + "\n");
    }
  }
}

/** Merge a connection's IP into the newest-first history (same-IP refreshes ts). */
function mergeIpHistory(
  history: Array<{ ip: string; ts: number }>,
  ip: string | undefined,
): Array<{ ip: string; ts: number }> {
  const next = history.filter((h) => h && typeof h.ip === "string");
  if (!ip) return next;
  if (next[0]?.ip === ip) {
    next[0] = { ip, ts: Date.now() };
    return next;
  }
  next.unshift({ ip, ts: Date.now() });
  return next.slice(0, IP_HISTORY_MAX);
}

export function dataDirDefault(): string {
  const env = process.env.RELAY_DATA_DIR;
  if (env && env.trim()) return env;
  const cwd = process.cwd();
  const marker = join(cwd, "package.json");
  if (existsSync(marker)) return join(dirname(marker), "data");
  return join(cwd, "data");
}
