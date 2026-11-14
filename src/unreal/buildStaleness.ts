/**
 * Source-staleness check for the Debug build gate.
 *
 * The dev-task build gate is in-memory ("last Build run this session ended
 * done") and cannot see code edits made after that build — Debug would
 * launch the editor with `-skipcompile` against a stale binary. This
 * scanner compares UE-relevant source mtimes against the last build's
 * start time so ensureBuild can reopen the gate only when something the
 * native build consumes actually changed.
 *
 * Scope (what can change the DebugGame Editor binary):
 *   - <ws>/Source/…                  — any file (headers, cpp, cs, rc, ThirdParty)
 *   - <ws>/Plugins/<plugin>/Source/… — plugin C++ (nested plugin layouts included)
 *   - <ws>/Build/…                   — shared build scripts
 *   - <ws>/*.{uproject,Build.cs,Target.cs} — root descriptors/targets
 *
 * Deliberately out of scope: Config/, Content/ (never affect the native
 * binary), engine-side changes, and everything UBT only writes itself
 * (Intermediate/, Binaries/, DerivedDataCache/, Saved/ — also skipped for
 * scan speed).
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export type SourceStaleness = {
  stale: boolean;
  /** Newest relevant source file when stale, else null. */
  newestPath: string | null;
  /** mtimeMs of `newestPath` (0 when fresh). */
  newestMtime: number;
  /** Files inspected — surfaced for diagnostics/tests. */
  scannedFiles: number;
};

/**
 * Filesystem timestamps can lag real time slightly (FAT 2s granularity,
 * coarse ext4 clocks). Over-flagging costs one incremental UBT run that
 * UBT itself turns into a no-op; under-flagging costs debugging a stale
 * binary — so the tolerance biases conservative, and each build's newer
 * startedAt keeps it from ever looping.
 */
export const STALENESS_TOLERANCE_MS = 2_000;

/** Directory names skipped anywhere in the walk. */
const SKIP_DIRS = new Set([
  ".git",
  ".vs",
  ".vscode",
  "Binaries",
  "DerivedDataCache",
  "Intermediate",
  "node_modules",
  "Saved",
]);

const ROOT_DESCRIPTOR = /\.(uproject|build\.cs|target\.cs)$/i;

type Walk = {
  threshold: number;
  newestPath: string | null;
  newestMtime: number;
  scannedFiles: number;
};

async function checkFile(walk: Walk, path: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return; // vanished mid-walk — not evidence of staleness
  }
  if (!info.isFile()) return;
  walk.scannedFiles += 1;
  if (info.mtimeMs >= walk.threshold && info.mtimeMs > walk.newestMtime) {
    walk.newestMtime = info.mtimeMs;
    walk.newestPath = path;
  }
}

/**
 * Walk one directory. `filesCount` marks that every file in this subtree
 * counts (project Source/, Build/) as opposed to Plugins/, where only
 * paths under a `Source` segment do — so Content/ asset saves never
 * reopen the gate.
 */
async function walkDir(
  walk: Walk,
  dir: string,
  filesCount: boolean,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable/missing — nothing more this branch can say
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.isSymbolicLink()) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) return;
        const isSource = entry.name.toLowerCase() === "source";
        await walkDir(walk, path, filesCount || isSource);
        return;
      }
      if (!entry.isFile()) return;
      if (!filesCount) return;
      await checkFile(walk, path);
    }),
  );
}

/** Root files: descriptors and targets living beside the .uproject. */
async function walkRootFiles(walk: Walk, root: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) return;
      if (!ROOT_DESCRIPTOR.test(entry.name)) return;
      await checkFile(walk, join(root, entry.name));
    }),
  );
}

/**
 * Whether any build-relevant source under the workspace is at least as
 * new as `buildStartedAtMs` (minus the timestamp tolerance). Callers pass
 * the *start* of the last build, not its end: a file written while UBT was
 * running may or may not have been picked up, so it is conservatively
 * treated as stale.
 */
export async function findSourceNewerThan(
  workspacePath: string,
  buildStartedAtMs: number,
): Promise<SourceStaleness> {
  const walk: Walk = {
    threshold: buildStartedAtMs - STALENESS_TOLERANCE_MS,
    newestPath: null,
    newestMtime: 0,
    scannedFiles: 0,
  };
  await Promise.all([
    walkDir(walk, join(workspacePath, "Source"), true),
    walkDir(walk, join(workspacePath, "Plugins"), false),
    walkDir(walk, join(workspacePath, "Build"), true),
    walkRootFiles(walk, workspacePath),
  ]);
  return {
    stale: walk.newestPath !== null,
    newestPath: walk.newestPath,
    newestMtime: walk.newestMtime,
    scannedFiles: walk.scannedFiles,
  };
}
