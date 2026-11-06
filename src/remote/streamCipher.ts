/**
 * Stream frame cipher — device side (node:crypto).
 *
 * Frame-level transport encryption for the remote relay link (design §10,
 * docs/plans/20261012-e2ee-stream-design.md): WS frames travel encrypted on
 * every hop (device↔relay, viewer↔relay) on top of TLS; the relay holds the
 * derived key so prompts.jsonl / audit / Remote Prompts keep working on
 * plaintext as before.
 *
 * WIRE FORMAT — mirrored in three places that must stay byte-compatible
 * (kept in sync manually; cross-package imports would break build
 * boundaries, same convention as relay/src/protocol.ts):
 *   relay/src/streamCipher.ts      (relay, node:crypto — identical rules)
 *   relay/web/src/streamCipher.ts  (viewer, WebCrypto)
 *
 *   key     = HKDF-SHA256(apiKey, salt="jb-stream-v1", info="stream-frame", 32)
 *   envelope= { n: base64(12B BE seq), c: base64(ct + 16B GCM tag) }
 *   nonce   = 12-byte big-endian seq, per (connection × direction), from 0
 *   aad     = `jb-stream-v1|${dir}|${seq}`   dir ∈ d2r | r2d | v2r | r2v
 *   replay  : receiver rejects seq ≤ lastSeq (strictly increasing)
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

function isEnvelope(value: unknown): value is StreamEnvelope {
  if (!value || typeof value !== "object") return false;
  const env = value as Record<string, unknown>;
  return typeof env.n === "string" && typeof env.c === "string" && env.n.length > 0 && env.c.length > 0;
}

function nonceOf(seq: number): Buffer {
  const nonce = Buffer.alloc(12);
  // Seq occupies the LAST 4 bytes (big-endian) — identical in all three
  // mirrors; keeps seq < 2^32 (4 billion frames per direction, plenty).
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
    if (!isEnvelope(env)) return null;
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
    if (seq <= this.seq) return null; // replay or reorder — drop
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
