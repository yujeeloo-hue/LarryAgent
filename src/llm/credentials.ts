import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_PROVIDER_ID } from "../settings/types.js";
import {
  deleteApiKeyFromKeychain,
  readApiKeyFromKeychain,
} from "./keychain.js";


const CREDENTIALS_FILE = "llm-api-keys.json";

export type CredentialCipherMode = "safeStorage" | "plain";

export type CredentialCipher = {
  mode: CredentialCipherMode;
  encrypt(plainText: string): string;
  decrypt(payload: string): string;
};

type CredentialStoreFile = {
  version: 1;
  encryption: CredentialCipherMode;
  keys: Record<string, string>;
};


let credentialsRoot: string | null = null;
let cipherOverride: CredentialCipher | undefined;
let warnedPlaintextOnce = false;

export function configureCredentialsRoot(root: string): void {
  credentialsRoot = root;
}

function requireStorePath(): string {
  if (!credentialsRoot) {
    throw new Error("Credential store root is not configured");
  }
  return join(credentialsRoot, CREDENTIALS_FILE);
}

export function configureCredentialCipherForTests(
  cipher: CredentialCipher | undefined,
): void {
  cipherOverride = cipher;
}

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
  }
  if (!warnedPlaintextOnce) {
    warnedPlaintextOnce = true;
    console.warn(
      "[credentials] OS-level encryption unavailable; storing API keys in plaintext",
    );
  }
  return base64Cipher();
}


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

export function configureLegacyKeyBridgeForTests(
  bridge: LegacyKeyBridge | null | undefined,
): void {
  legacyBridgeOverride = bridge;
}

function getLegacyBridge(): LegacyKeyBridge | null {
  if (legacyBridgeOverride !== undefined) return legacyBridgeOverride;
  return defaultLegacyBridge();
}


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
  }
  return legacyKey;
}

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

export async function readApiKeyFromStore(
  providerId: string = DEFAULT_PROVIDER_ID,
): Promise<string | null> {
  const store = readStoreFile();
  const cipher = await resolveAutoCipher();
  const stored = decodeEntry(store, providerId, cipher);
  if (stored) return stored;
  if (Object.prototype.hasOwnProperty.call(store.keys, providerId)) {
    return null;
  }
  return migrateLegacyKey(providerId, store);
}

export async function hasApiKeyInStore(
  providerId: string = DEFAULT_PROVIDER_ID,
): Promise<boolean> {
  return (await readApiKeyFromStore(providerId)) !== null;
}

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
      }
    }
    const bridge = getLegacyBridge();
    if (bridge) {
      try {
        await bridge.remove(providerId);
      } catch {
      }
    }
  }
}
