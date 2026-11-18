import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readAllApiKeysFromStore } from "../../llm/credentials.js";
import {
  isValidBackupSkillName,
  type BackupFileEntry,
  type BackupPayload,
  type BackupSkillEntry,
} from "./bundle.js";


export type CollectBackupOptions = {
  userDataRoot: string;
  readCocoSettings?: () => unknown | Promise<unknown>;
};

async function readJsonOrNull(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function isTransientFileName(name: string): boolean {
  if (name.startsWith(".")) return true;
  if (/\.bak(-|$)/i.test(name)) return true;
  if (name.includes(".tmp")) return true;
  return false;
}

function stripDeviceIdentity(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const remote = settings.remote;
  if (!remote || typeof remote !== "object" || Array.isArray(remote)) {
    return settings;
  }
  const { deviceId: _dropId, deviceName: _dropName, ...rest } =
    remote as Record<string, unknown>;
  return { ...settings, remote: rest };
}

async function walkFiles(
  root: string,
  prefix: string[] = [],
): Promise<BackupFileEntry[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: BackupFileEntry[] = [];
  for (const entry of entries) {
    if (isTransientFileName(entry.name)) continue;
    if (entry.isDirectory()) {
      const nested = await walkFiles(join(root, entry.name), [
        ...prefix,
        entry.name,
      ]);
      out.push(...nested);
      continue;
    }
    if (!entry.isFile()) continue;
    const data = await readFile(join(root, entry.name));
    out.push({
      path: [...prefix, entry.name].join("/"),
      data: data.toString("base64"),
    });
  }
  return out;
}

async function collectSkills(
  userDataRoot: string,
): Promise<BackupSkillEntry[] | null> {
  const files = await walkFiles(join(userDataRoot, "skills"));
  if (files.length === 0) return null;
  const byName = new Map<string, BackupFileEntry[]>();
  for (const file of files) {
    const slash = file.path.indexOf("/");
    if (slash <= 0) continue;
    const name = file.path.slice(0, slash);
    if (!isValidBackupSkillName(name)) continue;
    const rest = file.path.slice(slash + 1);
    const list = byName.get(name) ?? [];
    list.push({ path: rest, data: file.data });
    byName.set(name, list);
  }
  const out: BackupSkillEntry[] = [];
  for (const [name, list] of byName) {
    if (!list.some((f) => f.path === "SKILL.md")) continue;
    out.push({ name, files: list });
  }
  return out.length > 0 ? out : null;
}

async function collectFsmGraphs(
  userDataRoot: string,
): Promise<BackupFileEntry[] | null> {
  const files = await walkFiles(join(userDataRoot, "fsm-graphs"));
  return files.length > 0 ? files : null;
}

function stripCocoMachineLocal(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const { excludedWorkspaceIds: _drop, ...rest } = settings;
  return rest;
}

async function collectCocoSettings(
  options: CollectBackupOptions,
): Promise<Record<string, unknown> | null> {
  const read = options.readCocoSettings;
  if (typeof read !== "function") return null;
  let raw: unknown;
  try {
    raw = await read();
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return stripCocoMachineLocal(raw as Record<string, unknown>);
}

export async function collectBackup(
  options: CollectBackupOptions,
): Promise<BackupPayload> {
  const root = options.userDataRoot;
  const [settings, tools, userMemory, keys, skills, fsmGraphs, cocoSettings] =
    await Promise.all([
      readJsonOrNull(join(root, "settings.json")),
      readJsonOrNull(join(root, "tools.json")),
      readJsonOrNull(join(root, "user-memory.json")),
      readAllApiKeysFromStore(),
      collectSkills(root),
      collectFsmGraphs(root),
      collectCocoSettings(options),
    ]);

  return {
    settings: settings ? stripDeviceIdentity(settings) : null,
    cocoSettings,
    tools,
    secrets: Object.keys(keys).length > 0 ? { keys } : null,
    skills,
    userMemory,
    fsmGraphs,
  };
}
