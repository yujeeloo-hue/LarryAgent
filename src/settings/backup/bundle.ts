import AdmZip from "adm-zip";
import {
  decryptBackupPayload,
  encryptBackupPayload,
} from "./crypto.js";


export const BUNDLE_FORMAT = "jellybot-backup";
export const BUNDLE_VERSION = 2;
export const BUNDLE_HEADER_ENTRY = "header.json";
export const BUNDLE_PAYLOAD_ENTRY = "payload.bin";
export const BUNDLE_FILE_EXTENSION = ".jbbundle";

export type BackupSectionName =
  | "settings"
  | "cocoSettings"
  | "tools"
  | "secrets"
  | "skills"
  | "userMemory"
  | "fsmGraphs";

export const BACKUP_SECTION_NAMES: readonly BackupSectionName[] = [
  "settings",
  "cocoSettings",
  "tools",
  "secrets",
  "skills",
  "userMemory",
  "fsmGraphs",
];

export type BackupFileEntry = {
  path: string;
  data: string;
};

export type BackupSkillEntry = {
  name: string;
  files: BackupFileEntry[];
};

export type BackupPayload = {
  settings: Record<string, unknown> | null;
  cocoSettings: Record<string, unknown> | null;
  tools: Record<string, unknown> | null;
  secrets: { keys: Record<string, string> } | null;
  skills: BackupSkillEntry[] | null;
  userMemory: Record<string, unknown> | null;
  fsmGraphs: BackupFileEntry[] | null;
};

export type BackupHeader = {
  format: typeof BUNDLE_FORMAT;
  version: number;
  exportedAt: string;
  appVersion: string;
  sections: BackupSectionName[];
};

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupFormatError";
  }
}


const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MAX_SKILLS = 500;
const MAX_FILES_PER_SKILL = 2_000;
const MAX_FSM_GRAPH_FILES = 2_000;
const MAX_ENTRY_PATH_LEN = 512;

export function isValidBackupEntryPath(path: string): boolean {
  if (!path || path.length > MAX_ENTRY_PATH_LEN) return false;
  if (path.includes("\\") || path.includes("\0")) return false;
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return false;
  const parts = path.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function isValidBackupSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name) && name.length <= 64;
}

function isBase64(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const buf = Buffer.from(value, "base64");
  return buf.toString("base64") === value.trim();
}

function parseFileEntry(
  value: unknown,
  context: string,
): BackupFileEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<BackupFileEntry>;
  if (typeof raw.path !== "string" || !isValidBackupEntryPath(raw.path)) {
    return null;
  }
  if (typeof raw.data !== "string" || !isBase64(raw.data)) return null;
  return { path: raw.path, data: raw.data };
}

function parseFileEntries(
  value: unknown,
  context: string,
  cap: number,
): BackupFileEntry[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > cap) {
    return null;
  }
  const out: BackupFileEntry[] = [];
  for (const item of value) {
    const entry = parseFileEntry(item, context);
    if (!entry) return null;
    out.push(entry);
  }
  return out;
}

export function normalizeBackupPayload(value: unknown): BackupPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BackupFormatError("Backup payload is not an object");
  }
  const raw = value as Record<string, unknown>;

  const section = <T>(name: BackupSectionName, check: (v: unknown) => T | null): T | null => {
    const field = raw[name];
    if (field === null || field === undefined) return null;
    const parsed = check(field);
    if (parsed === null) {
      throw new BackupFormatError(`Backup section "${name}" has an invalid shape`);
    }
    return parsed;
  };

  const asObject = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;

  const settings = section("settings", asObject);
  const cocoSettings = section("cocoSettings", asObject);
  const tools = section("tools", asObject);
  const userMemory = section("userMemory", asObject);

  const secrets = section("secrets", (v): BackupPayload["secrets"] => {
    const obj = asObject(v);
    if (!obj) return null;
    const keysRaw = obj.keys;
    if (!keysRaw || typeof keysRaw !== "object" || Array.isArray(keysRaw)) {
      return null;
    }
    const keys: Record<string, string> = {};
    for (const [id, key] of Object.entries(keysRaw)) {
      if (!id.trim() || typeof key !== "string" || !key.trim()) return null;
      keys[id] = key;
    }
    return { keys };
  });

  const skills = section("skills", (v): BackupSkillEntry[] | null => {
    if (!Array.isArray(v) || v.length === 0 || v.length > MAX_SKILLS) return null;
    const out: BackupSkillEntry[] = [];
    for (const item of v) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const entry = item as Partial<BackupSkillEntry>;
      if (typeof entry.name !== "string" || !isValidBackupSkillName(entry.name)) {
        return null;
      }
      const files = parseFileEntries(entry.files, "skills", MAX_FILES_PER_SKILL);
      if (!files) return null;
      if (!files.some((f) => f.path === "SKILL.md")) return null;
      out.push({ name: entry.name, files });
    }
    return out;
  });

  const fsmGraphs = section("fsmGraphs", (v): BackupFileEntry[] | null =>
    parseFileEntries(v, "fsmGraphs", MAX_FSM_GRAPH_FILES),
  );

  return { settings, cocoSettings, tools, secrets, skills, userMemory, fsmGraphs };
}

export function payloadSections(payload: BackupPayload): BackupSectionName[] {
  return BACKUP_SECTION_NAMES.filter((name) => payload[name] !== null);
}


export function buildBackupBundle(
  payload: BackupPayload,
  passphrase: string,
  appVersion: string,
): Buffer {
  const normalized = normalizeBackupPayload(payload);
  const header: BackupHeader = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: appVersion || "unknown",
    sections: payloadSections(normalized),
  };
  const envelope = encryptBackupPayload(
    JSON.stringify(normalized),
    passphrase,
  );
  const zip = new AdmZip();
  zip.addFile(
    BUNDLE_HEADER_ENTRY,
    Buffer.from(`${JSON.stringify(header, null, 2)}\n`, "utf8"),
  );
  zip.addFile(
    BUNDLE_PAYLOAD_ENTRY,
    Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8"),
  );
  return zip.toBuffer();
}

function readZipEntry(zipBytes: Buffer, entryName: string): string {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBytes);
  } catch {
    throw new BackupFormatError("Backup file is not a readable ZIP archive");
  }
  const entry = zip.getEntry(entryName);
  if (!entry) {
    throw new BackupFormatError(`Backup file is missing "${entryName}"`);
  }
  return entry.getData().toString("utf8");
}

function parseHeaderObject(raw: string): BackupHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BackupFormatError("Backup header is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BackupFormatError("Backup header is not an object");
  }
  const header = parsed as Partial<BackupHeader>;
  if (header.format !== BUNDLE_FORMAT) {
    throw new BackupFormatError("This file is not a JellyBot backup");
  }
  if (
    typeof header.version !== "number" ||
    !Number.isInteger(header.version) ||
    header.version < 1 ||
    header.version > BUNDLE_VERSION
  ) {
    throw new BackupFormatError(
      `Unsupported backup version ${String(header.version)} — this build supports versions 1–${BUNDLE_VERSION}`,
    );
  }
  if (typeof header.exportedAt !== "string" || !header.exportedAt) {
    throw new BackupFormatError("Backup header is missing exportedAt");
  }
  if (typeof header.appVersion !== "string" || !header.appVersion) {
    throw new BackupFormatError("Backup header is missing appVersion");
  }
  if (
    !Array.isArray(header.sections) ||
    header.sections.some((name) => !BACKUP_SECTION_NAMES.includes(name as BackupSectionName))
  ) {
    throw new BackupFormatError("Backup header has an invalid section list");
  }
  return {
    format: BUNDLE_FORMAT,
    version: header.version,
    exportedAt: header.exportedAt,
    appVersion: header.appVersion,
    sections: header.sections as BackupSectionName[],
  };
}

export function readBackupHeader(zipBytes: Buffer): BackupHeader {
  return parseHeaderObject(readZipEntry(zipBytes, BUNDLE_HEADER_ENTRY));
}

export function openBackupPayload(
  zipBytes: Buffer,
  passphrase: string,
): BackupPayload {
  readBackupHeader(zipBytes);
  const envelopeRaw = readZipEntry(zipBytes, BUNDLE_PAYLOAD_ENTRY);
  let envelope: unknown;
  try {
    envelope = JSON.parse(envelopeRaw);
  } catch {
    throw new BackupFormatError("Backup payload envelope is not valid JSON");
  }
  const payloadJson = decryptBackupPayload(envelope, passphrase);
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    throw new BackupFormatError("Backup payload is not valid JSON");
  }
  return normalizeBackupPayload(payload);
}
