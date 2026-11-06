/**
 * Memory-sync cipher envelope — platform-neutral core (zero imports).
 *
 * Single source of truth for the record-level encryption format shared by
 * three consumers: the relay server, the desktop client (node:crypto via
 * memoryCipherNode.ts) and the web console (WebCrypto). Only the crypto
 * primitives differ; every byte of the envelope — salt, info, AAD layout,
 * keyVersion fingerprint, base64 encodings — is defined HERE so the three
 * implementations stay wire-compatible by construction.
 *
 * Envelope (see docs/plans/memory-sync-design.md §4):
 *   key       = HKDF-SHA256(ikm = relay API key, salt = CIPHER_SALT,
 *                            info = docId, len = 32)
 *   cipher    = AES-256-GCM(plaintext, key, nonce = 12B random,
 *                            aad = AAD(projectKey, docId, entryHash))
 *   keyVersion= sha256(apiKey) first 8 hex chars
 */

export const CIPHER_SALT = "jellybot-memory-v1";
export const CIPHER_KEY_BYTES = 32;
export const CIPHER_NONCE_BYTES = 12;
export const KEY_VERSION_HEX = 8;

/** Doc ids that participate in memory sync (independent structured tables). */
export type MemoryDocId = "worklog" | "pitfalls" | "style";

export const MEMORY_DOC_IDS: readonly MemoryDocId[] = ["worklog", "pitfalls", "style"];

export function isMemoryDocId(value: unknown): value is MemoryDocId {
  return typeof value === "string" && (MEMORY_DOC_IDS as readonly string[]).includes(value);
}

/** HKDF `info` per doc — binds each doc's records to their own key stream. */
export function cipherInfoForDoc(docId: MemoryDocId): Uint8Array {
  return new TextEncoder().encode(`jellybot-memory/${docId}`);
}

/**
 * AAD string: binds a ciphertext to its identity so records cannot be
 * swapped across projects/docs/entries without detection.
 */
export function cipherAad(projectKey: string, docId: MemoryDocId, entryHash: string): string {
  return `${projectKey}\n${docId}\n${entryHash}`;
}

/** Server-side per-doc entry caps (oldest squeezed out; design §3). */
export const DOC_ENTRY_CAPS: Record<MemoryDocId, number> = {
  worklog: 200,
  pitfalls: 200,
  style: 1000,
};

// ── encoding helpers (same semantics in node and WebCrypto callers) ──

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  if (typeof btoa === "function") return btoa(binary);
  return Buffer.from(bytes).toString("base64");
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

/**
 * Canonical entry plaintext hashing — normalize so the same logical line
 * hashed on two machines matches. Whitespace at line ends and CRLF are the
 * only edits the local writers are allowed to introduce silently.
 */
export function normalizeEntryText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").normalize("NFKC");
}

/** Encrypted record as it travels over the wire and sits in the DB. */
export interface CipherEnvelope {
  /** sha256(normalizeEntryText(plaintext)) — dedup key, stored in clear. */
  entryHash: string;
  /** base64(12B nonce). */
  nonce: string;
  /** base64(AES-256-GCM ciphertext incl. 16B tag). */
  cipherText: string;
  /** sha256(apiKey) first 8 hex — fingerprint of the encrypting key. */
  keyVersion: string;
}

const ENTRY_HASH_RE = /^[0-9a-f]{64}$/;
const KEY_VERSION_RE = /^[0-9a-f]{8}$/;

/** Structural validation before anything touches crypto or the DB. */
export function isValidCipherEnvelope(env: unknown): env is CipherEnvelope {
  if (typeof env !== "object" || env === null) return false;
  const e = env as Record<string, unknown>;
  return (
    typeof e.entryHash === "string" && ENTRY_HASH_RE.test(e.entryHash) &&
    typeof e.nonce === "string" && e.nonce.length >= 16 && e.nonce.length <= 20 &&
    typeof e.cipherText === "string" && e.cipherText.length >= 4 && e.cipherText.length <= 4096 &&
    typeof e.keyVersion === "string" && KEY_VERSION_RE.test(e.keyVersion)
  );
}

