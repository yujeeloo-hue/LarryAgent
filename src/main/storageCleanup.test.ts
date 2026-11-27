import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { COMPUTER_USE_CACHE_DIR_NAME } from "../tools/computerUse/cache.js";
import { CACHE_DIR_NAMES, cleanupStorage, scanStorageUsage } from "./storageCleanup.js";

describe("storage cleanup", () => {
  it("scans and clears computer use screenshots from the app cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "jellybot-storage-test-"));
    const tmpRoot = join(root, "tmp");
    try {
      const cacheDir = join(root, COMPUTER_USE_CACHE_DIR_NAME);
      const screenshot = join(cacheDir, "capture.png");
      await mkdir(cacheDir, { recursive: true });
      await writeFile(screenshot, Buffer.alloc(2048, 1));
      assert.ok(CACHE_DIR_NAMES.includes(COMPUTER_USE_CACHE_DIR_NAME));

      const usage = await scanStorageUsage(root, { tmpRoot });
      assert.equal(usage.caches.files, 1);
      assert.equal(usage.caches.bytes, 2048);

      const result = await cleanupStorage(root, { tmpRoot });
      assert.equal(result.categories.caches.files, 1);
      assert.equal(result.categories.caches.bytes, 2048);
      await assert.rejects(stat(screenshot));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
