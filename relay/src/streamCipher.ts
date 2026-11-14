/**
 * Stream frame cipher — relay side (node:crypto).
 *
 * Frame-level transport encryption for the device/viewer links (design §10,
 * docs/plans/20261012-e2ee-stream-design.md). The relay derives the same key
 * from the device's registered API key, decrypts inbound frames (so audit /
 * prompts.jsonl / Remote Prompts keep seeing plaintext exactly as before),
 * then re-encrypts per destination.
 *
 * WIRE FORMAT — byte-compatible mirror of:
 *   src/remote/streamCipher.ts     (device, node:crypto — identical rules)
 *   relay/web/src/streamCipher.ts  (viewer, WebCrypto)
 * Manual sync only; cross-package imports would break build boundaries.
 */
import { createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";

export const STREAM_V1 = "jb-stream-v1";
export const STREAM_CAP = "e2ee-v1";
export type StreamDir = "d2r" | "r2d" | "v2r" | "r2v";

/** Opaque encrypted-frame envelope carried in WS messages. */
export interface StreamEnvelope {
  n: string;
  c: string;
}

/** Derive the 32B AES key for the stream from a relay API key. */
export function deriveStreamKey(apiKey: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(apiKey, "utf8"),
      Buffer.from(STREAM_V1, "utf8"),
      Buffer.from("stream-frame", "utf8"),
      32,
    ),
  );
}

export function isStreamEnvelope(value: unknown): value is StreamEnvelope {
  if (!value || typeof value !== "object") return false;
  const env = value as Record<string, unknown>;
  return typeof env.n === "string" && typeof env.c === "string" && env.n.length > 0 && env.c.length > 0;
}

function nonceOf(seq: number): Buffer {
  const nonce = Buffer.alloc(12);
  // Seq occupies the LAST 4 bytes (big-endian) — identical in all three mirrors.
  nonce.writeUInt32BE(seq, 8);
  return nonce;
}

function seqOfNonce(nonce: Buffer): number {
  return nonce.readUInt32BE(8);
}

/**
 * One direction of one connection: monotonically increasing seq, AES-GCM
 * with the seq bound into the AAD, so any replay/reorder/swap across
 * directions fails the tag check on top of the explicit seq gate.
 */
export class FrameCipher {
  private seq = -1;

  constructor(
    private readonly key: Buffer,
    private readonly dir: StreamDir,
  ) {}

  seal(value: unknown): StreamEnvelope {
    this.seq += 1;
    const nonce = nonceOf(this.seq);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`${STREAM_V1}|${this.dir}|${this.seq}`, "utf8"));
    // undefined would JSON-stringify to undefined and crash Buffer.from —
    // seal null instead (callers should pass {} for "no payload").
    const plain = Buffer.from(JSON.stringify(value === undefined ? null : value), "utf8");
    const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    return { n: nonce.toString("base64"), c: sealed.toString("base64") };
  }

  /** Decrypt + strictly-increasing seq check. null on any tamper/replay. */
  open(env: unknown): { value: unknown } | null {
    if (!isStreamEnvelope(env)) return null;
    let nonce: Buffer;
    let cipherText: Buffer;
    try {
      nonce = Buffer.from(env.n, "base64");
      cipherText = Buffer.from(env.c, "base64");
    } catch {
      return null;
    }
    if (nonce.length !== 12 || cipherText.length <= 16) return null;
    const seq = seqOfNonce(nonce);
    if (seq <= this.seq) return null;
    try {
      const tag = cipherText.subarray(cipherText.length - 16);
      const body = cipherText.subarray(0, cipherText.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
      decipher.setAAD(Buffer.from(`${STREAM_V1}|${this.dir}|${seq}`, "utf8"));
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(body), decipher.final()]);
      this.seq = seq;
      return { value: JSON.parse(plain.toString("utf8")) as unknown };
    } catch {
      return null;
    }
  }
}
