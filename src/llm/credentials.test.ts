import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";

import {
  configureCredentialCipherForTests,
  configureCredentialsRoot,
  configureLegacyKeyBridgeForTests,
  deleteApiKeyFromStore,
  hasApiKeyInStore,
  readApiKeyFromStore,
  writeApiKeyToStore,
} from "./credentials.js";
import type {
  CredentialCipher,
  LegacyKeyBridge,
} from "./credentials.js";
import { DEFAULT_PROVIDER_ID } from "../settings/types.js";

/** base64 "cipher" — deterministic and reversible so roundtrips are provable. */
const fakeCipher: CredentialCipher = {
  mode: "safeStorage",
  encrypt: (plainText) => Buffer.from(`enc:${plainText}`, "utf8").toString("base64"),
  decrypt: (payload) => {
    const decoded = Buffer.from(payload, "base64").toString("utf8");
    if (!decoded.startsWith("enc:")) throw new Error("corrupt payload");
    return decoded.slice(4);
  },
};

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "jellybot-credentials-test-"));
}

function storeFile(root: string): { encryption: string; keys: Record<string, string> } {
  return JSON.parse(readFileSync(join(root, "llm-api-keys.json"), "utf8"));
}

afterEach(() => {
  configureCredentialCipherForTests(undefined);
  configureLegacyKeyBridgeForTests(undefined);
});

describe("credentials store", () => {
  it("round-trips a key per provider with the injected cipher", async () => {
    const root = newRoot();
    configureCredentialsRoot(root);
    configureCredentialCipherForTests(fakeCipher);

    await writeApiKeyToStore("sk-chat", DEFAULT_PROVIDER_ID);
    await writeApiKeyToStore("sk-vision", "vision");

    const stored = storeFile(root);
    assert.equal(stored.encryption, "safeStorage");
    // Value on disk is encrypted, not plaintext.
    assert.ok(!JSON.stringify(stored).includes("sk-chat"));
    assert.equal(await readApiKeyFromStore(DEFAULT_PROVIDER_ID), "sk-chat");
    assert.equal(await readApiKeyFromStore("vision"), "sk-vision");
    assert.equal(await hasApiKeyInStore("vision"), true);
    assert.equal(await hasApiKeyInStore("imagegen"), false);
  });

  it("overwrites an existing key via add-style update", async () => {
    configureCredentialsRoot(newRoot());
    configureCredentialCipherForTests(fakeCipher);

    await writeApiKeyToStore("first");
    await writeApiKeyToStore("second");

    assert.equal(await readApiKeyFromStore(), "second");
  });

  it("delete removes the entry and reports absent afterwards", async () => {
    configureCredentialsRoot(newRoot());
    configureCredentialCipherForTests(fakeCipher);

    await writeApiKeyToStore("secret", "imagegen");
    assert.equal(await hasApiKeyInStore("imagegen"), true);

    await deleteApiKeyFromStore("imagegen");
    assert.equal(await hasApiKeyInStore("imagegen"), false);
    assert.equal(await readApiKeyFromStore("imagegen"), null);
  });

  it("migrates a legacy keychain entry on first read and removes the source", async () => {
    const root = newRoot();
    configureCredentialsRoot(root);
    configureCredentialCipherForTests(fakeCipher);

    let bridgeReads = 0;
    let bridgeRemoves = 0;
    const bridge: LegacyKeyBridge = {
      read: () => {
        bridgeReads += 1;
        return Promise.resolve(bridgeReads === 1 ? "legacy-secret" : null);
      },
      remove: () => {
        bridgeRemoves += 1;
        return Promise.resolve();
      },
    };
    configureLegacyKeyBridgeForTests(bridge);

    assert.equal(await readApiKeyFromStore(DEFAULT_PROVIDER_ID), "legacy-secret");
    assert.equal(bridgeRemoves, 1);
    assert.ok(!JSON.stringify(storeFile(root)).includes("legacy-secret"));

    // Second read is served from the store — no legacy traffic.
    assert.equal(await readApiKeyFromStore(), "legacy-secret");
    assert.equal(bridgeReads, 1);
  });

  it("migration failure of remove() still serves the migrated value", async () => {
    configureCredentialsRoot(newRoot());
    configureCredentialCipherForTests(fakeCipher);
    configureLegacyKeyBridgeForTests({
      read: () => Promise.resolve("kept-secret"),
      remove: () => Promise.reject(new Error("locked")),
    });

    assert.equal(await readApiKeyFromStore(), "kept-secret");
    assert.equal(await readApiKeyFromStore(), "kept-secret");
  });

  it("plain-mode fallback writes readable utf8-base64 without throwing", async () => {
    const root = newRoot();
    configureCredentialsRoot(root);
    // No override → auto-detection finds no electron in node --test → plain.

    await writeApiKeyToStore("plain-key", "vision");
    const stored = storeFile(root);
    assert.equal(stored.encryption, "plain");
    const payload = stored.keys.vision;
    assert.equal(typeof payload, "string");
    assert.equal(
      Buffer.from(payload ?? "", "base64").toString("utf8"),
      "plain-key",
    );
    assert.equal(await readApiKeyFromStore("vision"), "plain-key");
  });

  it("empty key rejects and corrupted entries resolve to null", async () => {
    const root = newRoot();
    configureCredentialsRoot(root);
    configureCredentialCipherForTests(fakeCipher);

    await assert.rejects(writeApiKeyToStore("   "), /API key is empty/);

    await writeApiKeyToStore("good", "imagegen");
    const stored = storeFile(root);
    stored.keys.imagegen = Buffer.from("not-a-valid-blob", "utf8").toString("base64");
    writeFileSync(join(root, "llm-api-keys.json"), JSON.stringify(stored));

    assert.equal(await readApiKeyFromStore("imagegen"), null);
  });
});
