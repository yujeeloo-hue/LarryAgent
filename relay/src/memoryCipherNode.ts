import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  CIPHER_KEY_BYTES,
  CIPHER_NONCE_BYTES,
  CIPHER_SALT,
  KEY_VERSION_HEX,
  bytesToBase64,
  bytesToHex,
  cipherAad,
  cipherInfoForDoc,
  normalizeEntryText,
  type CipherEnvelope,
  type MemoryDocId,
} from "./memoryCipherCore.js";

export function deriveDocKey(apiKey: string, docId: MemoryDocId): Uint8Array {
  return new Uint8Array(
    hkdfSync("sha256", Buffer.from(apiKey, "utf8"), Buffer.from(CIPHER_SALT, "utf8"), Buffer.from(cipherInfoForDoc(docId)), CIPHER_KEY_BYTES),
  );
}

export function keyVersionOf(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, KEY_VERSION_HEX);
}

export function entryHashOf(plaintext: string): string {
  return createHash("sha256").update(normalizeEntryText(plaintext), "utf8").digest("hex");
}

export function encryptEntry(
  apiKey: string,
  docId: MemoryDocId,
  projectKey: string,
  plaintext: string,
): CipherEnvelope {
  const entryHash = entryHashOf(plaintext);
  const key = deriveDocKey(apiKey, docId);
  const nonce = randomBytes(CIPHER_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key as unknown as Buffer, nonce);
  cipher.setAAD(Buffer.from(cipherAad(projectKey, docId, entryHash), "utf8"));
  const cipherText = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final(), cipher.getAuthTag()]);
  return {
    entryHash,
    nonce: bytesToBase64(new Uint8Array(nonce)),
    cipherText: bytesToBase64(new Uint8Array(cipherText)),
    keyVersion: keyVersionOf(apiKey),
  };
}

export function decryptEntry(
  apiKey: string,
  docId: MemoryDocId,
  projectKey: string,
  env: CipherEnvelope,
): string {
  const key = deriveDocKey(apiKey, docId);
  const nonce = Buffer.from(env.nonce, "base64");
  const data = Buffer.from(env.cipherText, "base64");
  if (nonce.length !== CIPHER_NONCE_BYTES) throw new Error("bad nonce length");
  if (data.length < 16) throw new Error("ciphertext too short");
  const tag = data.subarray(data.length - 16);
  const body = data.subarray(0, data.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key as unknown as Buffer, nonce);
  decipher.setAAD(Buffer.from(cipherAad(projectKey, docId, env.entryHash), "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
