import { readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import {
  normalizeRemoteRelaySettings,
  WORKSPACE_SETTINGS_FILE,
} from "../settings/types.js";
import type { SessionHistoryDevice } from "./db/sessionHistoryRepository.js";

/**
 * Delete-time device snapshot for session_history rows (schema v23) —
 * records which install deleted the session, groundwork for cross-device
 * memory merging.
 *
 * deviceId reuses the persisted per-install remote relay identity
 * (settings.json remote.deviceId — ensured + persisted by the relay boot in
 * main/index.ts, with a manual reset escape hatch). deviceName mirrors the
 * relay semantics (`remote.deviceName` or hostname). Reads are synchronous
 * because deleteSession cannot await; a missing/unreadable/legacy
 * settings.json yields deviceId '' (unknown device) — pre-v23 rows look
 * the same. No minting here: a locally-generated id would diverge from the
 * one the relay boot persists.
 */
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
    // No settings / malformed JSON → unknown device fields.
  }
  return {
    deviceId,
    deviceName: deviceName || os.hostname(),
    deviceOs: `${process.platform} ${os.arch()} ${os.release()}`,
    appVersion,
  };
}
