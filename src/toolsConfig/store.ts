/**
 * Read / write `{userData}/tools.json` with a serialized write lock.
 * One-time migration from legacy fields in settings.json.
 */

import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_SETTINGS_FILE } from "../settings/types.js";
import {
  TOOLS_CONFIG_FILE,
  emptyToolsConfig,
  extractLegacyToolsFieldsFromSettings,
  parseToolsConfig,
  type ToolsConfig,
  type ToolsConfigPatch,
} from "./types.js";

let appDataRoot: string | null = null;
let cache: ToolsConfig | null = null;
let writeChain: Promise<unknown> = Promise.resolve();

/** Set `{userData}` root. Call once from main before load/migrate. */
export function configureToolsConfigRoot(root: string): void {
  appDataRoot = root;
  cache = null;
}

function toolsFilePath(): string {
  if (!appDataRoot) {
    throw new Error("Tools config root is not configured");
  }
  return join(appDataRoot, TOOLS_CONFIG_FILE);
}

function settingsFilePath(): string {
  if (!appDataRoot) {
    throw new Error("Tools config root is not configured");
  }
  return join(appDataRoot, WORKSPACE_SETTINGS_FILE);
}

/** Serialize tools.json mutations. */
export function withToolsConfigWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function persistUnlocked(config: ToolsConfig): Promise<ToolsConfig> {
  if (!appDataRoot) {
    throw new Error("Tools config root is not configured");
  }
  await mkdir(appDataRoot, { recursive: true });
  const target = toolsFilePath();
  const temp = `${target}.${process.pid}.tmp`;
  const normalized: ToolsConfig = {
    version: 1,
    mcpServers: config.mcpServers,
    skills: config.skills,
    toolPermissionOverrides: config.toolPermissionOverrides,
    toolOfferOverrides: config.toolOfferOverrides,
    toolDisplayOverrides: config.toolDisplayOverrides,
    toolOfferAutoBaseline: config.toolOfferAutoBaseline,
    shellSafety: config.shellSafety,
  };
  const body = `${JSON.stringify(normalized, null, 2)}\n`;
  await writeFile(temp, body, "utf8");
  await rename(temp, target);
  cache = normalized;
  return normalized;
}

/**
 * Quarantine a corrupted tools.json (rename to `tools.json.corrupt-<stamp>`)
 * so later writes start fresh without destroying the original content.
 */
async function quarantineCorruptToolsFile(path: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.corrupt-${stamp}`;
  try {
    await rename(path, backup);
    console.error(
      `[tools-config] ${TOOLS_CONFIG_FILE} is corrupted; quarantined as ${backup}`,
    );
  } catch (err) {
    console.error(
      `[tools-config] failed to quarantine corrupted ${TOOLS_CONFIG_FILE}`,
      err,
    );
  }
}

async function readFromDisk(): Promise<ToolsConfig> {
  const path = toolsFilePath();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code === "ENOENT") {
      return emptyToolsConfig();
    }
    // Systemic IO error (permissions, disk, …). Throw instead of returning
    // empty defaults: the caller would cache them and the next patch would
    // persist that empty snapshot, wiping every registered MCP server,
    // skill, and override.
    console.error(`[tools-config] failed to read ${TOOLS_CONFIG_FILE}`, err);
    throw err instanceof Error ? err : new Error(String(err));
  }
  try {
    return parseToolsConfig(JSON.parse(text) as unknown);
  } catch {
    // Corrupted JSON: quarantine so the original survives any later write.
    await quarantineCorruptToolsFile(path);
    return emptyToolsConfig();
  }
}

async function readSettingsRaw(): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(settingsFilePath(), "utf8");
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return data as Record<string, unknown>;
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code !== "ENOENT") {
      console.error(
        `[tools-config] failed to read ${WORKSPACE_SETTINGS_FILE} for migration`,
        err,
      );
    }
    return null;
  }
}

const LEGACY_KEYS = [
  "mcpServers",
  "skills",
  "toolPermissionOverrides",
  "toolOfferOverrides",
  "toolDisplayOverrides",
  "toolOfferAutoBaseline",
] as const;

/**
 * Strip legacy Tools/MCP/Skills keys from settings.json (raw JSON rewrite).
 * No-op when those keys are already absent.
 */
async function stripLegacyFieldsFromSettings(): Promise<void> {
  const raw = await readSettingsRaw();
  if (!raw) return;
  let changed = false;
  for (const key of LEGACY_KEYS) {
    if (key in raw) {
      delete raw[key];
      changed = true;
    }
  }
  if (!changed) return;

  if (!appDataRoot) return;
  await mkdir(appDataRoot, { recursive: true });
  const target = settingsFilePath();
  const temp = `${target}.${process.pid}.tools-migrate.tmp`;
  const body = `${JSON.stringify(raw, null, 2)}\n`;
  await writeFile(temp, body, "utf8");
  await rename(temp, target);
}

/**
 * Ensure tools.json exists. If missing, migrate from settings.json once, then
 * strip those keys from settings. Idempotent.
 */
export async function migrateToolsConfigFromSettings(): Promise<ToolsConfig> {
  if (!appDataRoot) {
    throw new Error("Tools config root is not configured");
  }
  return withToolsConfigWriteLock(async () => {
    if (await fileExists(toolsFilePath())) {
      const existing = await readFromDisk();
      cache = existing;
      await stripLegacyFieldsFromSettings();
      return existing;
    }

    const settingsRaw = await readSettingsRaw();
    const legacy = extractLegacyToolsFieldsFromSettings(settingsRaw);
    const migrated = legacy ?? emptyToolsConfig();
    await persistUnlocked(migrated);
    if (legacy) {
      await stripLegacyFieldsFromSettings();
    }
    return migrated;
  });
}

/** Load tools.json into cache (after migrate). */
export async function loadToolsConfig(): Promise<ToolsConfig> {
  if (cache) return cache;
  return withToolsConfigWriteLock(async () => {
    if (cache) return cache;
    const loaded = await readFromDisk();
    cache = loaded;
    return loaded;
  });
}

/** Synchronous read of in-memory cache (empty defaults if never loaded). */
export function getToolsConfigCached(): ToolsConfig {
  return cache ?? emptyToolsConfig();
}

/** Read from disk under lock (updates cache). */
export async function readToolsConfig(): Promise<ToolsConfig> {
  return withToolsConfigWriteLock(async () => {
    const loaded = await readFromDisk();
    cache = loaded;
    return loaded;
  });
}

/** Full replace write. */
export async function writeToolsConfig(
  config: ToolsConfig,
): Promise<ToolsConfig> {
  return withToolsConfigWriteLock(async () => {
    return persistUnlocked(parseToolsConfig(config));
  });
}

/**
 * Apply a sparse patch onto on-disk tools.json under a write lock.
 * Only keys present on `patch` are overwritten.
 */
export async function patchToolsConfig(
  patch: ToolsConfigPatch,
): Promise<ToolsConfig> {
  return withToolsConfigWriteLock(async () => {
    const current = cache ?? (await readFromDisk());
    const next: ToolsConfig = {
      version: 1,
      mcpServers:
        patch.mcpServers !== undefined
          ? patch.mcpServers
          : current.mcpServers,
      skills: patch.skills !== undefined ? patch.skills : current.skills,
      toolPermissionOverrides:
        patch.toolPermissionOverrides !== undefined
          ? patch.toolPermissionOverrides
          : current.toolPermissionOverrides,
      toolOfferOverrides:
        patch.toolOfferOverrides !== undefined
          ? patch.toolOfferOverrides
          : current.toolOfferOverrides,
      toolDisplayOverrides:
        patch.toolDisplayOverrides !== undefined
          ? patch.toolDisplayOverrides
          : current.toolDisplayOverrides,
      toolOfferAutoBaseline:
        patch.toolOfferAutoBaseline !== undefined
          ? patch.toolOfferAutoBaseline
          : current.toolOfferAutoBaseline,
      shellSafety:
        patch.shellSafety !== undefined ? patch.shellSafety : current.shellSafety,
    };
    return persistUnlocked(parseToolsConfig(next));
  });
}
