import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createHandoffLoginStore, createSafeStorageHandoffCipher, type SafeStorageLike } from "./handoffLoginStore.js";

it("keeps accounts separate, matches across paths and decrypts a password only when it is used", async () => {
  const root = await mkdtemp(join(tmpdir(), "handoff-login-test-"));
  const key = randomBytes(32);
  let enabled = true;
  let secretDecryptions = 0;
  const vault = createHandoffLoginStore(root, {
    available: async () => enabled,
    encrypt: async plain => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    },
    decrypt: async encrypted => {
      const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
      decipher.setAuthTag(encrypted.subarray(-16));
      const plain = Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]).toString();
      if ("value" in JSON.parse(plain)) secretDecryptions += 1;
      return plain;
    },
  });
  try {
    const origin = "https://example.test";
    const first = "first@example.test";
    const second = "second@example.test";
    assert.deepEqual(await Promise.all([
      vault.remember(origin + "/login", first, "one fake secret"),
      vault.remember(origin + "/sign-in", second, "  second fake secret  "),
    ]), [true, true]);
    assert.deepEqual(await vault.accounts(origin + "/different-login"), [first, second]);
    assert.deepEqual(await vault.list(), [{ origin, account: first }, { origin, account: second }]);
    assert.equal(await vault.remember(origin, second, "must not overwrite", false), false);
    assert.equal(secretDecryptions, 0);
    const [siteDirectory] = await readdir(join(root, "handoff-logins"));
    const files = join(root, "handoff-logins", siteDirectory!);
    for (const file of await readdir(files)) {
      assert.doesNotMatch(await readFile(join(files, file), "utf8"), /example\.test|fake secret/);
    }
    const use = async (secret: string) => {
      assert.equal(secret, "  second fake secret  ");
      return true;
    };
    assert.equal(await vault.use(origin, second, use), true);
    assert.equal(await vault.use(origin, "unknown", use), false);
    assert.equal(await vault.use("https://sub.example.test", second, use), false);
    assert.equal(await vault.use("https://example.test:444", second, use), false);
    assert.equal(await vault.use("http://example.test", second, use), false);
    assert.equal(secretDecryptions, 1);
    assert.equal(await vault.remember(origin, second, "replacement"), true);
    assert.equal(await vault.use(origin, second, async secret => secret === "replacement"), true);
    assert.equal(await vault.remove("https://other.example.test", second), false);
    assert.equal(await vault.remove(origin, second), true);
    assert.deepEqual(await vault.list(), [{ origin, account: first }]);
    enabled = false;
    assert.equal(await vault.remember(origin, second, "no plaintext fallback"), false);
    assert.equal(await vault.use(origin, second, use), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function storageDouble(): SafeStorageLike & { asyncEncrypts: number; syncEncrypts: number } {
  return {
    asyncEncrypts: 0,
    syncEncrypts: 0,
    isEncryptionAvailable: () => true,
    encryptString: (plain) => {
      storage.syncEncrypts += 1;
      return Buffer.from(`sync:${plain}`);
    },
    decryptString: (encrypted) => encrypted.toString().replace(/^sync:/, ""),
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (plain) => {
      storage.asyncEncrypts += 1;
      return Buffer.from(`async:${plain}`);
    },
    decryptStringAsync: async (encrypted) => ({ result: encrypted.toString().replace(/^async:/, "") }),
  };
}

let storage: ReturnType<typeof storageDouble>;

it("prefers async safeStorage and keeps the sync keychain off the Mac path", async () => {
  storage = storageDouble();
  const cipher = createSafeStorageHandoffCipher(storage, "darwin");
  assert.equal(await cipher.available(), true);
  assert.equal((await cipher.encrypt("secret")).toString(), "async:secret");
  assert.equal(await cipher.decrypt(Buffer.from("async:secret")), "secret");
  assert.equal(storage.asyncEncrypts, 1);
  assert.equal(storage.syncEncrypts, 0);

  storage.isAsyncEncryptionAvailable = async () => false;
  storage = { ...storage, asyncEncrypts: 0, syncEncrypts: 0 };
  const stale = createSafeStorageHandoffCipher({
    ...storageDouble(),
    isAsyncEncryptionAvailable: async () => false,
  }, "darwin");
  assert.equal(await stale.available(), false);
  await assert.rejects(stale.encrypt("secret"), /unavailable/);
});

it("uses sync DPAPI on Windows when async encryption is unavailable", async () => {
  let syncEncrypts = 0;
  const cipher = createSafeStorageHandoffCipher({
    isEncryptionAvailable: () => true,
    encryptString: (plain) => {
      syncEncrypts += 1;
      return Buffer.from(`sync:${plain}`);
    },
    decryptString: (encrypted) => encrypted.toString().replace(/^sync:/, ""),
    isAsyncEncryptionAvailable: async () => false,
    encryptStringAsync: async () => {
      throw new Error("async should not run");
    },
    decryptStringAsync: async () => {
      throw new Error("async should not run");
    },
  }, "win32");
  assert.equal(await cipher.available(), true);
  assert.equal((await cipher.encrypt("secret")).toString(), "sync:secret");
  assert.equal(await cipher.decrypt(Buffer.from("sync:secret")), "secret");
  assert.equal(syncEncrypts, 1);
});
