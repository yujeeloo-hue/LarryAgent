import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureSettingsRoot } from "../settings/settingsRoot.js";
import { writeWorkspaceSettingsUnlocked } from "../settings/writeWorkspaceSettings.js";
import { WORKSPACE_SETTINGS_FILE, withSettingsDefaults } from "../settings/types.js";
import { runAgentdSetDeviceName } from "./setDeviceName.js";

type EnvKey = "JELLYBOT_AGENTD_CONFIG_DIR" | "JELLYBOT_AGENTD_DATA_DIR";

function useDirs(): { configDir: string; dataDir: string; restore: () => void } {
  const base = mkdtempSync(join(tmpdir(), "jb-agentd-name-"));
  const configDir = join(base, "etc");
  const dataDir = join(base, "data");
  const keys: EnvKey[] = ["JELLYBOT_AGENTD_CONFIG_DIR", "JELLYBOT_AGENTD_DATA_DIR"];
  const previous = new Map<EnvKey, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    process.env[key] = key.endsWith("CONFIG_DIR") ? configDir : dataDir;
  }
  return {
    configDir,
    dataDir,
    restore: () => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

async function seedRemote(dataDir: string, configDir: string): Promise<void> {
  configureSettingsRoot(configDir);
  const settings = withSettingsDefaults(null);
  settings.remote = {
    enabled: true,
    serverUrl: "https://remote.jellybot.cloud",
    deviceId: "device-123",
    deviceName: "devcloud-x64",
    mode: "full",
    pushActivity: "all",
  };
  await writeWorkspaceSettingsUnlocked(dataDir, settings);
}

type SavedSettings = {
  providers: unknown[];
  remote: {
    deviceName: string;
    deviceId: string;
    serverUrl: string;
    mode: string;
  };
};

function readSettings(configDir: string): SavedSettings {
  return JSON.parse(
    readFileSync(join(configDir, WORKSPACE_SETTINGS_FILE), "utf8"),
  ) as SavedSettings;
}

test("set-device-name updates only the Relay display name", async () => {
  const dirs = useDirs();
  try {
    await seedRemote(dirs.dataDir, dirs.configDir);
    const code = await runAgentdSetDeviceName(["Tencent", "Dev", "Cloud"]);
    assert.equal(code, 0);

    const saved = readSettings(dirs.configDir);
    assert.equal(saved.remote.deviceName, "Tencent Dev Cloud");
    assert.equal(saved.remote.deviceId, "device-123");
    assert.equal(saved.remote.serverUrl, "https://remote.jellybot.cloud");
    assert.equal(saved.remote.mode, "full");
    assert.equal(saved.providers.length, 1);
  } finally {
    dirs.restore();
  }
});

test("set-device-name rejects an empty name without changing settings", async () => {
  const dirs = useDirs();
  try {
    await seedRemote(dirs.dataDir, dirs.configDir);
    const code = await runAgentdSetDeviceName(["   "]);
    assert.equal(code, 1);
    assert.equal(readSettings(dirs.configDir).remote.deviceName, "devcloud-x64");
  } finally {
    dirs.restore();
  }
});

test("set-device-name reports missing setup config", async () => {
  const dirs = useDirs();
  try {
    const code = await runAgentdSetDeviceName(["Tencent Dev Cloud"]);
    assert.equal(code, 1);
  } finally {
    dirs.restore();
  }
});
