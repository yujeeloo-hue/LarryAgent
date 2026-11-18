import { createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";

export const STREAM_V1 = "jb-stream-v1";
export const STREAM_CAP = "e2ee-v1";
export type StreamDir = "d2r" | "r2d" | "v2r" | "r2v";

export interface StreamEnvelope {
  n: string;
  c: string;
}

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
  nonce.writeUInt32BE(seq, 8);
  return nonce;
}

function seqOfNonce(nonce: Buffer): number {
  return nonce.readUInt32BE(8);
}

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
    const plain = Buffer.from(JSON.stringify(value === undefined ? null : value), "utf8");
    const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    return { n: nonce.toString("base64"), c: sealed.toString("base64") };
  }

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
