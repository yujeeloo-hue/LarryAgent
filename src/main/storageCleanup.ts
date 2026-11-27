
import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPUTER_USE_CACHE_DIR_NAME } from "../tools/computerUse/cache.js";

export const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const TMP_RETENTION_MS = 24 * 60 * 60 * 1000;

const BACKUP_FILE_RE = /^sessions\.sqlite\.v\d+-backup-.*$/;
const TMP_DIR_PREFIXES = ["jellybot-skill-", ".jellybot-pdf-"];

export const CACHE_DIR_NAMES = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "blob_storage",
  COMPUTER_USE_CACHE_DIR_NAME,
] as const;

export type StorageUsageCategory = { files: number; bytes: number };

export type StorageUsage = {
  logs: StorageUsageCategory;
  backup: StorageUsageCategory;
  caches: StorageUsageCategory;
  tmp: StorageUsageCategory;
  totalBytes: number;
};

export type CleanupResult = {
  freedBytes: number;
  removedFiles: number;
  categories: StorageUsage;
};

export type CleanupOptions = {
  now?: number;
  tmpRoot?: string;
};

function emptyCategory(): StorageUsageCategory {
  return { files: 0, bytes: 0 };
}

function addCategory(
  target: StorageUsageCategory,
  source: StorageUsageCategory,
): void {
  target.files += source.files;
  target.bytes += source.bytes;
}

function totalOf(usage: StorageUsage): number {
  return (
    usage.logs.bytes +
    usage.backup.bytes +
    usage.caches.bytes +
    usage.tmp.bytes
  );
}

async function dirSize(dir: string, depth = 0): Promise<StorageUsageCategory> {
  const out = emptyCategory();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    try {
      const st = await lstat(join(dir, name));
      if (st.isDirectory()) {
        if (depth < 4) addCategory(out, await dirSize(join(dir, name), depth + 1));
      } else if (st.isFile()) {
        out.files += 1;
        out.bytes += st.size;
      }
    } catch {
    }
  }
  return out;
}

async function scanOldEntries(
  dir: string,
  cutoff: number,
  maxDepth = 2,
  depth = 0,
): Promise<StorageUsageCategory> {
  const out = emptyCategory();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    try {
      const st = await lstat(p);
      const isOld = st.mtimeMs < cutoff;
      if (st.isDirectory()) {
        if (isOld) {
          addCategory(out, await dirSize(p));
        } else if (depth < maxDepth) {
          addCategory(out, await scanOldEntries(p, cutoff, maxDepth, depth + 1));
        }
      } else if (st.isFile() && isOld) {
        out.files += 1;
        out.bytes += st.size;
      }
    } catch {
    }
  }
  return out;
}

async function removeOldEntries(
  dir: string,
  cutoff: number,
  maxDepth = 2,
  depth = 0,
): Promise<StorageUsageCategory> {
  const removed = emptyCategory();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return removed;
  }
  for (const name of entries) {
    const p = join(dir, name);
    try {
      const st = await lstat(p);
      const isOld = st.mtimeMs < cutoff;
      if (st.isDirectory()) {
        if (isOld) {
          const sub = await dirSize(p);
          await rm(p, { recursive: true, force: true });
          addCategory(removed, sub);
        } else if (depth < maxDepth) {
          addCategory(
            removed,
            await removeOldEntries(p, cutoff, maxDepth, depth + 1),
          );
        }
      } else if (st.isFile() && isOld) {
        await rm(p, { force: true });
        removed.files += 1;
        removed.bytes += st.size;
      }
    } catch {
    }
  }
  return removed;
}

async function scanBackups(appDataRoot: string): Promise<StorageUsageCategory> {
  const out = emptyCategory();
  let entries: string[];
  try {
    entries = await readdir(appDataRoot);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!BACKUP_FILE_RE.test(name)) continue;
    try {
      const st = await lstat(join(appDataRoot, name));
      if (st.isFile()) {
        out.files += 1;
        out.bytes += st.size;
      }
    } catch {
    }
  }
  return out;
}

async function removeBackups(appDataRoot: string): Promise<StorageUsageCategory> {
  const removed = emptyCategory();
  let entries: string[];
  try {
    entries = await readdir(appDataRoot);
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (!BACKUP_FILE_RE.test(name)) continue;
    const p = join(appDataRoot, name);
    try {
      const st = await lstat(p);
      if (st.isFile()) {
        await rm(p, { force: true });
        removed.files += 1;
        removed.bytes += st.size;
      }
    } catch {
    }
  }
  return removed;
}

async function scanCaches(appDataRoot: string): Promise<StorageUsageCategory> {
  const out = emptyCategory();
  for (const name of CACHE_DIR_NAMES) {
    addCategory(out, await dirSize(join(appDataRoot, name)));
  }
  return out;
}

async function removeCaches(appDataRoot: string): Promise<StorageUsageCategory> {
  const removed = emptyCategory();
  for (const name of CACHE_DIR_NAMES) {
    const p = join(appDataRoot, name);
    const size = await dirSize(p);
    try {
      await rm(p, { recursive: true, force: true });
    } catch {
      continue;
    }
    addCategory(removed, size);
  }
  return removed;
}

async function scanTmp(tmpRoot: string, cutoff: number): Promise<StorageUsageCategory> {
  const out = emptyCategory();
  let entries: string[];
  try {
    entries = await readdir(tmpRoot);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!TMP_DIR_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const p = join(tmpRoot, name);
    try {
      const st = await lstat(p);
      if (st.mtimeMs < cutoff) addCategory(out, await dirSize(p));
    } catch {
    }
  }
  return out;
}

async function removeTmp(
  tmpRoot: string,
  cutoff: number,
): Promise<StorageUsageCategory> {
  const removed = emptyCategory();
  let entries: string[];
  try {
    entries = await readdir(tmpRoot);
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (!TMP_DIR_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const p = join(tmpRoot, name);
    try {
      const st = await lstat(p);
      if (st.mtimeMs < cutoff) {
        const size = await dirSize(p);
        await rm(p, { recursive: true, force: true });
        addCategory(removed, size);
      }
    } catch {
    }
  }
  return removed;
}

export async function scanStorageUsage(
  appDataRoot: string,
  options?: CleanupOptions,
): Promise<StorageUsage> {
  const now = options?.now ?? Date.now();
  const tmpRoot = options?.tmpRoot ?? tmpdir();
  const logCutoff = now - LOG_RETENTION_MS;
  const tmpCutoff = now - TMP_RETENTION_MS;

  const [logs, backup, caches, tmp] = await Promise.all([
    scanOldEntries(join(appDataRoot, "logs"), logCutoff),
    scanBackups(appDataRoot),
    scanCaches(appDataRoot),
    scanTmp(tmpRoot, tmpCutoff),
  ]);
  const usage: StorageUsage = { logs, backup, caches, tmp, totalBytes: 0 };
  usage.totalBytes = totalOf(usage);
  return usage;
}

export async function cleanupStorage(
  appDataRoot: string,
  options?: CleanupOptions,
): Promise<CleanupResult> {
  const now = options?.now ?? Date.now();
  const tmpRoot = options?.tmpRoot ?? tmpdir();
  const logCutoff = now - LOG_RETENTION_MS;
  const tmpCutoff = now - TMP_RETENTION_MS;

  const [logs, backup, caches, tmp] = await Promise.all([
    removeOldEntries(join(appDataRoot, "logs"), logCutoff),
    removeBackups(appDataRoot),
    removeCaches(appDataRoot),
    removeTmp(tmpRoot, tmpCutoff),
  ]);
  const categories: StorageUsage = { logs, backup, caches, tmp, totalBytes: 0 };
  categories.totalBytes = totalOf(categories);
  return {
    freedBytes: categories.totalBytes,
    removedFiles:
      logs.files + backup.files + caches.files + tmp.files,
    categories,
  };
}
