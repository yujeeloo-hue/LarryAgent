/**
 * Regression: `remote` (relay bridge config incl. stable deviceId) must
 * survive the read → normalize → write round-trip. The persistence whitelist
 * silently stripped it before, so every launch minted a fresh deviceId and the
 * web console showed the same Mac as two devices.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeWorkspaceSettings,
} from "./writeWorkspaceSettings.js";
import { parseWorkspaceSettings } from "./readWorkspaceSettings.js";
import { patchWorkspaceSettings } from "./patchWorkspaceSettings.js";
import { withSettingsDefaults } from "./types.js";

const REMOTE = {
  enabled: true,
  serverUrl: "https://jellybot.cloud/relay",
  deviceId: "dev-123",
  deviceName: "Joji's Macbook Pro",
  mode: "full" as const,
  pushActivity: "all" as const,
  memorySync: { enabled: false, sessionArchive: true, projectDocs: false },
};

const BASE = {
  providers: [
    { id: "p1", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-v4-flash" },
  ],
  activeProviderId: "p1",
};

describe("settings remote persistence", () => {
  it("normalizeWorkspaceSettings keeps remote", () => {
    const out = normalizeWorkspaceSettings({ ...BASE, remote: REMOTE });
    assert.deepEqual(out?.remote, REMOTE);
  });

  it("parseWorkspaceSettings restores remote from disk JSON", () => {
    const raw = JSON.stringify({ ...BASE, remote: REMOTE });
    const parsed = parseWorkspaceSettings(raw);
    assert.deepEqual(parsed?.remote, REMOTE);
  });

  it("patchWorkspaceSettings round-trips remote (deviceId stable)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "remote-settings-test-"));
    try {
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({ ...BASE, remote: { ...REMOTE, enabled: false } }),
      );
      const patched = await patchWorkspaceSettings(dir, {
        remote: { ...REMOTE },
      });
      assert.equal(patched.remote?.deviceId, "dev-123");
      // A second patch touching another key must not clobber remote.
      const again = await patchWorkspaceSettings(dir, {
        fullPermissionsDefault: true,
      });
      assert.equal(again.remote?.deviceId, "dev-123");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("withSettingsDefaults passes remote through", () => {
    const resolved = withSettingsDefaults({
      ...BASE,
      remote: REMOTE,
    } as never);
    assert.equal(resolved.remote?.deviceId, "dev-123");
  });
});
