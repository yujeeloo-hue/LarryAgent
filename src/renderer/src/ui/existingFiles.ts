/** Cached filesystem checks for file paths scraped from conversation text. */

/** Missing paths are re-checked after this long (a build may still be running). */
const MISSING_TTL_MS = 60_000;

const known = new Map<string, { exists: boolean; checkedAt: number }>();

/** Keep only the paths that currently exist on disk as regular files. */
export async function filterExistingFiles(paths: string[]): Promise<string[]> {
  const bridge = window.jellybot;
  if (!bridge?.filterExistingFiles) return [];

  const now = Date.now();
  const stale = paths.filter((path) => {
    const entry = known.get(path);
    if (!entry) return true;
    return !entry.exists && now - entry.checkedAt > MISSING_TTL_MS;
  });

  if (stale.length > 0) {
    const existing = new Set(await bridge.filterExistingFiles(stale));
    const checkedAt = Date.now();
    for (const path of stale) {
      known.set(path, { exists: existing.has(path), checkedAt });
    }
  }

  return paths.filter((path) => known.get(path)?.exists === true);
}
