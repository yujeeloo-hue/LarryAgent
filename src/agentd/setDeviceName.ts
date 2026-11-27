import { chmodSync, chownSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { configureSettingsRoot } from "../settings/settingsRoot.js";
import { readWorkspaceSettings } from "../settings/readWorkspaceSettings.js";
import { WORKSPACE_SETTINGS_FILE } from "../settings/types.js";
import { writeWorkspaceSettingsUnlocked } from "../settings/writeWorkspaceSettings.js";
import {
  AGENTD_SERVICE_USER,
  resolveAgentdConfigDir,
  resolveAgentdDataDir,
} from "./config.js";

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

function chownSettingsToServiceUser(filePath: string): void {
  if (process.getuid?.() !== 0) return;
  try {
    const line = readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .find((entry) => entry.startsWith(`${AGENTD_SERVICE_USER}:`));
    if (!line) return;
    const parts = line.split(":");
    const uid = Number(parts[2]);
    const gid = Number(parts[3]);
    if (Number.isInteger(uid) && Number.isInteger(gid)) {
      chownSync(filePath, uid, gid);
    }
  } catch {
    // Best effort: setup reports the same situation as a warning.
  }
}

export async function runAgentdSetDeviceName(args: string[]): Promise<number> {
  const deviceName = args.join(" ").trim();
  if (!deviceName) {
    return fail("✖ Device name is required. Usage: agentd set-device-name <name>");
  }

  const configDir = resolveAgentdConfigDir();
  const dataDir = resolveAgentdDataDir();
  configureSettingsRoot(configDir);

  const settings = await readWorkspaceSettings(dataDir);
  if (!settings?.remote) {
    return fail("✖ No agentd remote config found — run `agentd setup` first.");
  }

  await writeWorkspaceSettingsUnlocked(dataDir, {
    ...settings,
    remote: { ...settings.remote, deviceName },
  });

  const settingsPath = join(configDir, WORKSPACE_SETTINGS_FILE);
  chmodSync(settingsPath, 0o600);
  chownSettingsToServiceUser(settingsPath);

  log(`✔ Device name set to: ${deviceName}`);
  log("  Restart jellybot-agentd to apply: systemctl restart jellybot-agentd");
  return 0;
}
