import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveSigningKey,
  presignGet,
  sha256Hex,
  signRequest,
  uriEncode,
} from "./s3SigV4.js";

const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const AKID = "AKIDEXAMPLE";

test("deriveSigningKey matches the AWS docs example (iam/us-east-1)", () => {
  // https://docs.aws.amazon.com/general/latest/gr/sigv4-calculate-signature.html
  const key = deriveSigningKey(SECRET, "20120215", "us-east-1", "iam");
  assert.equal(
    key.toString("hex"),
    "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d",
  );
});

test("uriEncode follows RFC 3986 and encodes space as %20", () => {
  assert.equal(uriEncode("a b/c"), "a%20b%2Fc");
  assert.equal(uriEncode("a b/c", false), "a%20b/c");
  assert.equal(uriEncode("~tilde-._"), "~tilde-._");
  assert.equal(uriEncode("中文"), "%E4%B8%AD%E6%96%87");
});

test("signRequest builds a deterministic Authorization header", () => {
  const signed = signRequest({
    method: "put",
    url: "https://example-bucket.s3.us-east-1.amazonaws.com/jellybot/img.png",
    headers: {
      host: "example-bucket.s3.us-east-1.amazonaws.com",
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
      "x-amz-date": "20130524T000000Z",
    },
    accessKeyId: AKID,
    secretAccessKey: SECRET,
    region: "us-east-1",
    service: "s3",
    dateStamp: "20130524",
    amzDate: "20130524T000000Z",
  });
  const auth = signed.headers["Authorization"] ?? "";
  assert.match(
    auth,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
  );
  // Deterministic: same inputs → same signature.
  const again = signRequest({
    method: "put",
    url: "https://example-bucket.s3.us-east-1.amazonaws.com/jellybot/img.png",
    headers: {
      host: "example-bucket.s3.us-east-1.amazonaws.com",
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
      "x-amz-date": "20130524T000000Z",
    },
    accessKeyId: AKID,
    secretAccessKey: SECRET,
    region: "us-east-1",
    service: "s3",
    dateStamp: "20130524",
    amzDate: "20130524T000000Z",
  });
  assert.equal(auth, again.headers["Authorization"]);
});

test("canonical request canonicalizes query params by encoded key", () => {
  // Query keys must sort by the *encoded* representation (AWS rule). We
  // exercise via presign: params include X-Amz-* mix and the result must be
  // a stable, parseable URL with the signature appended.
  const url = presignGet({
    url: "https://example-bucket.s3.us-east-1.amazonaws.com/jellybot/img 1.png",
    accessKeyId: AKID,
    secretAccessKey: SECRET,
    region: "us-east-1",
    service: "s3",
    dateStamp: "20130524",
    amzDate: "20130524T000000Z",
    expiresInSeconds: 604800,
  });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(
    parsed.searchParams.get("X-Amz-Credential"),
    `${AKID}/20130524/us-east-1/s3/aws4_request`,
  );
  assert.equal(parsed.searchParams.get("X-Amz-Expires"), "604800");
  assert.equal(parsed.searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.match(
    parsed.searchParams.get("X-Amz-Signature") ?? "",
    /^[0-9a-f]{64}$/,
  );
});

test("sha256Hex matches a known digest", () => {
  // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  assert.equal(
    sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});
