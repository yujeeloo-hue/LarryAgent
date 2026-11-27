import { readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import {
  normalizeRemoteRelaySettings,
  WORKSPACE_SETTINGS_FILE,
} from "../settings/types.js";
import type { SessionHistoryDevice } from "./db/sessionHistoryRepository.js";

export function readSessionDeviceSnapshot(
  appDataRoot: string,
  appVersion: string,
): SessionHistoryDevice {
  let deviceId = "";
  let deviceName = "";
  try {
    const raw = readFileSync(
      join(appDataRoot, WORKSPACE_SETTINGS_FILE),
      "utf8",
    );
    const remote = normalizeRemoteRelaySettings(
      (JSON.parse(raw) as { remote?: unknown })?.remote,
    );
    deviceId = remote?.deviceId ?? "";
    deviceName = remote?.deviceName?.trim() ?? "";
  } catch {
  }
  return {
    deviceId,
    deviceName: deviceName || os.hostname(),
    deviceOs: `${process.platform} ${os.arch()} ${os.release()}`,
    appVersion,
  };
}
