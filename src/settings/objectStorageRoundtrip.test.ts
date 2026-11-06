import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readWorkspaceSettings } from "./readWorkspaceSettings.js";
import {
  normalizeObjectStorageConfig,
  resolveActiveObjectStorage,
  resolveObjectStorageConfig,
  withSettingsDefaults,
} from "./types.js";
import {
  writeWorkspaceSettingsUnlocked,
} from "./writeWorkspaceSettings.js";

const BASE_SETTINGS: {
  providers: Array<{
    id: string;
    name: string;
    baseUrl: string;
    modelId: string;
  }>;
  activeProviderId: string;
} = {
  providers: [
    {
      id: "default",
      name: "Default",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4o-mini",
    },
  ],
  activeProviderId: "default",
};

describe("objectStorage settings round trip", () => {
  it("writes and reads a full tencent COS config", async () => {
    const root = mkdtempSync(join(tmpdir(), "objstorage-roundtrip-"));
    const written = await writeWorkspaceSettingsUnlocked(root, {
      ...BASE_SETTINGS,
      objectStorage: {
        provider: "tencent",
        region: "ap-guangzhou",
        bucket: "mybucket-1250000000",
        accessKeyId: "AKIDEXAMPLE",
        endpoint: "cdn.example.com",
        keyPrefix: "jellybot",
        urlMode: "public",
        enabled: true,
      },
    });
    assert.equal(written.objectStorage?.provider, "tencent");

    const read = await readWorkspaceSettings(root);
    const config = read?.objectStorage;
    assert.equal(config?.provider, "tencent");
    assert.equal(config?.region, "ap-guangzhou");
    assert.equal(config?.bucket, "mybucket-1250000000");
    assert.equal(config?.accessKeyId, "AKIDEXAMPLE");
    assert.equal(config?.endpoint, "cdn.example.com");
    // keyPrefix normalized with trailing slash
    assert.equal(config?.keyPrefix, "jellybot/");
    assert.equal(config?.urlMode, "public");
    assert.equal(config?.enabled, true);
  });

  it("clears objectStorage via null patch and never stores a secret", async () => {
    const root = mkdtempSync(join(tmpdir(), "objstorage-clear-"));
    await writeWorkspaceSettingsUnlocked(root, {
      ...BASE_SETTINGS,
      objectStorage: {
        provider: "amazon",
        region: "us-east-1",
        bucket: "my-bucket",
        accessKeyId: "AKIDEXAMPLE",
      },
    });
    const cleared = await writeWorkspaceSettingsUnlocked(root, {
      ...BASE_SETTINGS,
      objectStorage: null,
    });
    assert.equal(cleared.objectStorage, null);

    // settings.json must never mention a secretAccessKey field.
    const raw = readFileSync(
      join(root, "settings.json"),
      "utf8",
    );
    assert.ok(!raw.includes("secretAccessKey"), "secret must not be persisted");
    assert.ok(!raw.includes("object-storage"), "credential id must not be persisted");
  });

  it("withSettingsDefaults normalizes defaults (urlMode/enabled/prefix)", () => {
    const resolved = withSettingsDefaults({
      ...BASE_SETTINGS,
      objectStorage: {
        provider: "amazon",
        region: "us-east-1",
        bucket: "my-bucket",
        accessKeyId: "AKIDEXAMPLE",
      },
    });
    assert.equal(resolved.objectStorage?.urlMode, "presigned");
    assert.equal(resolved.objectStorage?.enabled, true);
    assert.equal(resolved.objectStorage?.keyPrefix, undefined);
  });

  it("resolveActiveObjectStorage returns null when disabled or unset", () => {
    const disabled = withSettingsDefaults({
      ...BASE_SETTINGS,
      objectStorage: {
        provider: "amazon",
        region: "us-east-1",
        bucket: "my-bucket",
        accessKeyId: "AKIDEXAMPLE",
        enabled: false,
      },
    });
    assert.equal(resolveActiveObjectStorage(disabled), null);
    assert.equal(resolveObjectStorageConfig(null), null);
  });

  it("normalizeObjectStorageConfig rejects incomplete configs", () => {
    assert.equal(normalizeObjectStorageConfig(null), null);
    assert.equal(normalizeObjectStorageConfig("nope"), null);
    assert.equal(
      normalizeObjectStorageConfig({
        provider: "amazon",
        region: "",
        bucket: "b",
        accessKeyId: "a",
      }),
      null,
    );
    // endpoint strips scheme + trailing slashes
    const normalized = normalizeObjectStorageConfig({
      provider: "tencent",
      region: "ap-shanghai",
      bucket: "b-125",
      accessKeyId: "a",
      endpoint: "https://cdn.example.com/",
    });
    assert.equal(normalized?.endpoint, "cdn.example.com");
  });
});
