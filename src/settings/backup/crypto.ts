import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

/**
 * Backup bundle crypto — passphrase encryption for the export file.
 *
 * The whole backup payload (settings / tools / API keys / skills / user
 * memory / FSM graphs) is serialized to UTF-8 JSON and sealed with
 * AES-256-GCM under a scrypt-derived key. A wrong passphrase and a
 * tampered ciphertext both fail the GCM auth-tag check — reported as one
 * error, since they are indistinguishable by design.
 *
 * The envelope is self-describing (kdf id + params + cipher id) so future
 * parameter changes remain backward compatible with existing exports.
 *
 * Pure Node `node:crypto` — no native dependency, works on macOS and
 * Windows builds alike (cross-machine safeStorage blobs are never moved).
 */

export type BackupCryptoEnvelope = {
  v: 1;
  kdf: "scrypt";
  /** scrypt cost parameters (N, r, p) used to derive the key. */
  scrypt: { n: number; r: number; p: number };
  cipher: "aes-256-gcm";
  /** base64 random salt (16 bytes). */
  salt: string;
  /** base64 random IV (12 bytes, GCM standard). */
  iv: string;
  /** base64 GCM auth tag (16 bytes). */
  authTag: string;
  /** base64 ciphertext of the UTF-8 payload. */
  data: string;
};

/** scrypt cost: interactive-grade (~50ms on Apple Silicon). */
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
/** AES-256 key length. */
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
/**
 * Hard cap on `128 * N * r` (scrypt working memory) for params read from a
 * bundle — blocks DoS via hostile cost parameters. Our defaults use 16 MiB.
 */
const SCRYPT_MEMORY_CAP_BYTES = 64 * 1024 * 1024;
/** `maxmem` for scryptSync — must sit above the cap to permit it. */
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

/** Wrong passphrase or corrupted/tampered envelope (indistinguishable by design). */
export class BackupPassphraseError extends Error {
  constructor(message = "Wrong passphrase or corrupted backup data") {
    super(message);
    this.name = "BackupPassphraseError";
  }
}

function deriveKey(
  passphrase: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
): Buffer {
  if (
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    n < 2 ||
    r < 1 ||
    p < 1 ||
    128 * n * r > SCRYPT_MEMORY_CAP_BYTES
  ) {
    throw new BackupPassphraseError("Backup envelope kdf params are out of range");
  }
  return scryptSync(passphrase, salt, KEY_LEN, {
    N: n,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  });
}

/** Seal a UTF-8 payload string under a passphrase. */
export function encryptBackupPayload(
  plaintext: string,
  passphrase: string,
): BackupCryptoEnvelope {
  if (!passphrase) throw new Error("Passphrase is empty");
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    v: 1,
    kdf: "scrypt",
    scrypt: { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
    cipher: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decodeBase64Field(value: unknown, field: string): Buffer {
  if (typeof value !== "string" || value.length === 0) {
    throw new BackupPassphraseError(
      `Backup envelope field "${field}" is missing`,
    );
  }
  const buf = Buffer.from(value, "base64");
  // Buffer.from is lenient with junk; require a canonical base64 round-trip.
  if (buf.toString("base64") !== value.trim()) {
    throw new BackupPassphraseError(
      `Backup envelope field "${field}" is corrupt`,
    );
  }
  return buf;
}

/**
 * Open a sealed envelope and return the UTF-8 payload. Throws
 * {@link BackupPassphraseError} on a wrong passphrase, tampered data, or an
 * envelope format this build does not understand.
 */
export function decryptBackupPayload(
  envelope: unknown,
  passphrase: string,
): string {
  if (!passphrase) throw new BackupPassphraseError("Passphrase is empty");
  if (!envelope || typeof envelope !== "object") {
    throw new BackupPassphraseError("Backup envelope is not an object");
  }
  const raw = envelope as Partial<BackupCryptoEnvelope>;
  if (raw.v !== 1 || raw.kdf !== "scrypt" || raw.cipher !== "aes-256-gcm") {
    throw new BackupPassphraseError("Unsupported backup envelope format");
  }
  const salt = decodeBase64Field(raw.salt, "salt");
  const iv = decodeBase64Field(raw.iv, "iv");
  const authTag = decodeBase64Field(raw.authTag, "authTag");
  const data = decodeBase64Field(raw.data, "data");
  if (iv.length !== IV_LEN) {
    throw new BackupPassphraseError("Backup envelope iv is corrupt");
  }
  if (authTag.length !== AUTH_TAG_LEN) {
    throw new BackupPassphraseError("Backup envelope auth tag is corrupt");
  }
  const params = raw.scrypt;
  if (!params) {
    throw new BackupPassphraseError("Backup envelope kdf params are missing");
  }
  const key = deriveKey(passphrase, salt, params.n, params.r, params.p);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    throw new BackupPassphraseError();
  }
}
