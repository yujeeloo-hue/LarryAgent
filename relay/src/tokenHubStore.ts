/**
 * Token Hub store. LLM Provider metadata is queryable; the API key and base
 * URL are an AES-256-GCM envelope. The database file never contains either
 * secret in plaintext.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { decryptTokenHubSecret, encryptTokenHubSecret } from "./tokenHubCipher.js";
import { normalizeProviderBaseUrl, normalizeProviderApiOptions, parseProviderApiOptions, type ProviderApiOptions } from "./providerApiOptions.js";

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
CREATE TABLE IF NOT EXISTS provider (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  supports_multimodal INTEGER NOT NULL,
  multimodal_source TEXT NOT NULL,
  image_input TEXT NOT NULL DEFAULT 'url',
  raw_endpoint INTEGER NOT NULL DEFAULT 0,
  api_options TEXT NOT NULL DEFAULT '{}',
  secret_nonce TEXT NOT NULL,
  secret_cipher TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS device_provider (
  device_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  PRIMARY KEY (device_id, provider_id)
);
CREATE TABLE IF NOT EXISTS provider_order (
  provider_id TEXT PRIMARY KEY,
  sort_index INTEGER NOT NULL
);
`;

export type TokenHubMultimodalSource = "detected" | "manual";
export type TokenHubImageInput = "url" | "base64" | "file";

export type TokenHubPublicProvider = ProviderApiOptions & {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  apiKeyConfigured: boolean;
  supportsMultimodal: boolean;
  multimodalSource: TokenHubMultimodalSource;
  imageInput: TokenHubImageInput;
  rawEndpoint: boolean;
  createdAt: number;
};

export type TokenHubSnapshot = {
  providers: TokenHubPublicProvider[];
  deviceProviderIds: Record<string, string[]>;
};

export type TokenHubProviderInput = ProviderApiOptions & {
  name: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  supportsMultimodal: boolean;
  multimodalSource: TokenHubMultimodalSource;
  imageInput?: TokenHubImageInput;
  rawEndpoint?: boolean;
};

/** Server-only transfer shape — never returned on console GET. */
export type TokenHubTransferProvider = ProviderApiOptions & {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  supportsMultimodal: boolean;
  imageInput: TokenHubImageInput;
  rawEndpoint: boolean;
};

type ProviderRow = {
  id: string;
  name: string;
  model_id: string;
  supports_multimodal: number;
  multimodal_source: string;
  image_input: string;
  raw_endpoint: number;
  api_options: string;
  secret_nonce: string;
  secret_cipher: string;
  created_at: number;
};

const LIMITS = { name: 80, modelId: 200, baseUrl: 500, apiKey: 4096 };

export class TokenHubOrderConflictError extends Error {
  constructor() {
    super("Providers changed. Refresh the list and try again.");
    this.name = "TokenHubOrderConflictError";
  }
}

export class TokenHubStore {
  readonly dbPath: string;
  private readonly keyPath: string;
  private db: DbSync | null = null;
  private key: Uint8Array | null = null;
  private loadError: string | null = null;

  constructor(dataDir: string) {
    this.dbPath = join(dataDir, "token-hub.db");
    this.keyPath = join(dataDir, "token-hub.key");
    try {
      mkdirSync(dataDir, { recursive: true });
      const Ctor = loadDatabaseSync();
      if (!Ctor) {
        this.loadError = "node:sqlite unavailable (Node < 22.13?)";
        console.warn(`[jellybot-relay] token hub disabled: ${this.loadError}`);
        return;
      }
      this.key = loadOrCreateKey(this.keyPath);
      this.db = new Ctor(this.dbPath);
      this.db.exec(SCHEMA);
      const columns = this.db.prepare("PRAGMA table_info(provider)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "image_input")) {
        this.db.exec("ALTER TABLE provider ADD COLUMN image_input TEXT NOT NULL DEFAULT 'url'");
      }
      if (!columns.some((column) => column.name === "raw_endpoint")) {
        this.db.exec("ALTER TABLE provider ADD COLUMN raw_endpoint INTEGER NOT NULL DEFAULT 0");
      }
      if (!columns.some((column) => column.name === "api_options")) {
        this.db.exec("ALTER TABLE provider ADD COLUMN api_options TEXT NOT NULL DEFAULT '{}'");
      }
    } catch (err) {
      this.db = null;
      this.key = null;
      this.loadError = err instanceof Error ? err.message : String(err);
      console.warn(`[jellybot-relay] token hub disabled: ${this.loadError}`);
    }
  }

  get available(): boolean {
    return this.db !== null && this.key !== null;
  }

  get unavailableReason(): string | null {
    return this.available ? null : (this.loadError ?? "token hub store closed");
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.key = null;
  }

  snapshot(): TokenHubSnapshot {
    const db = this.requireDb();
    const providers = (db.prepare(
      `SELECT p.id, p.name, p.model_id, p.supports_multimodal, p.multimodal_source,
              p.image_input, p.raw_endpoint, p.api_options, p.secret_nonce, p.secret_cipher, p.created_at
       FROM provider p LEFT JOIN provider_order o ON o.provider_id = p.id
       ORDER BY CASE WHEN o.sort_index IS NULL THEN 1 ELSE 0 END ASC,
                o.sort_index ASC, p.created_at ASC, p.id ASC`,
    ).all() as ProviderRow[]).map((row) => this.toPublic(row));
    const deviceProviderIds: Record<string, string[]> = {};
    const links = db.prepare(
      "SELECT device_id, provider_id FROM device_provider ORDER BY device_id ASC, provider_id ASC",
    ).all() as Array<{ device_id: string; provider_id: string }>;
    for (const link of links) {
      const list = deviceProviderIds[link.device_id] ?? [];
      list.push(link.provider_id);
      deviceProviderIds[link.device_id] = list;
    }
    return { providers, deviceProviderIds };
  }

  /** Reorder the full current list without rewriting provider data or secrets. */
  reorderProviders(providerIds: string[]): TokenHubSnapshot {
    if (!Array.isArray(providerIds) || providerIds.some((id) => typeof id !== "string" || !id.trim())) {
      throw new Error("Provider order must contain provider IDs.");
    }
    const ids = new Set(providerIds);
    if (ids.size !== providerIds.length) throw new Error("Provider order must not contain duplicate IDs.");
    const db = this.requireDb();
    // Hold the write lock while checking membership so a concurrent add or
    // delete cannot turn a valid full-list order into a partial metadata write.
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = db.prepare("SELECT id FROM provider").all() as Array<{ id: string }>;
      if (current.length !== providerIds.length || current.some((provider) => !ids.has(provider.id))) {
        throw new TokenHubOrderConflictError();
      }
      db.prepare("DELETE FROM provider_order").run();
      const insert = db.prepare("INSERT INTO provider_order (provider_id, sort_index) VALUES (?, ?)");
      providerIds.forEach((id, index) => insert.run(id, index));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return this.snapshot();
  }

  addProviders(inputs: TokenHubProviderInput[]): TokenHubSnapshot {
    if (inputs.length < 1 || inputs.length > 32) throw new Error("Choose between 1 and 32 providers.");
    const db = this.requireDb();
    const key = this.requireKey();
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO provider
        (id, name, model_id, supports_multimodal, multimodal_source, image_input, raw_endpoint, api_options, secret_nonce, secret_cipher, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.exec("BEGIN");
    try {
      for (const input of inputs) {
        const fields = normalizeInput(input);
        const id = randomUUID();
        const secret = encryptTokenHubSecret(key, id, { apiKey: fields.apiKey, baseUrl: fields.baseUrl });
        insert.run(
          id,
          fields.name,
          fields.modelId,
          fields.supportsMultimodal ? 1 : 0,
          fields.multimodalSource,
          fields.imageInput,
          fields.rawEndpoint ? 1 : 0,
          JSON.stringify(normalizeProviderApiOptions(fields)),
          secret.nonce,
          secret.cipherText,
          now,
          now,
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return this.snapshot();
  }

  renameProvider(providerId: string, name: string): TokenHubSnapshot {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > LIMITS.name) throw new Error("Provider name is required.");
    const db = this.requireDb();
    const result = db.prepare("UPDATE provider SET name = ?, updated_at = ? WHERE id = ?").run(trimmed, Date.now(), providerId);
    if (Number(result.changes) !== 1) throw new Error("Provider not found.");
    return this.snapshot();
  }

  setModelId(providerId: string, modelId: string): TokenHubSnapshot {
    const trimmed = modelId.trim();
    if (!trimmed || trimmed.length > LIMITS.modelId) throw new Error("Model ID is required.");
    const db = this.requireDb();
    const result = db.prepare("UPDATE provider SET model_id = ?, updated_at = ? WHERE id = ?").run(trimmed, Date.now(), providerId);
    if (Number(result.changes) !== 1) throw new Error("Provider not found.");
    return this.snapshot();
  }

  setBaseUrl(providerId: string, baseUrl: string): TokenHubSnapshot {
    const current = this.fullRow(providerId);
    const normalized = normalizeProviderBaseUrl(baseUrl, current.raw_endpoint === 1);
    if (!normalized || normalized.length > LIMITS.baseUrl || !/^https?:\/\//i.test(normalized)) {
      throw new Error("Enter a valid http(s) base URL.");
    }
    const db = this.requireDb();
    const row = this.secretRow(providerId);
    const secret = decryptTokenHubSecret(this.requireKey(), providerId, row.secret_nonce, row.secret_cipher);
    const next = encryptTokenHubSecret(this.requireKey(), providerId, { apiKey: secret.apiKey, baseUrl: normalized });
    const imageInput = normalizeImageInput(row.image_input, normalized);
    const result = db.prepare(
      "UPDATE provider SET image_input = ?, secret_nonce = ?, secret_cipher = ?, updated_at = ? WHERE id = ?",
    ).run(imageInput, next.nonce, next.cipherText, Date.now(), providerId);
    if (Number(result.changes) !== 1) throw new Error("Provider not found.");
    return this.snapshot();
  }

  setApiKey(providerId: string, apiKey: string): TokenHubSnapshot {
    const trimmed = apiKey.trim();
    if (!trimmed || trimmed.length > LIMITS.apiKey) throw new Error("API key is required.");
    const db = this.requireDb();
    const row = this.secretRow(providerId);
    const secret = decryptTokenHubSecret(this.requireKey(), providerId, row.secret_nonce, row.secret_cipher);
    const next = encryptTokenHubSecret(this.requireKey(), providerId, { apiKey: trimmed, baseUrl: secret.baseUrl });
    const result = db.prepare(
      "UPDATE provider SET secret_nonce = ?, secret_cipher = ?, updated_at = ? WHERE id = ?",
    ).run(next.nonce, next.cipherText, Date.now(), providerId);
    if (Number(result.changes) !== 1) throw new Error("Provider not found.");
    return this.snapshot();
  }

  setMultimodal(providerId: string, enabled: boolean): TokenHubSnapshot {
    const db = this.requireDb();
    const result = db.prepare(
      "UPDATE provider SET supports_multimodal = ?, multimodal_source = 'manual', updated_at = ? WHERE id = ?",
    ).run(enabled ? 1 : 0, Date.now(), providerId);
    if (Number(result.changes) !== 1) throw new Error("Provider not found.");
    return this.snapshot();
  }

  setImageInput(providerId: string, imageInput: string): TokenHubSnapshot {
    const db = this.requireDb();
    const row = this.secretRow(providerId);
    const secret = decryptTokenHubSecret(this.requireKey(), providerId, row.secret_nonce, row.secret_cipher);
    if (!isImageInput(imageInput) || normalizeImageInput(imageInput, secret.baseUrl) !== imageInput) {
      throw new Error("Image input mode is not supported by this provider.");
    }
    const result = db.prepare(
      "UPDATE provider SET image_input = ?, updated_at = ? WHERE id = ?",
    ).run(imageInput, Date.now(), providerId);
    if (Number(result.changes) !== 1) throw new Error("Provider not found.");
    return this.snapshot();
  }

  setRawEndpoint(providerId: string, enabled: boolean): TokenHubSnapshot {
    const db = this.requireDb();
    const result = db.prepare(
      "UPDATE provider SET raw_endpoint = ?, updated_at = ? WHERE id = ?",
    ).run(enabled ? 1 : 0, Date.now(), providerId);
    if (Number(result.changes) !== 1) throw new Error("Provider not found.");
    return this.snapshot();
  }

  setApiOptions(providerId: string, patch: ProviderApiOptions): TokenHubSnapshot {
    const row = this.fullRow(providerId);
    const options = { ...parseProviderApiOptions(row.api_options), ...normalizeProviderApiOptions(patch) };
    this.requireDb().prepare("UPDATE provider SET api_options = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(options), Date.now(), providerId);
    return this.snapshot();
  }

  /** Server-only decrypt for device push — never expose via console GET. */
  getTransfer(providerId: string): TokenHubTransferProvider {
    const row = this.fullRow(providerId);
    const secret = decryptTokenHubSecret(this.requireKey(), row.id, row.secret_nonce, row.secret_cipher);
    return {
      ...parseProviderApiOptions(row.api_options),
      id: row.id,
      name: row.name,
      baseUrl: secret.baseUrl,
      modelId: row.model_id,
      apiKey: secret.apiKey,
      supportsMultimodal: row.supports_multimodal === 1,
      imageInput: normalizeImageInput(row.image_input, secret.baseUrl),
      rawEndpoint: row.raw_endpoint === 1,
    };
  }

  findByMatch(baseUrl: string, modelId: string): TokenHubPublicProvider | null {
    const key = providerMatchKey(baseUrl, modelId);
    // Display order must not change which duplicate a device pull overwrites.
    const providers = this.snapshot().providers.sort((a, b) =>
      a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const provider of providers) {
      if (providerMatchKey(provider.baseUrl, provider.modelId) === key) return provider;
    }
    return null;
  }

  /**
   * Upsert by Base URL + Model ID. Matching rows keep their hub id; empty
   * apiKey on overwrite keeps the stored key.
   */
  upsertByMatch(input: TokenHubProviderInput): {
    snapshot: TokenHubSnapshot;
    providerId: string;
    action: "added" | "overwritten";
  } {
    const fields = normalizeInput({ ...input, multimodalSource: input.multimodalSource || "manual" }, {
      allowEmptyApiKey: true,
    });
    const existing = this.findByMatch(fields.baseUrl, fields.modelId);
    if (!existing) {
      const db = this.requireDb();
      const key = this.requireKey();
      const id = randomUUID();
      const now = Date.now();
      const secret = encryptTokenHubSecret(key, id, { apiKey: fields.apiKey, baseUrl: fields.baseUrl });
      db.prepare(
        `INSERT INTO provider
          (id, name, model_id, supports_multimodal, multimodal_source, image_input, raw_endpoint, api_options, secret_nonce, secret_cipher, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        fields.name,
        fields.modelId,
        fields.supportsMultimodal ? 1 : 0,
        "manual",
        fields.imageInput,
        fields.rawEndpoint ? 1 : 0,
        JSON.stringify(normalizeProviderApiOptions(fields)),
        secret.nonce,
        secret.cipherText,
        now,
        now,
      );
      return { snapshot: this.snapshot(), providerId: id, action: "added" };
    }
    const db = this.requireDb();
    const row = this.secretRow(existing.id);
    const secret = decryptTokenHubSecret(this.requireKey(), existing.id, row.secret_nonce, row.secret_cipher);
    const apiKey = fields.apiKey || secret.apiKey;
    const next = encryptTokenHubSecret(this.requireKey(), existing.id, {
      apiKey,
      baseUrl: fields.baseUrl,
    });
    const result = db.prepare(
      `UPDATE provider SET
        name = ?, model_id = ?, supports_multimodal = ?, multimodal_source = 'manual',
        image_input = ?, raw_endpoint = ?, api_options = ?, secret_nonce = ?, secret_cipher = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      fields.name,
      fields.modelId,
      fields.supportsMultimodal ? 1 : 0,
      fields.imageInput,
      fields.rawEndpoint ? 1 : 0,
      JSON.stringify({ ...normalizeProviderApiOptions(existing), ...normalizeProviderApiOptions(fields) }),
      next.nonce,
      next.cipherText,
      Date.now(),
      existing.id,
    );
    if (Number(result.changes) !== 1) throw new Error("Provider not found.");
    return { snapshot: this.snapshot(), providerId: existing.id, action: "overwritten" };
  }

  removeProvider(providerId: string): TokenHubSnapshot {
    const db = this.requireDb();
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM device_provider WHERE provider_id = ?").run(providerId);
      db.prepare("DELETE FROM provider_order WHERE provider_id = ?").run(providerId);
      const result = db.prepare("DELETE FROM provider WHERE id = ?").run(providerId);
      if (Number(result.changes) !== 1) throw new Error("Provider not found.");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return this.snapshot();
  }

  assignProvider(deviceId: string, providerId: string): TokenHubSnapshot {
    const db = this.requireDb();
    if (!isDeviceId(deviceId)) throw new Error("Invalid device.");
    const found = db.prepare("SELECT id FROM provider WHERE id = ?").get(providerId);
    if (!found) throw new Error("Provider not found.");
    db.prepare("INSERT OR IGNORE INTO device_provider (device_id, provider_id) VALUES (?, ?)").run(deviceId, providerId);
    return this.snapshot();
  }

  unassignProvider(deviceId: string, providerId: string): TokenHubSnapshot {
    const db = this.requireDb();
    db.prepare("DELETE FROM device_provider WHERE device_id = ? AND provider_id = ?").run(deviceId, providerId);
    return this.snapshot();
  }

  private secretRow(providerId: string): { secret_nonce: string; secret_cipher: string; image_input: string } {
    const row = this.requireDb().prepare(
      "SELECT secret_nonce, secret_cipher, image_input FROM provider WHERE id = ?",
    ).get(providerId) as { secret_nonce: string; secret_cipher: string; image_input: string } | undefined;
    if (!row) throw new Error("Provider not found.");
    return row;
  }

  private fullRow(providerId: string): ProviderRow {
    const row = this.requireDb().prepare(
      "SELECT id, name, model_id, supports_multimodal, multimodal_source, image_input, raw_endpoint, api_options, secret_nonce, secret_cipher, created_at FROM provider WHERE id = ?",
    ).get(providerId) as ProviderRow | undefined;
    if (!row) throw new Error("Provider not found.");
    return row;
  }

  private toPublic(row: ProviderRow): TokenHubPublicProvider {
    const secret = decryptTokenHubSecret(this.requireKey(), row.id, row.secret_nonce, row.secret_cipher);
    return {
      ...parseProviderApiOptions(row.api_options),
      id: row.id,
      name: row.name,
      baseUrl: secret.baseUrl,
      modelId: row.model_id,
      apiKeyConfigured: secret.apiKey.trim().length > 0,
      supportsMultimodal: row.supports_multimodal === 1,
      multimodalSource: row.multimodal_source === "manual" ? "manual" : "detected",
      imageInput: normalizeImageInput(row.image_input, secret.baseUrl),
      rawEndpoint: row.raw_endpoint === 1,
      createdAt: row.created_at,
    };
  }

  private requireDb(): DbSync {
    if (!this.db) throw new Error(`token hub unavailable: ${this.unavailableReason}`);
    return this.db;
  }

  private requireKey(): Uint8Array {
    if (!this.key) throw new Error(`token hub unavailable: ${this.unavailableReason}`);
    return this.key;
  }
}

function loadOrCreateKey(path: string): Uint8Array {
  if (existsSync(path)) {
    const key = readFileSync(path);
    if (key.byteLength !== 32) throw new Error("token-hub.key must be 32 bytes");
    return new Uint8Array(key);
  }
  const key = randomBytes(32);
  writeFileSync(path, key, { mode: 0o600 });
  return new Uint8Array(key);
}

function normalizeInput(
  input: TokenHubProviderInput,
  opts?: { allowEmptyApiKey?: boolean },
): Required<Omit<TokenHubProviderInput, keyof ProviderApiOptions>> & ProviderApiOptions {
  const name = input.name.trim();
  const modelId = input.modelId.trim();
  const baseUrl = normalizeProviderBaseUrl(input.baseUrl, input.rawEndpoint === true);
  const apiKey = input.apiKey.trim();
  if (!name || name.length > LIMITS.name) throw new Error("Provider name is required.");
  if (!modelId || modelId.length > LIMITS.modelId) throw new Error("Model ID is required.");
  if (!baseUrl || baseUrl.length > LIMITS.baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    throw new Error("Enter a valid http(s) base URL.");
  }
  if (apiKey.length > LIMITS.apiKey) throw new Error("API key is too long.");
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(baseUrl);
  if (!opts?.allowEmptyApiKey && !local && !apiKey) {
    throw new Error("API key required — local servers can leave it empty.");
  }
  if (input.multimodalSource !== "detected" && input.multimodalSource !== "manual") {
    throw new Error("Invalid multimodal source.");
  }
  return {
    ...normalizeProviderApiOptions(input),
    name,
    modelId,
    baseUrl,
    apiKey,
    supportsMultimodal: input.supportsMultimodal === true,
    multimodalSource: input.multimodalSource,
    imageInput: normalizeImageInput(input.imageInput, baseUrl),
    rawEndpoint: input.rawEndpoint === true,
  };
}

export function providerMatchKey(baseUrl: string, modelId: string): string {
  return `${normalizeProviderBaseUrl(baseUrl).toLowerCase()}\0${modelId.trim()}`;
}

export function isMoonshotProviderBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    return host === "api.moonshot.cn"
      || host.endsWith(".moonshot.cn")
      || host === "api.moonshot.ai"
      || host.endsWith(".moonshot.ai")
      || host === "api.kimi.com"
      || host.endsWith(".kimi.com");
  } catch {
    return false;
  }
}

function isImageInput(value: unknown): value is TokenHubImageInput {
  return value === "url" || value === "base64" || value === "file";
}

function normalizeImageInput(value: unknown, baseUrl: string): TokenHubImageInput {
  if (isMoonshotProviderBaseUrl(baseUrl)) {
    return value === "file" || value === "base64" ? value : "base64";
  }
  return value === "base64" || value === "url" ? value : "url";
}

function isDeviceId(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}
