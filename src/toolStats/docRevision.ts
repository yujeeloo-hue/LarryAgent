import { createHash } from "node:crypto";
import {
  getToolDocRevision as readStoredDocRevision,
  upsertToolDocRevision,
  type SessionDatabase,
} from "../session/db/index.js";
import { getTool } from "../tools/registry.js";

type CachedRevision = { hash: string; revision: number };

const cache = new Map<string, CachedRevision>();

export function docHashOf(description: string): string {
  return createHash("sha256").update(description, "utf8").digest("hex").slice(0, 32);
}

function warn(message: string): void {
  console.error(`[tool-stats] doc revision ${message}`);
}

export function toolDocRevisionFor(
  db: SessionDatabase,
  name: string,
): number {
  const description = getTool(name)?.definition.description;
  if (typeof description !== "string") return cache.get(name)?.revision ?? 0;
  const hash = docHashOf(description);
  const cached = cache.get(name);
  if (cached && cached.hash === hash) return cached.revision;
  try {
    const stored = readStoredDocRevision(db, name);
    const revision = !stored
      ? 0
      : stored.docHash === hash
        ? stored.revision
        : stored.revision + 1;
    if (!stored || stored.docHash !== hash) {
      upsertToolDocRevision(db, {
        name,
        revision,
        docHash: hash,
        updatedAt: Date.now(),
      });
    }
    cache.set(name, { hash, revision });
    return revision;
  } catch (err) {
    warn(`lookup failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return cached?.revision ?? 0;
  }
}

export function resetToolDocRevisionCache(): void {
  cache.clear();
}
