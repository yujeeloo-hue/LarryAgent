/**
 * MCP Hub store. Server metadata (name/enabled) is queryable; the whole
 * transport JSON — command, args, cwd, env values, URLs, header values — is
 * an AES-256-GCM envelope. The database file never contains a transport in
 * plaintext. Mirrors TokenHubStore's shape so the console reuses its UX.
 */
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
CREATE TABLE IF NOT EXISTS server (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  secret_nonce TEXT NOT NULL,
  secret_cipher TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS server_order (
  server_id TEXT PRIMARY KEY,
  sort_index INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS device_server (
  device_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  PRIMARY KEY (device_id, server_id)
);
`;

/** Wire transport — full form with env/header values (device + transfer only). */
export type McpHubTransport =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: "http"; url: string; headers?: Record<string, string> };

/** Public transport — env/header values stripped to their key names. */
export type McpHubPublicTransport =
  | { type: "stdio"; command: string; args?: string[]; cwd?: string; envKeys?: string[] }
  | { type: "http"; url: string; headerKeys?: string[] };

export type McpHubPublicServer = {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpHubPublicTransport;
  /** At least one env value / header value is stored. */
  secretConfigured: boolean;
  createdAt: number;
};

export type McpHubSnapshot = {
  servers: McpHubPublicServer[];
  deviceServerIds: Record<string, string[]>;
};

export type McpHubServerInput = {
  name: string;
  enabled?: boolean;
  transport: McpHubTransport;
};

/** Server-only transfer shape — never returned on console GET. */
export type McpHubTransferServer = {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpHubTransport;
};

export type McpHubUpdatePatch = {
  name?: string;
  enabled?: boolean;
  transport?: McpHubTransport;
};

type ServerRow = {
  id: string;
  name: string;
  enabled: number;
  secret_nonce: string;
  secret_cipher: string;
  created_at: number;
};

const LIMITS = { name: 80, command: 500, url: 500, transportJson: 16 * 1024 };

export class McpHubOrderConflictError extends Error {
  constructor() {
    super("Servers changed. Refresh the list and try again.");
    this.name = "McpHubOrderConflictError";
  }
}

export function mcpMatchKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Parse/normalize a wire transport; throws on anything unusable. */
export function normalizeMcpHubTransport(value: unknown): McpHubTransport {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP transport is required.");
  }
  const raw = value as Record<string, unknown>;
  if (raw.type === "stdio") {
    const command = typeof raw.command === "string" ? raw.command.trim() : "";
    if (!command) throw new Error("stdio command is required.");
    if (command.length > LIMITS.command) throw new Error("stdio command is too long.");
    const transport: Extract<McpHubTransport, { type: "stdio" }> = { type: "stdio", command };
    if (Array.isArray(raw.args)) {
      const args = raw.args
        .filter((arg): arg is string => typeof arg === "string")
        .map((arg) => arg.trim())
        .filter(Boolean);
      if (args.length > 0) transport.args = args;
    }
    const env = normalizeStringRecord(raw.env);
    if (env) transport.env = env;
    if (typeof raw.cwd === "string" && raw.cwd.trim()) transport.cwd = raw.cwd.trim();
    return transport;
  }
  if (raw.type === "http") {
    const url = typeof raw.url === "string" ? raw.url.trim() : "";
    if (!url || url.length > LIMITS.url) throw new Error("A valid MCP URL is required.");
    try {
      void new URL(url);
    } catch {
      throw new Error("A valid MCP URL is required.");
    }
    const transport: Extract<McpHubTransport, { type: "http" }> = { type: "http", url };
    const headers = normalizeStringRecord(raw.headers);
    if (headers) transport.headers = headers;
    return transport;
  }
  throw new Error("Unsupported MCP transport type.");
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const name = key.trim();
    if (!name || typeof raw !== "string") continue;
    out[name] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export class McpHubStore {
  readonly dbPath: string;
  private readonly keyPath: string;
  private db: DbSync | null = null;
  private key: Uint8Array | null = null;
  private loadError: string | null = null;

  constructor(dataDir: string) {
    this.dbPath = join(dataDir, "mcp-hub.db");
    this.keyPath = join(dataDir, "mcp-hub.key");
    try {
      mkdirSync(dataDir, { recursive: true });
      const Ctor = loadDatabaseSync();
      if (!Ctor) {
        this.loadError = "node:sqlite unavailable (Node < 22.13?)";
        console.warn(`[jellybot-relay] mcp hub disabled: ${this.loadError}`);
        return;
      }
      this.key = loadOrCreateKey(this.keyPath);
      this.db = new Ctor(this.dbPath);
      this.db.exec(SCHEMA);
    } catch (err) {
      this.db = null;
      this.key = null;
      this.loadError = err instanceof Error ? err.message : String(err);
      console.warn(`[jellybot-relay] mcp hub disabled: ${this.loadError}`);
    }
  }

  get available(): boolean {
    return this.db !== null && this.key !== null;
  }

  get unavailableReason(): string | null {
    return this.available ? null : (this.loadError ?? "mcp hub store closed");
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.key = null;
  }

  snapshot(): McpHubSnapshot {
    const db = this.requireDb();
    const servers = (db.prepare(
      `SELECT s.id, s.name, s.enabled, s.secret_nonce, s.secret_cipher, s.created_at
       FROM server s LEFT JOIN server_order o ON o.server_id = s.id
       ORDER BY CASE WHEN o.sort_index IS NULL THEN 1 ELSE 0 END ASC,
                o.sort_index ASC, s.created_at ASC, s.id ASC`,
    ).all() as ServerRow[]).map((row) => this.toPublic(row));
    const deviceServerIds: Record<string, string[]> = {};
    const links = db.prepare(
      "SELECT device_id, server_id FROM device_server ORDER BY device_id ASC, server_id ASC",
    ).all() as Array<{ device_id: string; server_id: string }>;
    for (const link of links) {
      const list = deviceServerIds[link.device_id] ?? [];
      list.push(link.server_id);
      deviceServerIds[link.device_id] = list;
    }
    return { servers, deviceServerIds };
  }

  /** Reorder the full current list without rewriting transports or secrets. */
  reorderServers(serverIds: string[]): McpHubSnapshot {
    if (!Array.isArray(serverIds) || serverIds.some((id) => typeof id !== "string" || !id.trim())) {
      throw new Error("Server order must contain server IDs.");
    }
    const ids = new Set(serverIds);
    if (ids.size !== serverIds.length) throw new Error("Server order must not contain duplicate IDs.");
    const db = this.requireDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = db.prepare("SELECT id FROM server").all() as Array<{ id: string }>;
      if (current.length !== serverIds.length || current.some((server) => !ids.has(server.id))) {
        throw new McpHubOrderConflictError();
      }
      db.prepare("DELETE FROM server_order").run();
      const insert = db.prepare("INSERT INTO server_order (server_id, sort_index) VALUES (?, ?)");
      serverIds.forEach((id, index) => insert.run(id, index));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return this.snapshot();
  }

  addServers(inputs: McpHubServerInput[]): McpHubSnapshot {
    if (inputs.length < 1 || inputs.length > 64) throw new Error("Choose between 1 and 64 servers.");
    const db = this.requireDb();
    const key = this.requireKey();
    // Per-row timestamps keep batch insert order stable (UUID tiebreak would
    // shuffle same-millisecond rows).
    let ts = Date.now();
    const insert = db.prepare(
      `INSERT INTO server (id, name, enabled, secret_nonce, secret_cipher, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    db.exec("BEGIN");
    try {
      for (const input of inputs) {
        const fields = normalizeInput(input);
        const id = randomUUID();
        const secret = encryptHubSecret(key, "mcp-hub", id, JSON.stringify(fields.transport));
        insert.run(id, fields.name, fields.enabled ? 1 : 0, secret.nonce, secret.cipherText, ts, ts);
        ts += 1;
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return this.snapshot();
  }

  updateServer(serverId: string, patch: McpHubUpdatePatch): McpHubSnapshot {
    const db = this.requireDb();
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (!trimmed || trimmed.length > LIMITS.name) throw new Error("Server name is required.");
      const result = db.prepare("UPDATE server SET name = ?, updated_at = ? WHERE id = ?")
        .run(trimmed, Date.now(), serverId);
      if (Number(result.changes) !== 1) throw new Error("Server not found.");
    }
    if (patch.enabled !== undefined) {
      const result = db.prepare("UPDATE server SET enabled = ?, updated_at = ? WHERE id = ?")
        .run(patch.enabled ? 1 : 0, Date.now(), serverId);
      if (Number(result.changes) !== 1) throw new Error("Server not found.");
    }
    if (patch.transport !== undefined) {
      this.fullRow(serverId);
      const transport = normalizeMcpHubTransport(patch.transport);
      const json = JSON.stringify(transport);
      if (json.length > LIMITS.transportJson) throw new Error("MCP transport is too large.");
      const secret = encryptHubSecret(this.requireKey(), "mcp-hub", serverId, json);
      const result = db.prepare(
        "UPDATE server SET secret_nonce = ?, secret_cipher = ?, updated_at = ? WHERE id = ?",
      ).run(secret.nonce, secret.cipherText, Date.now(), serverId);
      if (Number(result.changes) !== 1) throw new Error("Server not found.");
    }
    return this.snapshot();
  }

  removeServer(serverId: string): McpHubSnapshot {
    const db = this.requireDb();
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM device_server WHERE server_id = ?").run(serverId);
      db.prepare("DELETE FROM server_order WHERE server_id = ?").run(serverId);
      const result = db.prepare("DELETE FROM server WHERE id = ?").run(serverId);
      if (Number(result.changes) !== 1) throw new Error("Server not found.");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return this.snapshot();
  }

  /** Server-only decrypt for device push — never expose via console GET. */
  getTransfer(serverId: string): McpHubTransferServer {
    const row = this.fullRow(serverId);
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled === 1,
      transport: this.decryptTransport(row),
    };
  }

  findByMatch(name: string): McpHubPublicServer | null {
    const key = mcpMatchKey(name);
    // Display order must not change which duplicate a device pull overwrites.
    const servers = this.snapshot().servers.sort((a, b) =>
      a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const server of servers) {
      if (mcpMatchKey(server.name) === key) return server;
    }
    return null;
  }

  /**
   * Upsert by server name. Matching rows keep their hub id and enabled flag
   * follows the incoming transfer (device push carries the hub's enabled).
   */
  upsertByMatch(input: McpHubServerInput): {
    snapshot: McpHubSnapshot;
    serverId: string;
    action: "added" | "overwritten";
  } {
    const fields = normalizeInput(input);
    const existing = this.findByMatch(fields.name);
    if (!existing) {
      const db = this.requireDb();
      const key = this.requireKey();
      const id = randomUUID();
      const now = Date.now();
      const secret = encryptHubSecret(key, "mcp-hub", id, JSON.stringify(fields.transport));
      db.prepare(
        `INSERT INTO server (id, name, enabled, secret_nonce, secret_cipher, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, fields.name, fields.enabled ? 1 : 0, secret.nonce, secret.cipherText, now, now);
      return { snapshot: this.snapshot(), serverId: id, action: "added" };
    }
    this.updateServer(existing.id, { name: fields.name, enabled: fields.enabled, transport: fields.transport });
    return { snapshot: this.snapshot(), serverId: existing.id, action: "overwritten" };
  }

  assignServer(deviceId: string, serverId: string): McpHubSnapshot {
    const db = this.requireDb();
    if (!isDeviceId(deviceId)) throw new Error("Invalid device.");
    const found = db.prepare("SELECT id FROM server WHERE id = ?").get(serverId);
    if (!found) throw new Error("Server not found.");
    db.prepare("INSERT OR IGNORE INTO device_server (device_id, server_id) VALUES (?, ?)").run(deviceId, serverId);
    return this.snapshot();
  }

  unassignServer(deviceId: string, serverId: string): McpHubSnapshot {
    this.requireDb().prepare("DELETE FROM device_server WHERE device_id = ? AND server_id = ?")
      .run(deviceId, serverId);
    return this.snapshot();
  }

  private decryptTransport(row: ServerRow): McpHubTransport {
    const json = decryptHubSecret(this.requireKey(), "mcp-hub", row.id, row.secret_nonce, row.secret_cipher);
    return normalizeMcpHubTransport(JSON.parse(json) as unknown);
  }

  private fullRow(serverId: string): ServerRow {
    const row = this.requireDb().prepare(
      "SELECT id, name, enabled, secret_nonce, secret_cipher, created_at FROM server WHERE id = ?",
    ).get(serverId) as ServerRow | undefined;
    if (!row) throw new Error("Server not found.");
    return row;
  }

  private toPublic(row: ServerRow): McpHubPublicServer {
    const transport = this.decryptTransport(row);
    const publicTransport: McpHubPublicTransport = transport.type === "stdio"
      ? {
          type: "stdio",
          command: transport.command,
          ...(transport.args ? { args: [...transport.args] } : {}),
          ...(transport.cwd ? { cwd: transport.cwd } : {}),
          ...(transport.env ? { envKeys: Object.keys(transport.env) } : {}),
        }
      : {
          type: "http",
          url: transport.url,
          ...(transport.headers ? { headerKeys: Object.keys(transport.headers) } : {}),
        };
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled === 1,
      transport: publicTransport,
      secretConfigured: transport.type === "stdio"
        ? Object.keys(transport.env ?? {}).length > 0
        : Object.keys(transport.headers ?? {}).length > 0,
      createdAt: row.created_at,
    };
  }

  private requireDb(): DbSync {
    if (!this.db) throw new Error(`mcp hub unavailable: ${this.unavailableReason}`);
    return this.db;
  }

  private requireKey(): Uint8Array {
    if (!this.key) throw new Error(`mcp hub unavailable: ${this.unavailableReason}`);
    return this.key;
  }
}

function loadOrCreateKey(path: string): Uint8Array {
  if (existsSync(path)) {
    const key = readFileSync(path);
    if (key.byteLength !== 32) throw new Error("mcp-hub.key must be 32 bytes");
    return new Uint8Array(key);
  }
  const key = randomBytes(32);
  writeFileSync(path, key, { mode: 0o600 });
  return new Uint8Array(key);
}

function normalizeInput(input: McpHubServerInput): { name: string; enabled: boolean; transport: McpHubTransport } {
  const name = input.name.trim();
  if (!name || name.length > LIMITS.name) throw new Error("Server name is required.");
  const transport = normalizeMcpHubTransport(input.transport);
  const json = JSON.stringify(transport);
  if (json.length > LIMITS.transportJson) throw new Error("MCP transport is too large.");
  return { name, enabled: input.enabled !== false, transport };
}

function isDeviceId(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}
