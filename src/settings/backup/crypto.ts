import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";


export type BackupCryptoEnvelope = {
  v: 1;
  kdf: "scrypt";
  scrypt: { n: number; r: number; p: number };
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  authTag: string;
  data: string;
};

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
const SCRYPT_MEMORY_CAP_BYTES = 64 * 1024 * 1024;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

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
  if (buf.toString("base64") !== value.trim()) {
    throw new BackupPassphraseError(
      `Backup envelope field "${field}" is corrupt`,
    );
  }
  return buf;
}

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
