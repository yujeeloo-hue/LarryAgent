
const MISSING_TTL_MS = 60_000;
const MAX_KNOWN = 4096;

const known = new Map<string, { exists: boolean; checkedAt: number }>();

function remember(path: string, exists: boolean, checkedAt: number): void {
  if (known.has(path)) known.delete(path);
  known.set(path, { exists, checkedAt });
  while (known.size > MAX_KNOWN) {
    const oldest = known.keys().next().value;
    if (oldest === undefined) break;
    known.delete(oldest);
  }
}

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
      remember(path, existing.has(path), checkedAt);
    }
  }

  return paths.filter((path) => known.get(path)?.exists === true);
}
