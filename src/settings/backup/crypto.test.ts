import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BackupPassphraseError,
  decryptBackupPayload,
  encryptBackupPayload,
  type BackupCryptoEnvelope,
} from "./crypto.js";

describe("backup crypto", () => {
  it("round-trips a payload through encrypt/decrypt", () => {
    const payload = JSON.stringify({
      settings: { providers: [{ id: "deepseek" }] },
      secrets: { deepseek: "sk-test-123" },
    });
    const envelope = encryptBackupPayload(payload, "correct horse battery");
    const decrypted = decryptBackupPayload(envelope, "correct horse battery");
    assert.equal(decrypted, payload);
  });

  it("never embeds the plaintext or passphrase in the envelope", () => {
    const payload = "sk-super-secret-key-material";
    const envelope = encryptBackupPayload(payload, "hunter2-pass");
    const serialized = JSON.stringify(envelope);
    assert.ok(!serialized.includes(payload));
    assert.ok(!serialized.includes("hunter2-pass"));
  });

  it("uses fresh salt/iv per encryption (identical input, different output)", () => {
    const a = encryptBackupPayload("same", "pass");
    const b = encryptBackupPayload("same", "pass");
    assert.notEqual(a.salt, b.salt);
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.data, b.data);
  });

  it("rejects a wrong passphrase", () => {
    const envelope = encryptBackupPayload("payload", "right");
    assert.throws(
      () => decryptBackupPayload(envelope, "wrong"),
      BackupPassphraseError,
    );
  });

  it("rejects tampered ciphertext (auth tag check)", () => {
    const envelope = encryptBackupPayload("payload", "pass");
    const bytes = Buffer.from(envelope.data, "base64");
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered: BackupCryptoEnvelope = {
      ...envelope,
      data: bytes.toString("base64"),
    };
    assert.throws(
      () => decryptBackupPayload(tampered, "pass"),
      BackupPassphraseError,
    );
  });

  it("rejects a tampered auth tag", () => {
    const envelope = encryptBackupPayload("payload", "pass");
    const tag = Buffer.from(envelope.authTag, "base64");
    tag[0] = tag[0]! ^ 0xff;
    const tampered: BackupCryptoEnvelope = {
      ...envelope,
      authTag: tag.toString("base64"),
    };
    assert.throws(
      () => decryptBackupPayload(tampered, "pass"),
      BackupPassphraseError,
    );
  });

  it("rejects an empty passphrase on both paths", () => {
    assert.throws(() => encryptBackupPayload("x", ""), Error);
    assert.throws(
      () => decryptBackupPayload({}, ""),
      BackupPassphraseError,
    );
  });

  it("rejects non-object / unknown-format envelopes", () => {
    assert.throws(() => decryptBackupPayload(null, "p"), BackupPassphraseError);
    assert.throws(() => decryptBackupPayload("nope", "p"), BackupPassphraseError);
    assert.throws(
      () => decryptBackupPayload({ v: 99 }, "p"),
      BackupPassphraseError,
    );
    assert.throws(
      () =>
        decryptBackupPayload(
          { v: 1, kdf: "pbkdf2", cipher: "aes-256-gcm" },
          "p",
        ),
      BackupPassphraseError,
    );
  });

  it("rejects missing / corrupt base64 fields", () => {
    const envelope = encryptBackupPayload("payload", "pass");
    const { data, ...missingData } = envelope;
    void data;
    assert.throws(
      () => decryptBackupPayload(missingData, "pass"),
      BackupPassphraseError,
    );
    const junk = { ...envelope, salt: "!!!not-base64!!!" };
    assert.throws(
      () => decryptBackupPayload(junk, "pass"),
      BackupPassphraseError,
    );
  });

  it("rejects hostile scrypt cost parameters (memory DoS guard)", () => {
    const envelope = encryptBackupPayload("payload", "pass");
    const hostile = {
      ...envelope,
      scrypt: { n: 1 << 22, r: 64, p: 1 },
    };
    assert.throws(
      () => decryptBackupPayload(hostile, "pass"),
      BackupPassphraseError,
    );
  });

  it("decrypts envelopes with lower custom scrypt params (forward compat)", () => {
    // Hand-roll an envelope with non-default (but sane) params to prove the
    // reader honors the envelope's stored params rather than constants.
    const { createCipheriv, randomBytes, scryptSync } = require("node:crypto") as {
      createCipheriv: typeof import("node:crypto")["createCipheriv"];
      randomBytes: typeof import("node:crypto")["randomBytes"];
      scryptSync: typeof import("node:crypto")["scryptSync"];
    };
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync("pass", salt, 32, { N: 8192, r: 8, p: 1 });
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update("hello", "utf8"), cipher.final()]);
    const envelope: BackupCryptoEnvelope = {
      v: 1,
      kdf: "scrypt",
      scrypt: { n: 8192, r: 8, p: 1 },
      cipher: "aes-256-gcm",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    assert.equal(decryptBackupPayload(envelope, "pass"), "hello");
  });
});
