
export const CIPHER_SALT = "jellybot-memory-v1";
export const CIPHER_KEY_BYTES = 32;
export const CIPHER_NONCE_BYTES = 12;
export const KEY_VERSION_HEX = 8;

export type MemoryDocId = "worklog" | "pitfalls" | "style";

export const MEMORY_DOC_IDS: readonly MemoryDocId[] = ["worklog", "pitfalls", "style"];

export function isMemoryDocId(value: unknown): value is MemoryDocId {
  return typeof value === "string" && (MEMORY_DOC_IDS as readonly string[]).includes(value);
}

export function cipherInfoForDoc(docId: MemoryDocId): Uint8Array {
  return new TextEncoder().encode(`jellybot-memory/${docId}`);
}

export function cipherAad(projectKey: string, docId: MemoryDocId, entryHash: string): string {
  return `${projectKey}\n${docId}\n${entryHash}`;
}

export const DOC_ENTRY_CAPS: Record<MemoryDocId, number> = {
  worklog: 200,
  pitfalls: 200,
  style: 1000,
};


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

export function normalizeEntryText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").normalize("NFKC");
}

export interface CipherEnvelope {
  entryHash: string;
  nonce: string;
  cipherText: string;
  keyVersion: string;
}

const ENTRY_HASH_RE = /^[0-9a-f]{64}$/;
const KEY_VERSION_RE = /^[0-9a-f]{8}$/;

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

