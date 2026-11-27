
export const STREAM_V1 = "jb-stream-v1";
export const STREAM_CAP = "e2ee-v1";
export type StreamDir = "d2r" | "r2d" | "v2r" | "r2v";

export interface StreamEnvelope {
  n: string;
  c: string;
}

const encoder = new TextEncoder();

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

export async function deriveStreamKey(apiKey: string): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey("raw", encoder.encode(apiKey), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(STREAM_V1), info: encoder.encode("stream-frame") },
    ikm,
    256,
  );
  return new Uint8Array(bits);
}

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
  return (((b8 << 24) | (b9 << 16) | (b10 << 8) | b11) >>> 0);
}

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
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bufSource(nonce), additionalData: bufSource(this.aadFor(this.seq)), tagLength: 128 },
      key,
      bufSource(encoder.encode(JSON.stringify(value === undefined ? null : value))),
    );
    return { n: bytesToBase64(nonce), c: bytesToBase64(new Uint8Array(ct)) };
  }

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
