/**
 * Token Hub secret envelope. Provider endpoints and API keys are AES-256-GCM
 * ciphertext in SQLite; the 32-byte key lives in a separate 0600 file.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type TokenHubSecret = {
  apiKey: string;
  baseUrl: string;
};

/**
 * Generic hub secret envelope (AES-256-GCM, AAD binds scope + row id).
 * Shared by Token Hub ({apiKey, baseUrl}) and MCP Hub (transport JSON).
 */
export function encryptHubSecret(
  key: Uint8Array,
  scope: string,
  id: string,
  plaintext: string,
): { nonce: string; cipherText: string } {
  if (key.byteLength !== 32) throw new Error("hub key must be 32 bytes");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), nonce);
  cipher.setAAD(Buffer.from(`${scope}\0${id}`, "utf8"));
  const cipherText = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final(), cipher.getAuthTag()]);
  return { nonce: nonce.toString("base64"), cipherText: cipherText.toString("base64") };
}

export function decryptHubSecret(
  key: Uint8Array,
  scope: string,
  id: string,
  nonceB64: string,
  cipherTextB64: string,
): string {
  if (key.byteLength !== 32) throw new Error("hub key must be 32 bytes");
  const nonce = Buffer.from(nonceB64, "base64");
  const data = Buffer.from(cipherTextB64, "base64");
  if (nonce.length !== NONCE_BYTES) throw new Error("bad nonce length");
  if (data.length < TAG_BYTES) throw new Error("ciphertext too short");
  const tag = data.subarray(data.length - TAG_BYTES);
  const body = data.subarray(0, data.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), nonce);
  decipher.setAAD(Buffer.from(`${scope}\0${id}`, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export function encryptTokenHubSecret(
  key: Uint8Array,
  providerId: string,
  secret: TokenHubSecret,
): { nonce: string; cipherText: string } {
  return encryptHubSecret(key, "token-hub", providerId, JSON.stringify(secret));
}

export function decryptTokenHubSecret(
  key: Uint8Array,
  providerId: string,
  nonceB64: string,
  cipherTextB64: string,
): TokenHubSecret {
  const json = decryptHubSecret(key, "token-hub", providerId, nonceB64, cipherTextB64);
  const parsed = JSON.parse(json) as Partial<TokenHubSecret>;
  if (typeof parsed.apiKey !== "string" || typeof parsed.baseUrl !== "string") {
    throw new Error("secret payload is invalid");
  }
  return { apiKey: parsed.apiKey, baseUrl: parsed.baseUrl };
}
