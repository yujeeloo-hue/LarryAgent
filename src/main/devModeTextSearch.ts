import { resolve } from "node:path";
import { devModeScanSeeds } from "./devModeFs.js";
import type { DevModeTextSearchChunk, DevModeTextSearchOptions } from "./devModeTextSearchTypes.js";
import { searchWorkspaceText, type TextSearchRoot } from "../workspaceScan/textSearch.js";

const MIN_QUERY_CHARS = 3;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1_000;

const running = new Map<number, AbortController>();

export function cancelDevModeTextSearch(ownerId: number): void {
  running.get(ownerId)?.abort();
  running.delete(ownerId);
}

export async function devModeTextRoots(
  root: string,
  options: DevModeTextSearchOptions,
): Promise<TextSearchRoot[]> {
  const seeds = await devModeScanSeeds(root, options);
  return seeds.map((seed) => ({
    root: seed.root,
    ...(seed.relPrefix ? { relPrefix: seed.relPrefix } : {}),
    ...(seed.unreal !== undefined ? { unreal: seed.unreal } : {}),
    ...(seed.topDirs ? { paths: seed.topDirs } : {}),
    ...(seed.skipTopDirs && seed.skipTopDirs.size > 0 ? { skipTopDirs: seed.skipTopDirs } : {}),
  }));
}

export async function startDevModeTextSearch(input: {
  ownerId: number;
  rootPath: unknown;
  requestId: unknown;
  query: unknown;
  options?: DevModeTextSearchOptions | null;
  post: (chunk: DevModeTextSearchChunk) => void;
}): Promise<{ ok: boolean; message?: string }> {
  if (typeof input.rootPath !== "string" || !input.rootPath.trim()) {
    return { ok: false, message: "Invalid path" };
  }
  if (!Number.isInteger(input.requestId)) {
    return { ok: false, message: "A request id is required" };
  }
  const requestId = input.requestId as number;
  const query = typeof input.query === "string" ? input.query.trim() : "";
  cancelDevModeTextSearch(input.ownerId);
  if (query.length < MIN_QUERY_CHARS) {
    input.post({ requestId, hits: [], done: true, truncated: false });
    return { ok: true };
  }
  const controller = new AbortController();
  running.set(input.ownerId, controller);
  const options = input.options ?? {};
  const limit = Math.min(
    Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT)),
    MAX_LIMIT,
  );
  try {
    const roots = await devModeTextRoots(resolve(input.rootPath.trim()), options);
    if (controller.signal.aborted) return { ok: true };
    const outcome = await searchWorkspaceText({
      roots,
      query,
      maxResults: limit,
      signal: controller.signal,
      onHits: (hits) => {
        if (!controller.signal.aborted) {
          input.post({ requestId, hits, done: false, truncated: false });
        }
      },
    });
    if (outcome.cancelled || controller.signal.aborted) return { ok: true };
    input.post({
      requestId,
      hits: [],
      done: true,
      truncated: outcome.truncated,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    return { ok: true };
  } finally {
    if (running.get(input.ownerId) === controller) running.delete(input.ownerId);
  }
}
