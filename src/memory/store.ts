import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  USER_MEMORY_FILENAME,
  emptyUserMemoryStore,
  type UserMemorySnapshot,
  type UserMemoryStore,
} from "./types.js";

let appDataRoot: string | null = null;
let cache: UserMemoryStore | null = null;

/** Set `{userData}` root. Call once from main before tools / extract. */
export function configureUserMemoryRoot(root: string): void {
  appDataRoot = root;
  cache = null;
}

function memoryFilePath(): string {
  if (!appDataRoot) {
    throw new Error("User memory root is not configured");
  }
  return join(appDataRoot, USER_MEMORY_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStore(raw: unknown): UserMemoryStore {
  if (!isRecord(raw)) return emptyUserMemoryStore();
  const profile = typeof raw.profile === "string" ? raw.profile : "";
  const updatedAt =
    typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
      ? Math.floor(raw.updatedAt)
      : 0;
  return {
    version: 1,
    updatedAt,
    profile,
  };
}

function toSnapshot(store: UserMemoryStore): UserMemorySnapshot {
  const profile = store.profile.trim();
  return {
    profile: store.profile,
    updatedAt: store.updatedAt,
    empty: profile.length === 0,
  };
}

/** Load from disk into cache (idempotent). */
export async function loadUserMemory(): Promise<UserMemorySnapshot> {
  if (cache) return toSnapshot(cache);

  const path = memoryFilePath();
  try {
    const text = await readFile(path, "utf8");
    cache = parseStore(JSON.parse(text) as unknown);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code !== "ENOENT") {
      // Corrupt / unreadable → start empty rather than crash the agent.
      cache = emptyUserMemoryStore();
    } else {
      cache = emptyUserMemoryStore();
    }
  }
  return toSnapshot(cache);
}

/** Synchronous read of in-memory cache (loads empty if never loaded). */
export function getUserMemoryCached(): UserMemorySnapshot {
  if (!cache) {
    return toSnapshot(emptyUserMemoryStore());
  }
  return toSnapshot(cache);
}

async function persist(store: UserMemoryStore): Promise<void> {
  if (!appDataRoot) {
    throw new Error("User memory root is not configured");
  }
  await mkdir(appDataRoot, { recursive: true });
  const target = memoryFilePath();
  const temp = `${target}.${process.pid}.tmp`;
  const body = `${JSON.stringify(store, null, 2)}\n`;
  await writeFile(temp, body, "utf8");
  await rename(temp, target);
  cache = store;
}

/**
 * Replace or merge the profile and persist. Never clamps: over-target
 * profiles are stored as-is (soft target only).
 * - `replace`: overwrite with `content`
 * - `merge`: append `content` after existing profile (or set if empty)
 */
export async function writeUserMemoryProfile(
  content: string,
  mode: "merge" | "replace" = "merge",
): Promise<UserMemorySnapshot> {
  await loadUserMemory();
  const existing = cache ?? emptyUserMemoryStore();
  const trimmed = content.trim();
  if (!trimmed && mode === "merge") {
    return toSnapshot(existing);
  }

  const nextProfile: string =
    mode === "replace" || !existing.profile.trim()
      ? trimmed
      : `${existing.profile.trim()}\n\n${trimmed}`;

  const next: UserMemoryStore = {
    version: 1,
    updatedAt: Date.now(),
    profile: nextProfile,
  };
  await persist(next);
  return toSnapshot(next);
}

/** Set the full profile text (used by Setting UI and extract). Never clamps. */
export async function setUserMemoryProfile(
  profile: string,
): Promise<UserMemorySnapshot> {
  const next: UserMemoryStore = {
    version: 1,
    updatedAt: Date.now(),
    profile: profile.trim(),
  };
  await persist(next);
  return toSnapshot(next);
}

/** Clear the profile (empty store persisted). */
export async function clearUserMemory(): Promise<UserMemorySnapshot> {
  const next = emptyUserMemoryStore();
  next.updatedAt = Date.now();
  await persist(next);
  return toSnapshot(next);
}
