import assert from "node:assert/strict";
import { test } from "node:test";
import type { ObjectStorageConfig } from "../settings/types.js";
import {
  buildModelUrl,
  buildObjectKey,
  objectUrl,
  presignObjectUrl,
  putObject,
  resolveEndpoint,
  testConnection,
  type S3FetchLike,
} from "./s3Client.js";

const AWS_CONFIG: ObjectStorageConfig = {
  provider: "amazon",
  region: "us-east-1",
  bucket: "my-bucket",
  accessKeyId: "AKIDEXAMPLE",
  urlMode: "presigned",
  enabled: true,
};

const COS_CONFIG: ObjectStorageConfig = {
  provider: "tencent",
  region: "ap-guangzhou",
  bucket: "mybucket-1250000000",
  accessKeyId: "AKIDEXAMPLE",
  keyPrefix: "jellybot/",
  urlMode: "public",
  enabled: true,
};

function stubFetch(
  capture: { url: string; method: string; headers: Record<string, string>; body?: Buffer }[],
  status = 200,
): S3FetchLike {
  return async (url, init) => {
    capture.push({ url, method: init.method, headers: init.headers, body: init.body });
    return { status, statusText: status === 200 ? "OK" : "Bad", text: async () => "" };
  };
}

test("resolveEndpoint builds virtual-hosted hosts for both presets", () => {
  assert.equal(resolveEndpoint(AWS_CONFIG).host, "my-bucket.s3.us-east-1.amazonaws.com");
  assert.equal(
    resolveEndpoint(COS_CONFIG).host,
    "mybucket-1250000000.cos.ap-guangzhou.myqcloud.com",
  );
  assert.equal(
    resolveEndpoint({ ...AWS_CONFIG, endpoint: "cdn.example.com/prefix/" }).host,
    "cdn.example.com/prefix",
  );
});

test("buildObjectKey nests date folder + uuid under keyPrefix", () => {
  const now = new Date("2026-08-27T10:00:00Z");
  const key = buildObjectKey(COS_CONFIG, ".png", now);
  assert.match(key, /^jellybot\/20260827\/[0-9a-f-]{36}\.png$/);
  // No prefix config → date at root.
  const bare = buildObjectKey(AWS_CONFIG, "png", now);
  assert.match(bare, /^20260827\/[0-9a-f-]{36}\.png$/);
});

test("objectUrl encodes each path segment but keeps slashes", () => {
  assert.equal(
    objectUrl(AWS_CONFIG, "jellybot/img 1.png"),
    "https://my-bucket.s3.us-east-1.amazonaws.com/jellybot/img%201.png",
  );
});

test("putObject signs PUT with UNSIGNED-PAYLOAD and returns url by mode", async () => {
  const capture: Parameters<typeof stubFetch>[0] = [];
  const fetchImpl = stubFetch(capture);
  const key = "jellybot/20260827/abc.png";
  const result = await putObject(
    { config: AWS_CONFIG, secretAccessKey: "s3cr3t", fetchImpl },
    key,
    Buffer.from("fake-png"),
    "image/png",
  );
  assert.equal(capture.length, 1);
  const call = capture[0]!;
  assert.equal(call.method, "PUT");
  assert.equal(call.url, `https://my-bucket.s3.us-east-1.amazonaws.com/${key}`);
  assert.equal(call.headers["content-type"], "image/png");
  assert.equal(call.headers["x-amz-content-sha256"], "UNSIGNED-PAYLOAD");
  assert.match(
    call.headers["Authorization"] ?? "",
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request/,
  );
  // urlMode presigned → URL carries query signature.
  assert.match(result.url, /X-Amz-Signature=[0-9a-f]{64}/);
  assert.equal(result.key, key);
});

test("buildModelUrl public mode returns unsigned object URL", async () => {
  const url = await buildModelUrl(
    { config: COS_CONFIG, secretAccessKey: "s3cr3t", fetchImpl: stubFetch([]) },
    "jellybot/a.png",
  );
  assert.equal(
    url,
    "https://mybucket-1250000000.cos.ap-guangzhou.myqcloud.com/jellybot/a.png",
  );
});

test("presignObjectUrl embeds expiry and host header scope", () => {
  const url = presignObjectUrl(
    { config: AWS_CONFIG, secretAccessKey: "s3cr3t", fetchImpl: stubFetch([]) },
    "jellybot/a.png",
    3600,
  );
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("X-Amz-Expires"), "3600");
  assert.equal(parsed.searchParams.get("X-Amz-SignedHeaders"), "host");
});

test("testConnection PUTs then DELETEs a probe object", async () => {
  const capture: Parameters<typeof stubFetch>[0] = [];
  await testConnection({
    config: AWS_CONFIG,
    secretAccessKey: "s3cr3t",
    fetchImpl: stubFetch(capture),
  });
  assert.equal(capture.length, 2);
  assert.equal(capture[0]!.method, "PUT");
  assert.match(capture[0]!.url, /_jellybot_probe_[0-9a-f-]{36}\.txt$/);
  assert.equal(capture[1]!.method, "DELETE");
});

test("putObject throws S3Error with status on 403", async () => {
  const capture: Parameters<typeof stubFetch>[0] = [];
  await assert.rejects(
    putObject(
      {
        config: AWS_CONFIG,
        secretAccessKey: "wrong",
        fetchImpl: stubFetch(capture, 403),
      },
      "jellybot/a.png",
      Buffer.from("x"),
      "image/png",
    ),
    /403/,
  );
});
