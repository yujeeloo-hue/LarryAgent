import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4 (service-agnostic, UNSIGNED-PAYLOAD).
 * Zero-dependency implementation shared by Amazon S3 and Tencent COS
 * (COS is SigV4-compatible). Only the pieces the S3 client needs:
 * header-signed requests and presigned GET URLs.
 */

export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
export const ALGORITHM = "AWS4-HMAC-SHA256";

/** URI-encode per RFC 3986 (everything except A-Za-z0-9-._~). */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = "";
  for (const ch of value) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else if (ch === "/") {
      out += encodeSlash ? "%2F" : "/";
    } else {
      for (const byte of Buffer.from(ch, "utf8")) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
  }
  return out;
}

/** Derive the SigV4 signing key (AWS docs example vectors lock this). */
export function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = createHmac("sha256", `AWS4${secretAccessKey}`)
    .update(dateStamp)
    .digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update(service).digest();
  return createHmac("sha256", kService).update("aws4_request").digest();
}

/** sha256 hex digest. */
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Trim + sort headers, return canonical names / pairs for signing. */
function canonicalizeHeaders(
  headers: Record<string, string>,
): { names: string[]; pairs: string } {
  const names = Object.keys(headers)
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length > 0)
    .sort();
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const value = headers[name] ?? "";
    lines.push(
      `${name}:${value.trim().replace(/\s+/g, " ")}`,
    );
  }
  return { names, pairs: lines.join("\n") };
}

export type SignRequestInput = {
  method: string;
  /** Scheme + host + path + query, e.g. https://host/key?x=1 (no fragment). */
  url: string;
  headers: Record<string, string>;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  /** ISO basic date (YYYYMMDD) and datetime (YYYYMMDDThhmmssZ). */
  dateStamp: string;
  amzDate: string;
  /** Payload hash; UNSIGNED-PAYLOAD for S3. */
  payloadHash?: string;
  /** Extra query params merged for signing (used by presign). */
  extraQuery?: Record<string, string>;
};

export type SignedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
};

/** Canonical request string (exposed for tests). */
export function buildCanonicalRequest(
  input: SignRequestInput,
): { canonical: string; signedHeaders: string } {
  const url = new URL(input.url);
  const extra = input.extraQuery ?? {};
  const params = [
    ...Array.from(url.searchParams.entries()).map(
      ([k, v]) => [k, v] as [string, string],
    ),
    ...Object.entries(extra),
  ];
  const canonicalQuery =
    params.length === 0
      ? ""
      : params
          .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
          .sort((a, b) =>
            a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]),
          )
          .map(([k, v]) => `${k}=${v}`)
          .join("&");
  const canonicalPath = uriEncode(decodeURIComponent(url.pathname), false);
  const { names, pairs } = canonicalizeHeaders(input.headers);
  const signedHeaders = names.join(";");
  const payloadHash = input.payloadHash ?? UNSIGNED_PAYLOAD;
  return {
    canonical: [
      input.method.toUpperCase(),
      canonicalPath,
      canonicalQuery,
      pairs,
      "",
      signedHeaders,
      payloadHash,
    ].join("\n"),
    signedHeaders,
  };
}

/** Build the Authorization header for a header-signed request. */
export function signRequest(input: SignRequestInput): SignedRequest {
  const { canonical, signedHeaders } = buildCanonicalRequest(input);
  const scope = `${input.dateStamp}/${input.region}/${input.service}/aws4_request`;
  const canonicalHash = sha256Hex(canonical);
  const stringToSign = [
    ALGORITHM,
    input.amzDate,
    scope,
    canonicalHash,
  ].join("\n");
  const key = deriveSigningKey(
    input.secretAccessKey,
    input.dateStamp,
    input.region,
    input.service,
  );
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  const headers: Record<string, string> = { ...input.headers };
  headers["Authorization"] =
    `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { method: input.method, url: input.url, headers };
}

/** Query-signed (presigned) GET URL — no Authorization header. */
export function presignGet(input: {
  url: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  dateStamp: string;
  amzDate: string;
  expiresInSeconds: number;
}): string {
  const extra: Record<string, string> = {
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${input.accessKeyId}/${input.dateStamp}/${input.region}/${input.service}/aws4_request`,
    "X-Amz-Date": input.amzDate,
    "X-Amz-Expires": String(Math.floor(input.expiresInSeconds)),
    "X-Amz-SignedHeaders": "host",
  };
  const url = new URL(input.url);
  for (const [k, v] of Object.entries(extra)) {
    url.searchParams.set(k, v);
  }
  const { canonical, signedHeaders } = buildCanonicalRequest({
    method: "GET",
    url: input.url,
    headers: { host: url.host },
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
    region: input.region,
    service: input.service,
    dateStamp: input.dateStamp,
    amzDate: input.amzDate,
    extraQuery: extra,
  });
  const scope = `${input.dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    input.amzDate,
    scope,
    sha256Hex(canonical),
  ].join("\n");
  const key = deriveSigningKey(
    input.secretAccessKey,
    input.dateStamp,
    input.region,
    input.service,
  );
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  return `${url.toString()}&X-Amz-Signature=${signature}`;
}
