import { copyFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeApiKeyToStore } from "../../llm/credentials.js";
import { parseToolsConfig } from "../../toolsConfig/types.js";
import {
  normalizeWorkspaceSettings,
  writeWorkspaceSettings,
} from "../writeWorkspaceSettings.js";
import {
  BackupFormatError,
  isValidBackupEntryPath,
  isValidBackupSkillName,
  payloadSections,
  type BackupPayload,
  type BackupSectionName,
} from "./bundle.js";

/**
 * Apply a decrypted backup payload to a userData root — whole-file replace
 * semantics (per the approved plan). Everything that will be overwritten
 * is first copied/renamed to `<name>.bak-YYYYMMDD-HHMMSS` (the existing
 * convention in this userData dir). API keys are re-encrypted into this
 * machine's credential store via `writeApiKeyToStore` — the caller must
 * have pointed `configureCredentialsRoot` at the same userData root.
 *
 * Validation runs before any write, so an invalid payload never leaves
 * partial state behind.
 */

export type ApplyBackupOptions = {
  userDataRoot: string;
  /**
   * Writes the CoCo panel settings section (`coco_meta.settings`). Injected
   * by main — the value lives in sessions.sqlite, not a file, so there is
   * no `.bak` copy: the writer must preserve the previous value itself
   * (single-slot `coco_meta.settingsBackup`) before applying. Throwing
   * fails the whole apply (existing semantics).
   */
  writeCocoSettings?: (
    settings: Record<string, unknown>,
  ) => Promise<unknown> | unknown;
};

export type ApplyBackupResult = {
  applied: BackupSectionName[];
  /** Absolute paths of the `.bak-*` copies created during this apply. */
  backups: string[];
};

function backupStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function backupFileIfExists(
  path: string,
  backups: string[],
): Promise<void> {
  if (!(await pathExists(path))) return;
  const target = `${path}.bak-${backupStamp()}`;
  await copyFile(path, target);
  backups.push(target);
}

/** tmp + rename, matching the atomic-write convention used across the app. */
async function writeFileAtomic(
  path: string,
  data: string | Buffer,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export async function applyBackup(
  payload: BackupPayload,
  options: ApplyBackupOptions,
): Promise<ApplyBackupResult> {
  const root = options.userDataRoot;
  const backups: string[] = [];

  // ---- Phase 1: validate everything (no writes) ----
  const normalizedSettings = payload.settings
    ? normalizeWorkspaceSettings(payload.settings)
    : null;
  if (payload.settings && !normalizedSettings) {
    throw new BackupFormatError('Backup section "settings" is invalid');
  }
  // Older backup files still carry the exporter's remote.deviceId —
  // importing it would clone the identity and kick that machine offline
  // every time this one connects. Empty strings regenerate on launch.
  if (normalizedSettings?.remote) {
    normalizedSettings.remote = {
      ...normalizedSettings.remote,
      deviceId: "",
      deviceName: "",
    };
  }
  // parseToolsConfig always yields a valid config (drops junk); still run it
  // so the written tools.json is the normalized shape.
  const normalizedTools = payload.tools ? parseToolsConfig(payload.tools) : null;
  if (payload.tools && !normalizedTools) {
    throw new BackupFormatError('Backup section "tools" is invalid');
  }
  // CoCo settings are validated by the injected writer (engine command
  // path) — here we only require the writer to exist when the section does.
  if (payload.cocoSettings && typeof options.writeCocoSettings !== "function") {
    throw new BackupFormatError(
      'Backup section "cocoSettings" has no writer configured',
    );
  }
  for (const skill of payload.skills ?? []) {
    if (!isValidBackupSkillName(skill.name)) {
      throw new BackupFormatError(
        `Backup skill name is invalid: "${skill.name}"`,
      );
    }
    for (const file of skill.files) {
      if (!isValidBackupEntryPath(file.path)) {
        throw new BackupFormatError(
          `Backup skill "${skill.name}" has an unsafe file path`,
        );
      }
    }
  }
  for (const file of payload.fsmGraphs ?? []) {
    if (!isValidBackupEntryPath(file.path)) {
      throw new BackupFormatError("Backup fsm-graphs entry has an unsafe path");
    }
  }

  // ---- Phase 2: backup existing files that will be replaced ----
  if (normalizedSettings) {
    await backupFileIfExists(join(root, "settings.json"), backups);
  }
  if (normalizedTools) {
    await backupFileIfExists(join(root, "tools.json"), backups);
  }
  if (payload.secrets) {
    await backupFileIfExists(join(root, "llm-api-keys.json"), backups);
  }
  if (payload.userMemory) {
    await backupFileIfExists(join(root, "user-memory.json"), backups);
  }
  for (const file of payload.fsmGraphs ?? []) {
    await backupFileIfExists(join(root, "fsm-graphs", file.path), backups);
  }
  for (const skill of payload.skills ?? []) {
    const dir = join(root, "skills", skill.name);
    if (await pathExists(dir)) {
      const target = `${dir}.bak-${backupStamp()}`;
      await rename(dir, target);
      backups.push(target);
    }
  }

  // ---- Phase 3: write ----
  if (normalizedSettings) {
    // Project-sanctioned writer: re-normalizes + atomic tmp/rename under the
    // settings write lock.
    await writeWorkspaceSettings(root, normalizedSettings);
  }
  if (normalizedTools) {
    await writeFileAtomic(
      join(root, "tools.json"),
      `${JSON.stringify(normalizedTools, null, 2)}\n`,
    );
  }
  if (payload.cocoSettings) {
    await options.writeCocoSettings?.(payload.cocoSettings);
  }
  if (payload.secrets) {
    for (const [providerId, apiKey] of Object.entries(payload.secrets.keys)) {
      await writeApiKeyToStore(apiKey, providerId);
    }
  }
  if (payload.userMemory) {
    await writeFileAtomic(
      join(root, "user-memory.json"),
      `${JSON.stringify(payload.userMemory, null, 2)}\n`,
    );
  }
  for (const file of payload.fsmGraphs ?? []) {
    await writeFileAtomic(
      join(root, "fsm-graphs", file.path),
      Buffer.from(file.data, "base64"),
    );
  }
  for (const skill of payload.skills ?? []) {
    const dir = join(root, "skills", skill.name);
    for (const file of skill.files) {
      await writeFileAtomic(
        join(dir, file.path),
        Buffer.from(file.data, "base64"),
      );
    }
  }

  return { applied: payloadSections(payload), backups };
}
