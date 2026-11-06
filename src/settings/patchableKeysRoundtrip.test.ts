import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PATCHABLE_KEYS } from "./patchWorkspaceSettings.js";
import { readWorkspaceSettings } from "./readWorkspaceSettings.js";
import { WORKSPACE_SETTINGS_FILE, type WorkspaceSettings } from "./types.js";
import { writeWorkspaceSettingsUnlocked } from "./writeWorkspaceSettings.js";

/**
 * Drift tripwire for the settings field allowlists. Persistence runs three
 * parallel key lists (PATCHABLE_KEYS for sparse patches, the write
 * normalizer, the read parser); composerVoiceMode once drifted — declared
 * in two of them but missing from the other two, so the flag never landed
 * in settings.json. Every PATCHABLE_KEYS entry must survive the full
 * write → disk → read chain (normalizing keys assert their normalized
 * shape, everything else must round-trip verbatim).
 */

const SAMPLES: Record<string, unknown> = {
  providers: [
    {
      id: "p1",
      name: "Primary",
      baseUrl: "https://api.example.com/v1",
      modelId: "model-x",
      supportsMultimodal: true,
    },
  ],
  activeProviderId: "p1",
  visionProviderId: "p1",
  imageGenProviders: [
    {
      id: "ig1",
      name: "ImageGen",
      baseUrl: "https://api.example.com/v4",
      modelId: "cogview",
    },
  ],
  activeImageGenProviderId: "ig1",
  objectStorage: {
    provider: "tencent",
    region: "ap-guangzhou",
    bucket: "bucket",
    accessKeyId: "akid",
    keyPrefix: "jb/",
  },
  fullPermissionsDefault: true,
  composerRunMode: "plan",
  composerInfinite: true,
  reasoningEffort: "high",
  composerVoiceMode: true,
  contextLimitTokens: 200_000,
  compactTriggerRatio: 0.7,
  iterationProtectRawIterationCount: 25,
  iterationProtectTokenRatio: 0.25,
  maxModelIterations: 64,
  maxTurnTokens: 1_500_000,
  llmRequestTimeoutMs: 45_000,
  activeWorkspaceId: "ws-1",
  debugAdapterPath: "/opt/lldb-dap/bin/lldb-dap",
  environmentContext: {
    workspace: false,
    timezone: true,
    locale: false,
    location: true,
  },
  userMemoryAutoExtract: false,
  projectMemoryAutoExtract: false,
  toolStatsEnabled: false,
  themeId: "light",
  accentColor: "#00e5ff",
  uiFontScale: 1.1,
  chatFontScale: 1.2,
  remote: {
    enabled: true,
    serverUrl: "wss://relay.example.com",
    deviceId: "dev-1",
    deviceName: "Mac",
    mode: "full",
    pushActivity: "active",
  },
};

/** Keys whose values are intentionally normalized by the writer/reader. */
const NORMALIZED_EXPECTATIONS: Record<string, (read: unknown) => void> = {
  providers: (read) => {
    assert.ok(Array.isArray(read) && read.length === 1);
    assert.equal((read as { id?: string }[])[0]?.id, "p1");
    assert.equal((read as { supportsMultimodal?: boolean }[])[0]?.supportsMultimodal, true);
  },
  objectStorage: (read) => {
    assert.deepEqual(read, {
      provider: "tencent",
      region: "ap-guangzhou",
      bucket: "bucket",
      accessKeyId: "akid",
      keyPrefix: "jb/",
      urlMode: "presigned",
      enabled: true,
    });
  },
  remote: (read) => {
    // normalizeRemoteRelaySettings always sets memorySync (undefined = off).
    assert.deepEqual(read, {
      enabled: true,
      serverUrl: "wss://relay.example.com",
      deviceId: "dev-1",
      deviceName: "Mac",
      mode: "full",
      pushActivity: "active",
      memorySync: undefined,
    });
  },
};

describe("PATCHABLE_KEYS round-trip tripwire", () => {
  it("every sparse-patchable key survives write → disk → read", async () => {
    const root = mkdtempSync(join(tmpdir(), "patchkeys-"));
    const settings = {
      ...minimalSettings(),
      ...SAMPLES,
    } as WorkspaceSettings;

    await writeWorkspaceSettingsUnlocked(root, settings);

    // Disk-level: every sample key is actually in the written JSON — this
    // is the layer that dropped composerVoiceMode (write normalizer).
    const disk = JSON.parse(
      readFileSync(join(root, WORKSPACE_SETTINGS_FILE), "utf8"),
    ) as Record<string, unknown>;
    for (const key of PATCHABLE_KEYS) {
      assert.ok(key in disk, `key "${key}" missing from written settings.json`);
    }

    // Read-level: the parser must not drop it either.
    const read = await readWorkspaceSettings(root);
    assert.ok(read);
    for (const key of PATCHABLE_KEYS) {
      const expected: unknown = SAMPLES[key];
      const actual: unknown = (read as Record<string, unknown>)[key];
      if (NORMALIZED_EXPECTATIONS[key]) {
        NORMALIZED_EXPECTATIONS[key]!(actual);
        continue;
      }
      assert.deepEqual(
        actual,
        expected,
        `key "${key}" did not survive the read round trip`,
      );
    }
  });

  it("the sample map covers every PATCHABLE_KEYS entry", () => {
    for (const key of PATCHABLE_KEYS) {
      assert.ok(
        key in SAMPLES,
        `tripwire sample missing for "${key}" — add one so drift coverage stays complete`,
      );
    }
  });
});

function minimalSettings() {
  return {
    providers: SAMPLES.providers as WorkspaceSettings["providers"],
    activeProviderId: "p1",
  };
}
