/**
 * Skill Hub store. Skill metadata (name/enabled/description/file count) is
 * queryable; the whole skill package — a zip of SKILL.md plus supporting
 * files — is an AES-256-GCM envelope. The database file never contains a
 * SKILL.md body, a supporting file name or any zip bytes in plaintext.
 *
 * Mirrors McpHubStore's shape so the console reuses its UX. SKILL.md
 * frontmatter is regenerated from the columns on every write, so the Hub
 * description is the single source of truth for both the console card and the
 * package that lands on a device.
 */
import AdmZip from "adm-zip";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { decryptHubSecret, encryptHubSecret } from "./tokenHubCipher.js";

interface StmtSync {
  run(...params: unknown[]): { changes: number | bigint };
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
    const require = createRequire(import.meta.url);
    const mod = require("node:sqlite") as { DatabaseSync: new (path: string) => DbSync };
    DatabaseSync = mod.DatabaseSync;
  } catch {
    DatabaseSync = null;
  }
  return DatabaseSync;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skill (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  file_count INTEGER NOT NULL DEFAULT 0,
  zip_nonce TEXT NOT NULL,
  zip_cipher TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_order (
  skill_id TEXT PRIMARY KEY,
  sort_index INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS device_skill (
  device_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  PRIMARY KEY (device_id, skill_id)
);
`;

export const SKILL_HUB_LIMITS = {
  name: 64,
  project: 64,
  description: 1024,
  body: 256 * 1024,
  zipBytes: 8 * 1024 * 1024,
  files: 200,
} as const;

const SKILL_MD = "SKILL.md";

export type SkillHubFileEntry = { path: string; size: number };

export type SkillHubPublicSkill = {
  id: string;
  name: string;
  enabled: boolean;
  description: string;
  /** Owning project slug; empty = universal. */
  project: string;
  fileCount: number;
  createdAt: number;
};

export type SkillHubSnapshot = {
  skills: SkillHubPublicSkill[];
  deviceSkillIds: Record<string, string[]>;
};

export type SkillHubDetail = SkillHubPublicSkill & {
  body: string;
  files: SkillHubFileEntry[];
};

/** Server-only transfer shape — the whole package, never returned on GET. */
export type SkillZipTransfer = {
  id: string;
  name: string;
  enabled: boolean;
  description: string;
  project: string;
  zipBase64: string;
};

export type SkillHubInput = {
  name: string;
  description: string;
  body: string;
  enabled?: boolean;
  /** Owning project slug; empty / omitted = universal. */
  project?: string;
};

export type SkillHubUpdatePatch = {
  name?: string;
  description?: string;
  body?: string;
  enabled?: boolean;
  project?: string;
};

export type SkillHubUpsertInput = {
  name: string;
  enabled: boolean;
  /** Optional description hint; the package frontmatter wins when present. */
  description?: string;
  /** Optional scope hint; the package frontmatter wins when present. */
  project?: string;
  zipBase64: string;
};

type SkillRow = {
  id: string;
  name: string;
  enabled: number;
  description: string;
  project: string;
  file_count: number;
  zip_nonce: string;
  zip_cipher: string;
  created_at: number;
};

export class SkillHubOrderConflictError extends Error {
  constructor() {
    super("Skills changed. Refresh the list and try again.");
    this.name = "SkillHubOrderConflictError";
  }
}

export function skillHubMatchKey(name: string): string {
  return name.trim().toLowerCase();
}

export function assertSkillHubName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (
    !name ||
    name.length > SKILL_HUB_LIMITS.name ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
  ) {
    throw new Error(
      "Skill name must be a lowercase slug (letters, numbers, hyphens; max 64).",
    );
  }
  return name;
}

function clampDescription(raw: string): string {
  return raw.trim().slice(0, SKILL_HUB_LIMITS.description);
}

/** Project slug: lowercased folder-name form; blank / "*" = universal (""). */
function clampProject(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const one = raw.trim().toLowerCase();
  if (!one || one === "*" || one === "universal" || one === "all") return "";
  return one
    .replace(/[\s/\\]+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "")
    .slice(0, SKILL_HUB_LIMITS.project);
}

function unquoteYamlScalar(raw: string): string {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    const inner = value.slice(1, -1);
    if (value.startsWith('"')) {
      return inner
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    return inner.replace(/''/g, "'");
  }
  return value;
}

function yamlScalar(value: string): string {
  if (
    value === "" ||
    /[:#{}[\],&*!|>'"%@`]/.test(value) ||
    /^\s|\s$/.test(value) ||
    value.includes("\n")
  ) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  }
  return value;
}

function serializeSkillMarkdown(input: {
  name: string;
  description: string;
  body: string;
  project?: string;
}): string {
  const body = input.body.replace(/^\s+/, "").replace(/\s+$/, "");
  const project = clampProject(input.project);
  const lines = [
    "---",
    `name: ${yamlScalar(input.name)}`,
    `description: ${yamlScalar(input.description)}`,
    ...(project ? [`project: ${yamlScalar(project)}`] : []),
    "---",
    "",
  ];
  if (body) lines.push(body, "");
  return lines.join("\n");
}

/** Minimal SKILL.md reader — description, body and project scope. */
function parseSkillMarkdown(raw: string): {
  description: string;
  body: string;
  project: string;
} {
  const text = raw.replace(/^\uFEFF/, "");
  const empty = { description: "", body: text.replace(/\s+$/, ""), project: "" };
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("---")) return empty;
  const afterOpen = trimmed.slice(3);
  const nl = afterOpen.search(/\r?\n/);
  if (nl < 0) return empty;
  const rest = afterOpen.slice(nl + (afterOpen[nl] === "\r" ? 2 : 1));
  const close = rest.match(/\r?\n---\s*(?:\r?\n|$)/);
  if (!close || close.index === undefined) return empty;
  const front = rest.slice(0, close.index);
  const body = rest
    .slice(close.index + close[0].length)
    .replace(/^\s+/, "")
    .replace(/\s+$/, "");
  let description = "";
  let project = "";
  for (const line of front.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = (match[1] ?? "").toLowerCase();
    if (key === "description") description = unquoteYamlScalar(match[2] ?? "");
    if (key === "project") project = clampProject(unquoteYamlScalar(match[2] ?? ""));
  }
  return { description: clampDescription(description), body, project };
}

function assertZipEntryPath(entryName: string): string {
  const name = entryName.replace(/\\/g, "/");
  if (!name || name.includes("\0")) {
    throw new Error("Package contains an invalid entry name.");
  }
  if (name.startsWith("/") || /^[A-Za-z]:\//.test(name)) {
    throw new Error("Package entries must be relative paths.");
  }
  const parts = name.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === ".." || part === ".")) {
    throw new Error("Package entries must stay inside the skill directory.");
  }
  return parts.join("/");
}

type NormalizedPackage = {
  zipBuffer: Buffer;
  description: string;
  body: string;
  project: string;
  files: SkillHubFileEntry[];
};

/**
 * Validate an inbound zip: entry names, a single root SKILL.md, size and file
 * count budgets. Throws user-facing messages on anything unusable.
 */
export function normalizeSkillPackage(zipBase64: string): NormalizedPackage {
  if (typeof zipBase64 !== "string" || !zipBase64.trim()) {
    throw new Error("Skill package is required.");
  }
  const zipBuffer = Buffer.from(zipBase64, "base64");
  if (zipBuffer.byteLength === 0) throw new Error("Skill package is empty.");
  if (zipBuffer.byteLength > SKILL_HUB_LIMITS.zipBytes) {
    throw new Error("Skill package is too large (max 8 MB).");
  }
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch {
    throw new Error("Skill package is not a valid zip.");
  }
  let skillMd: AdmZip.IZipEntry | null = null;
  const files: SkillHubFileEntry[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (entry.entryName.startsWith("__MACOSX/")) continue;
    const path = assertZipEntryPath(entry.entryName);
    if (path === SKILL_MD) {
      if (skillMd) throw new Error("Skill package must contain exactly one SKILL.md.");
      skillMd = entry;
      continue;
    }
    files.push({ path, size: entry.header.size });
  }
  if (!skillMd) throw new Error("Skill package must contain SKILL.md at its root.");
  if (files.length > SKILL_HUB_LIMITS.files) {
    throw new Error(`Skill package has too many files (max ${SKILL_HUB_LIMITS.files}).`);
  }
  const parsed = parseSkillMarkdown(skillMd.getData().toString("utf8"));
  if (!parsed.description) {
    throw new Error("SKILL.md is missing a description in its frontmatter.");
  }
  if (parsed.body.length > SKILL_HUB_LIMITS.body) {
    throw new Error("SKILL.md body is too large (max 256 KB).");
  }
  return {
    zipBuffer,
    description: parsed.description,
    body: parsed.body,
    project: parsed.project,
    files,
  };
}

export function buildSkillPackage(
  name: string,
  description: string,
  body: string,
  project?: string,
): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    SKILL_MD,
    Buffer.from(serializeSkillMarkdown({ name, description, body, project }), "utf8"),
  );
  return zip.toBuffer();
}

/** Replace the SKILL.md entry with frontmatter regenerated from the columns. */
function rewriteSkillMd(
  zipBuffer: Buffer,
  name: string,
  description: string,
  body: string,
  project?: string,
): Buffer {
  const zip = new AdmZip(zipBuffer);
  if (zip.getEntry(SKILL_MD)) zip.deleteFile(SKILL_MD);
  zip.addFile(
    SKILL_MD,
    Buffer.from(serializeSkillMarkdown({ name, description, body, project }), "utf8"),
  );
  return zip.toBuffer();
}

export class SkillHubStore {
  readonly dbPath: string;
  private readonly keyPath: string;
  private db: DbSync | null = null;
  private key: Uint8Array | null = null;
  private loadError: string | null = null;

  constructor(dataDir: string) {
    this.dbPath = join(dataDir, "skill-hub.db");
    this.keyPath = join(dataDir, "skill-hub.key");
    try {
      mkdirSync(dataDir, { recursive: true });
      const Ctor = loadDatabaseSync();
      if (!Ctor) {
        this.loadError = "node:sqlite unavailable (Node < 22.13?)";
        console.warn(`[jellybot-relay] skill hub disabled: ${this.loadError}`);
        return;
      }
      this.key = loadOrCreateKey(this.keyPath);
      this.db = new Ctor(this.dbPath);
      this.db.exec(SCHEMA);
      // Older databases predate the project column; SQLite cannot add it
      // through CREATE TABLE IF NOT EXISTS, so migrate in place.
      try {
        this.db.exec("ALTER TABLE skill ADD COLUMN project TEXT NOT NULL DEFAULT ''");
      } catch {
        // Column already exists.
      }
    } catch (err) {
      this.db = null;
      this.key = null;
      this.loadError = err instanceof Error ? err.message : String(err);
      console.warn(`[jellybot-relay] skill hub disabled: ${this.loadError}`);
    }
  }

  get available(): boolean {
    return this.db !== null && this.key !== null;
  }

  get unavailableReason(): string | null {
    return this.available ? null : (this.loadError ?? "skill hub store closed");
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.key = null;
  }

  snapshot(): SkillHubSnapshot {
    const db = this.requireDb();
    const skills = (db.prepare(
      `SELECT s.id, s.name, s.enabled, s.description, s.project, s.file_count,
       s.zip_nonce, s.zip_cipher, s.created_at
       FROM skill s LEFT JOIN skill_order o ON o.skill_id = s.id
       ORDER BY CASE WHEN o.sort_index IS NULL THEN 1 ELSE 0 END ASC,
               o.sort_index ASC, s.created_at ASC, s.id ASC`,
    ).all() as SkillRow[]).map((row) => toPublic(row));
    const deviceSkillIds: Record<string, string[]> = {};
    const links = db.prepare(
      "SELECT device_id, skill_id FROM device_skill ORDER BY device_id ASC, skill_id ASC",
    ).all() as Array<{ device_id: string; skill_id: string }>;
    for (const link of links) {
      const list = deviceSkillIds[link.device_id] ?? [];
      list.push(link.skill_id);
      deviceSkillIds[link.device_id] = list;
    }
    return { skills, deviceSkillIds };
  }

  reorderSkills(skillIds: string[]): SkillHubSnapshot {
    if (!Array.isArray(skillIds) || skillIds.some((id) => typeof id !== "string" || !id.trim())) {
      throw new Error("Skill order must contain skill IDs.");
    }
    const ids = new Set(skillIds);
    if (ids.size !== skillIds.length) {
      throw new Error("Skill order must not contain duplicate IDs.");
    }
    const db = this.requireDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = db.prepare("SELECT id FROM skill").all() as Array<{ id: string }>;
      if (current.length !== skillIds.length || current.some((row) => !ids.has(row.id))) {
        throw new SkillHubOrderConflictError();
      }
      db.prepare("DELETE FROM skill_order").run();
      const insert = db.prepare("INSERT INTO skill_order (skill_id, sort_index) VALUES (?, ?)");
      skillIds.forEach((id, index) => insert.run(id, index));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return this.snapshot();
  }

  addSkills(inputs: SkillHubInput[]): SkillHubSnapshot {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 32) {
      throw new Error("Choose between 1 and 32 skills.");
    }
    const db = this.requireDb();
    const key = this.requireKey();
    const insert = db.prepare(
      `INSERT INTO skill (id, name, enabled, description, project, file_count, zip_nonce, zip_cipher, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let ts = Date.now();
    db.exec("BEGIN");
    try {
      for (const input of inputs) {
        const name = assertSkillHubName(input.name);
        const description = clampDescription(input.description ?? "");
        if (!description) throw new Error("Skill description is required.");
        const body = typeof input.body === "string" ? input.body : "";
        if (body.length > SKILL_HUB_LIMITS.body) {
          throw new Error("SKILL.md body is too large (max 256 KB).");
        }
        const existing = this.findByName(name);
        if (existing) throw new Error(`A skill named "${name}" already exists.`);
        const project = clampProject(input.project);
        const id = randomUUID();
        const zip = buildSkillPackage(name, description, body, project);
        const secret = encryptHubSecret(key, "skill-hub", id, zip.toString("base64"));
        insert.run(
          id,
          name,
          input.enabled !== false ? 1 : 0,
          description,
          project,
          0,
          secret.nonce,
          secret.cipherText,
          ts,
          ts,
        );
        ts += 1;
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return this.snapshot();
  }

  updateSkill(skillId: string, patch: SkillHubUpdatePatch): SkillHubSnapshot {
    const db = this.requireDb();
    const row = this.fullRow(skillId);
    const name = patch.name !== undefined ? assertSkillHubName(patch.name) : row.name;
    const description = patch.description !== undefined
      ? clampDescription(patch.description)
      : row.description;
    const project =
      patch.project !== undefined ? clampProject(patch.project) : (row.project ?? "");
    if (!description) throw new Error("Skill description is required.");
    if (name !== row.name) {
      const clash = this.findByName(name);
      if (clash && clash.id !== row.id) {
        throw new Error(`A skill named "${name}" already exists.`);
      }
    }
    const touchesPackage =
      name !== row.name ||
      description !== row.description ||
      project !== (row.project ?? "") ||
      patch.body !== undefined;
    let secretUpdate: { nonce: string; cipherText: string } | null = null;
    let fileCount = row.file_count;
    if (touchesPackage) {
      const current = this.decryptPackage(row);
      const normalized = normalizeSkillPackage(current.toString("base64"));
      const body = patch.body !== undefined ? patch.body : normalized.body;
      if (body.length > SKILL_HUB_LIMITS.body) {
        throw new Error("SKILL.md body is too large (max 256 KB).");
      }
      const rewritten = rewriteSkillMd(current, name, description, body, project);
      if (rewritten.byteLength > SKILL_HUB_LIMITS.zipBytes) {
        throw new Error("Skill package is too large (max 8 MB).");
      }
      secretUpdate = encryptHubSecret(
        this.requireKey(),
        "skill-hub",
        row.id,
        rewritten.toString("base64"),
      );
      fileCount = normalized.files.length;
    }
    const enabled = patch.enabled !== undefined ? patch.enabled : row.enabled === 1;
    const now = Date.now();
    if (secretUpdate) {
      db.prepare(
        `UPDATE skill SET name = ?, enabled = ?, description = ?, project = ?, file_count = ?,
                          zip_nonce = ?, zip_cipher = ?, updated_at = ?
         WHERE id = ?`,
      ).run(name, enabled ? 1 : 0, description, project, fileCount, secretUpdate.nonce, secretUpdate.cipherText, now, row.id);
    } else {
      db.prepare(
        "UPDATE skill SET name = ?, enabled = ?, description = ?, project = ?, updated_at = ? WHERE id = ?",
      ).run(name, enabled ? 1 : 0, description, project, now, row.id);
    }
    return this.snapshot();
  }

  removeSkill(skillId: string): SkillHubSnapshot {
    const db = this.requireDb();
    this.fullRow(skillId);
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM device_skill WHERE skill_id = ?").run(skillId);
      db.prepare("DELETE FROM skill_order WHERE skill_id = ?").run(skillId);
      const result = db.prepare("DELETE FROM skill WHERE id = ?").run(skillId);
      if (Number(result.changes) !== 1) throw new Error("Skill not found.");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return this.snapshot();
  }

  /** Server-only shape for device push — never exposed through the console. */
  getTransfer(skillId: string): SkillZipTransfer {
    const row = this.fullRow(skillId);
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled === 1,
      description: row.description,
      project: row.project ?? "",
      zipBase64: this.decryptPackage(row).toString("base64"),
    };
  }

  getDetail(skillId: string): SkillHubDetail {
    const row = this.fullRow(skillId);
    const normalized = normalizeSkillPackage(this.decryptPackage(row).toString("base64"));
    return {
      ...toPublic(row),
      body: normalized.body,
      files: normalized.files,
    };
  }

  findByName(name: string): SkillHubPublicSkill | null {
    const key = skillHubMatchKey(name);
    const rows = this.requireDb()
      .prepare("SELECT id, name, enabled, description, project, file_count, zip_nonce, zip_cipher, created_at FROM skill")
      .all() as SkillRow[];
    for (const row of rows) {
      if (skillHubMatchKey(row.name) === key) return toPublic(row);
    }
    return null;
  }

  /**
   * Upsert a package pulled from a device. The device frontmatter wins for the
   * description/body, then the package is rewritten with the canonical name so
   * the Hub and the device never disagree about the frontmatter.
   */
  upsertByMatch(input: SkillHubUpsertInput): {
    snapshot: SkillHubSnapshot;
    skillId: string;
    action: "added" | "overwritten";
  } {
    const name = assertSkillHubName(input.name);
    const normalized = normalizeSkillPackage(input.zipBase64);
    const description = clampDescription(normalized.description || input.description || "");
    // The package frontmatter carries the scope when the device knows it;
    // an explicit input.project wins for callers that track it separately.
    const project = clampProject(input.project) || normalized.project;
    if (!description) throw new Error("Skill description is required.");
    const zip = rewriteSkillMd(normalized.zipBuffer, name, description, normalized.body, project);
    if (zip.byteLength > SKILL_HUB_LIMITS.zipBytes) {
      throw new Error("Skill package is too large (max 8 MB).");
    }
    const existing = this.findByName(name);
    const db = this.requireDb();
    const key = this.requireKey();
    const now = Date.now();
    if (!existing) {
      const id = randomUUID();
      const secret = encryptHubSecret(key, "skill-hub", id, zip.toString("base64"));
      db.prepare(
        `INSERT INTO skill (id, name, enabled, description, project, file_count, zip_nonce, zip_cipher, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        name,
        input.enabled ? 1 : 0,
        description,
        project,
        normalized.files.length,
        secret.nonce,
        secret.cipherText,
        now,
        now,
      );
      return { snapshot: this.snapshot(), skillId: id, action: "added" };
    }
    const secret = encryptHubSecret(key, "skill-hub", existing.id, zip.toString("base64"));
    db.prepare(
      `UPDATE skill SET name = ?, enabled = ?, description = ?, project = ?, file_count = ?,
                        zip_nonce = ?, zip_cipher = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      name,
      input.enabled ? 1 : 0,
      description,
      project,
      normalized.files.length,
      secret.nonce,
      secret.cipherText,
      now,
      existing.id,
    );
    return { snapshot: this.snapshot(), skillId: existing.id, action: "overwritten" };
  }

  assignSkill(deviceId: string, skillId: string): SkillHubSnapshot {
    const db = this.requireDb();
    if (!isDeviceId(deviceId)) throw new Error("Invalid device.");
    if (!db.prepare("SELECT id FROM skill WHERE id = ?").get(skillId)) {
      throw new Error("Skill not found.");
    }
    db.prepare(
      "INSERT OR IGNORE INTO device_skill (device_id, skill_id) VALUES (?, ?)",
    ).run(deviceId, skillId);
    return this.snapshot();
  }

  unassignSkill(deviceId: string, skillId: string): SkillHubSnapshot {
    this.requireDb()
      .prepare("DELETE FROM device_skill WHERE device_id = ? AND skill_id = ?")
      .run(deviceId, skillId);
    return this.snapshot();
  }

  private decryptPackage(row: SkillRow): Buffer {
    const base64 = decryptHubSecret(
      this.requireKey(),
      "skill-hub",
      row.id,
      row.zip_nonce,
      row.zip_cipher,
    );
    return Buffer.from(base64, "base64");
  }

  private fullRow(skillId: string): SkillRow {
    const row = this.requireDb().prepare(
      `SELECT id, name, enabled, description, project, file_count, zip_nonce, zip_cipher, created_at
       FROM skill WHERE id = ?`,
    ).get(skillId) as SkillRow | undefined;
    if (!row) throw new Error("Skill not found.");
    return row;
  }

  private requireDb(): DbSync {
    if (!this.db) throw new Error(`skill hub unavailable: ${this.unavailableReason}`);
    return this.db;
  }

  private requireKey(): Uint8Array {
    if (!this.key) throw new Error(`skill hub unavailable: ${this.unavailableReason}`);
    return this.key;
  }
}

function toPublic(row: SkillRow): SkillHubPublicSkill {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    description: row.description,
    project: row.project ?? "",
    fileCount: row.file_count,
    createdAt: row.created_at,
  };
}

function loadOrCreateKey(path: string): Uint8Array {
  if (existsSync(path)) {
    const key = readFileSync(path);
    if (key.byteLength !== 32) throw new Error("skill-hub.key must be 32 bytes");
    return new Uint8Array(key);
  }
  const key = randomBytes(32);
  writeFileSync(path, key, { mode: 0o600 });
  return new Uint8Array(key);
}

function isDeviceId(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}
