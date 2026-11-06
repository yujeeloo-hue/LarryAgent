import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_PROVIDER_ID } from "../settings/types.js";
import {
  deleteApiKeyFromKeychain,
  readApiKeyFromKeychain,
} from "./keychain.js";

/**
 * LLM API key storage — encrypted blob file under the app-data root.
 *
 * Replaces direct macOS Keychain access (`./keychain.js`, now legacy-only):
 * - Cipher is Electron `safeStorage` when available (Chromium-managed platform
 *   backend: Keychain on macOS, DPAPI on Windows). When encryption is not
 *   available the store degrades to plaintext with a one-time console warning
 *   — same all-or-nothing rule as rendering fallbacks.
 * - Store file `<root>/llm-api-keys.json`: `{ version, encryption, keys }`,
 *   where `keys[providerId]` is a base64 payload produced by the cipher that
 *   wrote the file. Atomic writes via tmp file + rename.
 * - Silent migration: the first read for a provider with no table entry lifts
 *   the value out of legacy Keychain storage and deletes the old entries
 *   (including the legacy `api-key` account). The legacy bridge is injectable
 *   so tests never touch the real `security` CLI.
 */

const CREDENTIALS_FILE = "llm-api-keys.json";

export type CredentialCipherMode = "safeStorage" | "plain";

/** Encryption strategy bound to the cipher that wrote the store. */
export type CredentialCipher = {
  mode: CredentialCipherMode;
  /** Encrypt UTF-8 text into a storable base64 payload. */
  encrypt(plainText: string): string;
  /** Recover UTF-8 text from a stored base64 payload. */
  decrypt(payload: string): string;
};

type CredentialStoreFile = {
  version: 1;
  encryption: CredentialCipherMode;
  /** providerId → base64 payload (opaque outside the writing cipher mode). */
  keys: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Configuration (pattern matches configureUserMemoryRoot / configureToolsConfigRoot)
// ---------------------------------------------------------------------------

let credentialsRoot: string | null = null;
let cipherOverride: CredentialCipher | undefined;
let warnedPlaintextOnce = false;

/** Point the credential store at an app-data root. Call once at startup. */
export function configureCredentialsRoot(root: string): void {
  credentialsRoot = root;
}

function requireStorePath(): string {
  if (!credentialsRoot) {
    throw new Error("Credential store root is not configured");
  }
  return join(credentialsRoot, CREDENTIALS_FILE);
}

/** Test hook: force a cipher (or restore auto-detection with `undefined`). */
export function configureCredentialCipherForTests(
  cipher: CredentialCipher | undefined,
): void {
  cipherOverride = cipher;
}

/** Plaintext codec used when OS-level encryption is unavailable. */
function base64Cipher(): CredentialCipher {
  return {
    mode: "plain",
    encrypt: (plainText) => Buffer.from(plainText, "utf8").toString("base64"),
    decrypt: (payload) => Buffer.from(payload, "base64").toString("utf8"),
  };
}

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(buffer: Buffer): string;
}

async function resolveAutoCipher(): Promise<CredentialCipher> {
  if (cipherOverride !== undefined) return cipherOverride;
  try {
    const electron = (await import("electron")) as unknown as {
      safeStorage?: SafeStorageLike;
    };
    const safeStorage = electron?.safeStorage;
    if (
      safeStorage &&
      typeof safeStorage.isEncryptionAvailable === "function" &&
      safeStorage.isEncryptionAvailable()
    ) {
      return {
        mode: "safeStorage",
        encrypt: (plainText) =>
          safeStorage.encryptString(plainText).toString("base64"),
        decrypt: (payload) =>
          safeStorage.decryptString(Buffer.from(payload, "base64")),
      };
    }
  } catch {
    // Not running inside Electron (node --test, tooling) — fall through.
  }
  if (!warnedPlaintextOnce) {
    warnedPlaintextOnce = true;
    console.warn(
      "[credentials] OS-level encryption unavailable; storing API keys in plaintext",
    );
  }
  return base64Cipher();
}

// ---------------------------------------------------------------------------
// Store file IO
// ---------------------------------------------------------------------------

function readStoreFile(): CredentialStoreFile {
  const path = requireStorePath();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as CredentialStoreFile;
    if (
      raw &&
      raw.version === 1 &&
      (raw.encryption === "safeStorage" || raw.encryption === "plain") &&
      typeof raw.keys === "object" &&
      raw.keys !== null
    ) {
      return raw;
    }
  } catch {
    // Missing or unreadable store starts fresh.
  }
  return { version: 1, encryption: "plain", keys: {} };
}

function writeStoreFile(store: CredentialStoreFile): void {
  const path = requireStorePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Legacy macOS Keychain bridge (migration source)
// ---------------------------------------------------------------------------

export type LegacyKeyBridge = {
  read(providerId: string): Promise<string | null>;
  remove(providerId: string): Promise<void>;
};

function defaultLegacyBridge(): LegacyKeyBridge | null {
  if (process.platform !== "darwin") return null;
  return {
    read: (providerId) => readApiKeyFromKeychain(providerId),
    remove: (providerId) => deleteApiKeyFromKeychain(providerId),
  };
}

let legacyBridgeOverride: LegacyKeyBridge | null | undefined;

/** Test hook: replace the legacy Keychain bridge (`null` disables migration). */
export function configureLegacyKeyBridgeForTests(
  bridge: LegacyKeyBridge | null | undefined,
): void {
  legacyBridgeOverride = bridge;
}

function getLegacyBridge(): LegacyKeyBridge | null {
  if (legacyBridgeOverride !== undefined) return legacyBridgeOverride;
  return defaultLegacyBridge();
}

// ---------------------------------------------------------------------------
// Public API — same semantics as the former keychain.ts functions
// ---------------------------------------------------------------------------

/**
 * Lift a legacy Keychain entry into the encrypted store on first read and
 * remove the originals. Returns the migrated key, or null when there is
 * nothing legacy left for the provider.
 */
async function migrateLegacyKey(
  providerId: string,
  store: CredentialStoreFile,
): Promise<string | null> {
  const bridge = getLegacyBridge();
  if (!bridge) return null;
  let legacyKey: string | null = null;
  try {
    legacyKey = await bridge.read(providerId);
  } catch {
    return null;
  }
  if (!legacyKey) return null;
  const cipher = await resolveAutoCipher();
  store.encryption = cipher.mode;
  store.keys[providerId] = cipher.encrypt(legacyKey);
  writeStoreFile(store);
  try {
    await bridge.remove(providerId);
  } catch {
    // Removal failure only risks a redundant future rewrite — ignore.
  }
  return legacyKey;
}

/** Decrypt a stored payload; corrupted entries are dropped, not thrown. */
function decodeEntry(
  store: CredentialStoreFile,
  providerId: string,
  cipher: CredentialCipher,
): string | null {
  const payload = store.keys[providerId];
  if (typeof payload !== "string" || payload.length === 0) return null;
  try {
    const decrypted =
      store.encryption === "safeStorage"
        ? cipher.decrypt(payload)
        : Buffer.from(payload, "base64").toString("utf8");
    return decrypted.length > 0 ? decrypted : null;
  } catch {
    console.error(`[credentials] failed to decrypt key for "${providerId}"`);
    return null;
  }
}

/**
 * Read the API key for a provider from the encrypted store (main/Node only).
 * Migrates the legacy Keychain entry transparently when found.
 */
export async function readApiKeyFromStore(
  providerId: string = DEFAULT_PROVIDER_ID,
): Promise<string | null> {
  const store = readStoreFile();
  const cipher = await resolveAutoCipher();
  const stored = decodeEntry(store, providerId, cipher);
  if (stored) return stored;
  if (Object.prototype.hasOwnProperty.call(store.keys, providerId)) {
    // Present but undecryptable — do not fall back to legacy overwrite.
    return null;
  }
  return migrateLegacyKey(providerId, store);
}

/** True when a non-empty API key is stored for the provider. */
export async function hasApiKeyInStore(
  providerId: string = DEFAULT_PROVIDER_ID,
): Promise<boolean> {
  return (await readApiKeyFromStore(providerId)) !== null;
}

/**
 * Read every stored API key (decrypted), keyed by providerId — used by the
 * backup export. Entries that fail to decrypt are skipped, not thrown;
 * legacy Keychain-only entries are not migrated here (they migrate on the
 * next per-provider read).
 */
export async function readAllApiKeysFromStore(): Promise<
  Record<string, string>
> {
  const store = readStoreFile();
  const cipher = await resolveAutoCipher();
  const out: Record<string, string> = {};
  for (const providerId of Object.keys(store.keys)) {
    const decoded = decodeEntry(store, providerId, cipher);
    if (decoded) out[providerId] = decoded;
  }
  return out;
}

/** Store or update the API key for a provider. Never logs the key value. */
export async function writeApiKeyToStore(
  apiKey: string,
  providerId: string = DEFAULT_PROVIDER_ID,
): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new Error("API key is empty");
  }
  const store = readStoreFile();
  const cipher = await resolveAutoCipher();
  store.encryption = cipher.mode;
  store.keys[providerId] = cipher.encrypt(trimmed);
  writeStoreFile(store);
}

/** Remove the API key for a provider, plus any leftover legacy entry. */
export async function deleteApiKeyFromStore(
  providerId: string = DEFAULT_PROVIDER_ID,
): Promise<void> {
  const store = readStoreFile();
  if (
    Object.prototype.hasOwnProperty.call(store.keys, providerId) ||
    getLegacyBridge() !== null
  ) {
    delete store.keys[providerId];
    if (credentialsRoot) {
      try {
        writeStoreFile(store);
      } catch {
        // Unwritable store still allows best-effort legacy removal below.
      }
    }
    const bridge = getLegacyBridge();
    if (bridge) {
      try {
        await bridge.remove(providerId);
      } catch {
        // Missing legacy entry is fine.
      }
    }
  }
}
