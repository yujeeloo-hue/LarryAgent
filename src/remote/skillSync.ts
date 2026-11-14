/**
 * Skill sync for the Relay Skill Hub. Desktop (macOS/Windows) and agentd
 * (Raspberry Pi) share this module — packages live under `{dataDir}/skills`
 * and the registry lives in tools.json through the skillManager singleton.
 *
 * Both directions travel as a zip of the whole skill directory (SKILL.md +
 * supporting files), so binary assets survive a push/pull byte-for-byte and
 * an overwrite always mirrors the incoming package exactly.
 */
import AdmZip from "adm-zip";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillManager } from "../skills/index.js";
import { extractAndDiscoverSkills } from "../skills/installFromZip.js";
import {
  isValidSkillName,
  normalizeSkillName,
} from "../skills/toolHelpers.js";

/** Zip size cap — mirrors the relay-side limit (8 MB). */
export const SKILL_SYNC_ZIP_MAX_BYTES = 8 * 1024 * 1024;

/** Device-side public shape — body and file contents never leave the device. */
export type SyncSkillPublic = {
  id: string;
  name: string;
  enabled: boolean;
  description: string;
  fileCount: number;
};

/** Transfer shape — the whole package as a base64 zip. */
export type SyncSkillTransfer = {
  name: string;
  enabled: boolean;
  description: string;
  zipBase64: string;
};

export function skillSyncMatchKey(name: string): string {
  return normalizeSkillName(name);
}

function zipTooLargeError(): Error {
  return new Error(
    `Skill package is too large to sync (max ${Math.round(SKILL_SYNC_ZIP_MAX_BYTES / (1024 * 1024))} MB).`,
  );
}

export function listSyncSkills(): SyncSkillPublic[] {
  return skillManager.listRecords().map((record) => ({
    id: record.id,
    name: record.name,
    enabled: record.enabled,
    description: record.description,
    fileCount: record.files.length,
  }));
}

export function exportSyncSkill(
  skillId: string,
): SyncSkillTransfer & { id: string } {
  const id = skillId.trim();
  if (!id) throw new Error("Skill ID is required.");
  const record = skillManager.getRecord(id);
  if (!record) throw new Error("Skill not found.");
  const zip = new AdmZip();
  zip.addLocalFolder(record.directory);
  const buffer = zip.toBuffer();
  if (buffer.byteLength > SKILL_SYNC_ZIP_MAX_BYTES) throw zipTooLargeError();
  return {
    id: record.id,
    name: record.name,
    enabled: record.enabled,
    description: record.description,
    zipBase64: buffer.toString("base64"),
  };
}

/**
 * Install one skill package from a base64 zip. Same-name device entries keep
 * their device id and the directory is replaced wholesale, so files that are
 * absent from the incoming package are gone afterwards.
 */
export async function upsertSyncSkill(
  transfer: SyncSkillTransfer,
): Promise<{ id: string; action: "added" | "overwritten"; fileCount: number }> {
  const name = normalizeSkillName(transfer.name ?? "");
  if (!isValidSkillName(name)) {
    throw new Error(
      `Invalid skill name "${transfer.name ?? ""}". Use lowercase letters, numbers, and hyphens (max 64).`,
    );
  }
  if (typeof transfer.zipBase64 !== "string" || !transfer.zipBase64.trim()) {
    throw new Error("Skill package is required.");
  }
  const buffer = Buffer.from(transfer.zipBase64, "base64");
  if (buffer.byteLength === 0) throw new Error("Skill package is empty.");
  if (buffer.byteLength > SKILL_SYNC_ZIP_MAX_BYTES) throw zipTooLargeError();
  if (skillManager.findSkill(name).ambiguous) {
    throw new Error(
      `Ambiguous skill name "${name}" on this device. Resolve duplicates before syncing.`,
    );
  }

  const tempDir = await mkdtemp(join(tmpdir(), "jellybot-skill-sync-"));
  try {
    const zipPath = join(tempDir, "skill.zip");
    await writeFile(zipPath, buffer);
    const { packages } = await extractAndDiscoverSkills(zipPath, { name });
    const pkg = packages[0];
    if (!pkg) throw new Error(`No skill named "${name}" found in the package.`);
    const { record, overwritten } = await skillManager.installLocalPackage(
      pkg.sourceDir,
      { name, enabled: transfer.enabled !== false, overwrite: true },
    );
    return {
      id: record.id,
      action: overwritten ? "overwritten" : "added",
      fileCount: record.files.length,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function removeSyncSkill(
  skillId: string,
): Promise<{ removed: boolean; id?: string }> {
  const id = skillId.trim();
  if (!id) throw new Error("Skill ID is required.");
  if (!skillManager.getRecord(id)) return { removed: false };
  await skillManager.removeSkill(id);
  return { removed: true, id };
}
