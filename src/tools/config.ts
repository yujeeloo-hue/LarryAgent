import type { PermissionLevel } from "./types.js";

/**
 * In-memory permission overrides. Persisted as `toolPermissionOverrides`
 * in `{userData}/tools.json` by the main process.
 * Missing entry → use the tool's defaultPermissionLevel.
 */
const overrides = new Map<string, PermissionLevel>();

export function setToolPermissionLevel(
  name: string,
  level: PermissionLevel,
): void {
  overrides.set(name, level);
}

export function clearToolPermissionOverride(name: string): void {
  overrides.delete(name);
}

export function resolvePermissionLevel(
  name: string,
  defaultLevel: PermissionLevel,
): PermissionLevel {
  return overrides.get(name) ?? defaultLevel;
}

/** Snapshot of non-default overrides for tools.json persistence. */
export function getAllToolPermissionOverrides(): Record<string, PermissionLevel> {
  return Object.fromEntries(overrides);
}

/** Replace in-memory overrides from tools.json (call on app start). */
export function loadToolPermissionOverrides(
  entries: Record<string, PermissionLevel> | null | undefined,
): void {
  overrides.clear();
  if (!entries) return;
  for (const [name, level] of Object.entries(entries)) {
    const key = name.trim();
    if (!key) continue;
    if (level === 0 || level === 1 || level === 2) {
      overrides.set(key, level);
    }
  }
}

/** Drop overrides whose registry name starts with `prefix` (e.g. MCP server). */
export function clearToolPermissionOverridesWithPrefix(prefix: string): string[] {
  if (!prefix) return [];
  const removed: string[] = [];
  for (const name of [...overrides.keys()]) {
    if (name.startsWith(prefix)) {
      overrides.delete(name);
      removed.push(name);
    }
  }
  return removed;
}

