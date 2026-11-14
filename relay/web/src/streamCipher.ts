/**
 * Stream frame cipher — viewer side (WebCrypto).
 *
 * Frame-level transport encryption for the remote relay link (design §10,
 * docs/plans/20261012-e2ee-stream-design.md). API-key viewers derive the key
 * locally from their key; console (session-token) viewers receive the
 * derived key in the `streamKey` frame on subscribe.
 *
 * WIRE FORMAT — byte-compatible mirror of (manual sync only):
 *   src/remote/streamCipher.ts  (device, node:crypto)
 *   relay/src/streamCipher.ts   (relay, node:crypto)
 *
 *   key      = HKDF-SHA256(apiKey, salt="jb-stream-v1", info="stream-frame", 32)
 *   envelope = { n: base64(12B BE seq), c: base64(ct + 16B GCM tag) }
 *   aad      = `jb-stream-v1|${dir}|${seq}`
 */

export const STREAM_V1 = "jb-stream-v1";
export const STREAM_CAP = "e2ee-v1";
export type StreamDir = "d2r" | "r2d" | "v2r" | "r2v";

/** Opaque encrypted-frame envelope carried in WS messages. */
export interface StreamEnvelope {
  n: string;
  c: string;
}

const encoder = new TextEncoder();

/**
 * TS lib's BufferSource wants ArrayBuffer-backed views; Uint8Array's
 * default generic is ArrayBufferLike. Runtime-wise identical bytes.
 */
function bufSource(view: Uint8Array): BufferSource {
  return view as unknown as BufferSource;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Derive the 32B stream key from a relay API key (HKDF via WebCrypto). */
export async function deriveStreamKey(apiKey: string): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey("raw", encoder.encode(apiKey), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(STREAM_V1), info: encoder.encode("stream-frame") },
    ikm,
    256,
  );
  return new Uint8Array(bits);
}

/** Import a base64 32B key delivered by the relay `streamKey` frame. */
export function keyFromBase64(b64: string): Uint8Array | null {
  try {
    const bytes = base64ToBytes(b64);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

function nonceOf(seq: number): Uint8Array {
  const nonce = new Uint8Array(12);
  // Seq occupies the LAST 4 bytes (big-endian) — matches the node mirrors'
  // writeUInt32BE(seq, 8); seq < 2^32 as over there.
  nonce[8] = (seq >>> 24) & 0xff;
  nonce[9] = (seq >>> 16) & 0xff;
  nonce[10] = (seq >>> 8) & 0xff;
  nonce[11] = seq & 0xff;
  return nonce;
}

function seqOfNonce(nonce: Uint8Array): number {
  if (nonce.length !== 12) return -1;
  const b8 = nonce[8] ?? 0;
  const b9 = nonce[9] ?? 0;
  const b10 = nonce[10] ?? 0;
  const b11 = nonce[11] ?? 0;
  // >>> 0 keeps the composed value unsigned (b8 << 24 can flip the sign bit).
  return (((b8 << 24) | (b9 << 16) | (b10 << 8) | b11) >>> 0);
}

/**
 * One direction of one connection: monotonic seq, AES-GCM with the seq in
 * the AAD. Async because WebCrypto is; wire-identical to the node mirrors.
 */
export class FrameCipher {
  private seq = -1;
  private aesKey: CryptoKey | null = null;
  private readonly aadCache = new Map<number, Uint8Array>();

  constructor(
    private readonly key: Uint8Array,
    private readonly dir: StreamDir,
  ) {}

  private async ensureKey(): Promise<CryptoKey> {
    if (!this.aesKey) {
      this.aesKey = await crypto.subtle.importKey("raw", bufSource(this.key), "AES-GCM", false, ["encrypt", "decrypt"]);
    }
    return this.aesKey;
  }

  private aadFor(seq: number): Uint8Array {
    let aad = this.aadCache.get(seq);
    if (!aad) {
      aad = encoder.encode(`${STREAM_V1}|${this.dir}|${seq}`);
      this.aadCache.set(seq, aad);
    }
    return aad;
  }

  async seal(value: unknown): Promise<StreamEnvelope> {
    const key = await this.ensureKey();
    this.seq += 1;
    const nonce = nonceOf(this.seq);
    // undefined would JSON-stringify to undefined — seal null instead
    // (callers should pass {} for "no payload"); mirrors the node side.
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bufSource(nonce), additionalData: bufSource(this.aadFor(this.seq)), tagLength: 128 },
      key,
      bufSource(encoder.encode(JSON.stringify(value === undefined ? null : value))),
    );
    return { n: bytesToBase64(nonce), c: bytesToBase64(new Uint8Array(ct)) };
  }

  /** Decrypt + strictly-increasing seq check. null on any tamper/replay. */
  async open(env: unknown): Promise<{ value: unknown } | null> {
    if (!env || typeof env !== "object") return null;
    const { n, c } = env as Record<string, unknown>;
    if (typeof n !== "string" || typeof c !== "string" || !n || !c) return null;
    let nonce: Uint8Array;
    let cipherText: Uint8Array;
    try {
      nonce = base64ToBytes(n);
      cipherText = base64ToBytes(c);
    } catch {
      return null;
    }
    const seq = seqOfNonce(nonce);
    if (seq < 0 || cipherText.length <= 16) return null;
    if (seq <= this.seq) return null;
    try {
      const key = await this.ensureKey();
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bufSource(nonce), additionalData: bufSource(this.aadFor(seq)), tagLength: 128 },
        key,
        bufSource(cipherText),
      );
      this.seq = seq;
      return { value: JSON.parse(new TextDecoder().decode(plain)) as unknown };
    } catch {
      return null;
    }
  }
}
