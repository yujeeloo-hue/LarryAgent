import { randomUUID } from "node:crypto";
import type { ObjectStorageConfig } from "../settings/types.js";
import { presignGet, signRequest, uriEncode } from "./s3SigV4.js";

/**
 * S3-compatible object storage client (Amazon S3 / Tencent COS).
 * Virtual-hosted-style addressing, SigV4 UNSIGNED-PAYLOAD.
 * HTTP is injected so tests can stub transport without network.
 */

export const S3_SERVICE = "s3";
/** Presigned GET lifetime (7 days). */
export const PRESIGN_EXPIRES_SECONDS = 7 * 24 * 60 * 60;
/** Request timeout for S3 operations. */
export const S3_TIMEOUT_MS = 30_000;

export type S3EndpointInfo = {
  /** Origin without scheme, e.g. `bucket.s3.us-east-1.amazonaws.com`. */
  host: string;
  /** Base object URL builder origin, e.g. `https://bucket.s3.us-east-1.amazonaws.com`. */
  origin: string;
  region: string;
};

/**
 * Resolve the virtual-hosted-style endpoint host for a config.
 * - amazon: `https://<bucket>.s3.<region>.amazonaws.com`
 * - tencent: `https://<bucket>.cos.<region>.myqcloud.com`
 *   (COS bucket names carry the appid suffix: `<name>-<appid>`)
 * - custom endpoint: used as-is when set.
 */
export function resolveEndpoint(config: ObjectStorageConfig): S3EndpointInfo {
  const region = config.region.trim();
  const bucket = config.bucket.trim();
  const custom = config.endpoint?.trim();
  const host = custom
    ? custom.replace(/^https?:\/\//, "").replace(/\/+$/, "")
    : config.provider === "tencent"
      ? `${bucket}.cos.${region}.myqcloud.com`
      : `${bucket}.s3.${region}.amazonaws.com`;
  return { host, origin: `https://${host}`, region };
}

/** Object URL (unsigned) — canonical form for public mode. */
export function objectUrl(config: ObjectStorageConfig, key: string): string {
  const { origin } = resolveEndpoint(config);
  return `${origin}/${key.split("/").map((seg) => uriEncode(seg)).join("/")}`;
}

/** Build the object key for a new upload: `<keyPrefix><yyyyMMdd>/<uuid>.<ext>`. */
export function buildObjectKey(
  config: ObjectStorageConfig,
  ext: string,
  now = new Date(),
): string {
  const prefix = config.keyPrefix ?? "";
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const cleanExt = ext.replace(/^\.+/, "").toLowerCase();
  return `${prefix}${date}/${randomUUID()}${cleanExt ? `.${cleanExt}` : ""}`;
}

function amzTimestamps(now = new Date()): {
  dateStamp: string;
  amzDate: string;
} {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { dateStamp: iso.slice(0, 8), amzDate: `${iso.slice(0, 15)}Z` };
}

export type S3FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: Buffer;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; statusText: string; text(): Promise<string> }>;

export type S3ClientOptions = {
  config: ObjectStorageConfig;
  secretAccessKey: string;
  fetchImpl?: S3FetchLike;
  now?: () => Date;
};

export type S3PutResult = {
  key: string;
  url: string;
};

export class S3Error extends Error {
  readonly status: number;
  constructor(
    message: string,
    status: number,
    readonly bodyText?: string,
  ) {
    super(message);
    this.name = "S3Error";
    this.status = status;
  }
}

async function s3Fetch(
  opts: S3ClientOptions,
  method: "PUT" | "DELETE" | "GET" | "HEAD",
  key: string,
  init: { body?: Buffer; contentType?: string; signal?: AbortSignal } = {},
): Promise<{ status: number; bodyText: string; url: string }> {
  const { config } = opts;
  const { host, origin, region } = resolveEndpoint(config);
  const path = `/${key.split("/").map((seg) => uriEncode(seg)).join("/")}`;
  const url = `${origin}${path}`;
  const { dateStamp, amzDate } = amzTimestamps(opts.now?.() ?? new Date());
  const headers: Record<string, string> = {
    host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
  };
  if (init.contentType) {
    headers["content-type"] = init.contentType;
  }
  const signed = signRequest({
    method,
    url,
    headers,
    accessKeyId: config.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    region,
    service: S3_SERVICE,
    dateStamp,
    amzDate,
  });
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const timeout = AbortSignal.timeout(S3_TIMEOUT_MS);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout;
  const res = await fetchImpl(url, {
    method,
    headers: signed.headers,
    ...(init.body ? { body: init.body } : {}),
    signal,
  });
  const bodyText = await res.text().catch(() => "");
  if (res.status >= 300) {
    throw new S3Error(
      `${method} ${key} failed: ${res.status} ${res.statusText}`,
      res.status,
      bodyText,
    );
  }
  return { status: res.status, bodyText, url };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function defaultFetch(
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: Buffer;
    signal?: AbortSignal;
  },
): Promise<{ status: number; statusText: string; text(): Promise<string> }> {
  const res = await (globalThis as any).fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body ? { body: new Uint8Array(init.body) } : {}),
    signal: init.signal,
  });
  return {
    status: res.status,
    statusText: res.statusText,
    text: () => res.text(),
  };
}

/** Upload bytes and return the object key + model-facing URL per urlMode. */
export async function putObject(
  opts: S3ClientOptions,
  key: string,
  body: Buffer,
  contentType: string,
  signal?: AbortSignal,
): Promise<S3PutResult> {
  await s3Fetch(opts, "PUT", key, {
    body,
    contentType,
    ...(signal ? { signal } : {}),
  });
  const url = await buildModelUrl(opts, key);
  return { key, url };
}

/** Presigned GET URL for private buckets. */
export function presignObjectUrl(
  opts: S3ClientOptions,
  key: string,
  expiresInSeconds = PRESIGN_EXPIRES_SECONDS,
): string {
  const { config } = opts;
  const { host, origin, region } = resolveEndpoint(config);
  const path = `/${key.split("/").map((seg) => uriEncode(seg)).join("/")}`;
  const { dateStamp, amzDate } = amzTimestamps(opts.now?.() ?? new Date());
  return presignGet({
    url: `${origin}${path}`,
    accessKeyId: config.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    region,
    service: S3_SERVICE,
    dateStamp,
    amzDate,
    expiresInSeconds,
  });
}

/** Model-facing URL according to config urlMode (presigned | public). */
export async function buildModelUrl(
  opts: S3ClientOptions,
  key: string,
): Promise<string> {
  const { config } = opts;
  if (config.urlMode === "public") {
    return objectUrl(config, key);
  }
  return presignObjectUrl(opts, key);
}

/**
 * Connectivity + credentials probe: PUT a tiny probe object then DELETE it.
 * Throws S3Error with status/message on failure (403 → bad credentials,
 * 404 → wrong bucket/endpoint, network errors → TypeError from fetch).
 */
export async function testConnection(
  opts: S3ClientOptions,
  signal?: AbortSignal,
): Promise<void> {
  const { config } = opts;
  const key = `${config.keyPrefix ?? ""}_jellybot_probe_${randomUUID()}.txt`;
  await s3Fetch(opts, "PUT", key, {
    body: Buffer.from("jellybot-probe", "utf8"),
    contentType: "text/plain",
    ...(signal ? { signal } : {}),
  });
  try {
    await s3Fetch(opts, "DELETE", key, ...(signal ? [{ signal }] : []));
  } catch {
    // Probe object left behind is harmless; connection itself verified.
  }
}
