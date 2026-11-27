import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { execGit } from "../git/execGit.js";
import { hasEngineSource, isUnrealProjectRoot } from "../unreal/engineRoot.js";
import {
  SCAN_RANK_NEUTRAL,
  dirRank,
  isIgnoredFileName,
  isSkippedDir,
  isSkippedRelPath,
  relPathRank,
  type ScanMode,
  type ScanRank,
  type ScanRules,
} from "./policy.js";

const GIT_LIST_TIMEOUT_MS = 15_000;
const GIT_LIST_MAX_BUFFER = 128 * 1024 * 1024;
const DEFAULT_MAX_DIRS = 200_000;

export type ScanFile = { absolute: string; rel: string };

export type ScanOptions = {
  root: string;
  relPrefix?: string;
  rank?: ScanRank;
  unreal?: boolean;
  onlyTopDirs?: ReadonlySet<string>;
  skipTopDirs?: ReadonlySet<string>;
  include?: (rel: string) => boolean;
  skipDir?: (name: string) => boolean;
  useGit?: boolean;
  deadline?: number;
  maxDirs?: number;
  shouldStop?: () => boolean;
  onFile: (file: ScanFile) => boolean | void;
};

export type ScanOutcome = {
  mode: ScanMode;
  unreal: boolean;
  stopped: boolean;
  aborted: boolean;
  truncated: boolean;
};

export function detectUnrealRoot(root: string): boolean {
  if (isUnrealProjectRoot(root) || hasEngineSource(root)) return true;
  const norm = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/(?:^|\/)engine\/(?:source|plugins)(?:\/|$)/i.test(norm)) return true;
  return basename(norm).toLowerCase() === "engine" && existsSync(join(root, "Source"));
}

function defaultSkipTopDirs(root: string): ReadonlySet<string> {
  return hasEngineSource(root) ? new Set(["engine"]) : new Set();
}

async function listViaGit(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execGit(
      root,
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: GIT_LIST_MAX_BUFFER, timeoutMs: GIT_LIST_TIMEOUT_MS },
    );
    const paths = [...new Set(stdout.split("\0").filter((p) => p.length > 0))];
    return paths.length > 0 ? paths : null;
  } catch {
    return null;
  }
}

function joinRel(prefix: string, rel: string): string {
  return prefix ? `${prefix}/${rel}` : rel;
}

function passesTopFilter(
  top: string,
  only: ReadonlySet<string> | undefined,
  skip: ReadonlySet<string>,
): boolean {
  const lower = top.toLowerCase();
  if (only && !only.has(lower)) return false;
  return !skip.has(lower);
}

function scanGitPaths(
  paths: string[],
  options: ScanOptions,
  rules: ScanRules,
  skipTop: ReadonlySet<string>,
): ScanOutcome {
  const prefix = options.relPrefix ?? "";
  const base = options.rank ?? SCAN_RANK_NEUTRAL;
  const ranked = paths
    .map((rel, index) => ({ rel, index, rank: relPathRank(rel, base) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  const outcome: ScanOutcome = {
    mode: "git",
    unreal: rules.unreal,
    stopped: false,
    aborted: false,
    truncated: false,
  };
  for (const { rel } of ranked) {
    if (options.shouldStop?.()) {
      outcome.aborted = true;
      return outcome;
    }
    const slash = rel.indexOf("/");
    if (slash > 0 && !passesTopFilter(rel.slice(0, slash), options.onlyTopDirs, skipTop)) {
      continue;
    }
    if (slash < 0 && options.onlyTopDirs) continue;
    if (isSkippedRelPath(rel, rules)) continue;
    const fullRel = joinRel(prefix, rel);
    if (options.include && !options.include(fullRel)) continue;
    const file = { absolute: join(options.root, ...rel.split("/")), rel: fullRel };
    if (options.onFile(file) === false) {
      outcome.stopped = true;
      return outcome;
    }
  }
  return outcome;
}

type WalkSeed = { dir: string; rel: string; rank: ScanRank; top: boolean };

async function scanWalk(
  options: ScanOptions,
  rules: ScanRules,
  skipTop: ReadonlySet<string>,
): Promise<ScanOutcome> {
  const outcome: ScanOutcome = {
    mode: "walk",
    unreal: rules.unreal,
    stopped: false,
    aborted: false,
    truncated: false,
  };
  const prefix = options.relPrefix ?? "";
  const base = options.rank ?? SCAN_RANK_NEUTRAL;
  const maxDirs = options.maxDirs ?? DEFAULT_MAX_DIRS;
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  const skipDir = options.skipDir ?? ((name: string) => isSkippedDir(name, rules));
  const buckets: WalkSeed[][] = [[], [], []];
  buckets[base]!.push({ dir: options.root, rel: prefix, rank: base, top: true });
  let visited = 0;

  for (let bucket = 0; bucket < buckets.length; bucket++) {
    const queue = buckets[bucket]!;
    for (let head = 0; head < queue.length; head++) {
      if (options.shouldStop?.()) {
        outcome.aborted = true;
        return outcome;
      }
      if (visited >= maxDirs || Date.now() > deadline) {
        outcome.truncated = true;
        return outcome;
      }
      const seed = queue[head]!;
      visited++;
      let dirents;
      try {
        dirents = await readdir(seed.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of dirents) {
        const rel = joinRel(seed.rel, entry.name);
        const absolute = join(seed.dir, entry.name);
        if (entry.isDirectory()) {
          if (skipDir(entry.name)) continue;
          if (seed.top && !passesTopFilter(entry.name, options.onlyTopDirs, skipTop)) continue;
          const rank = Math.max(seed.rank, dirRank(entry.name)) as ScanRank;
          buckets[rank]!.push({ dir: absolute, rel, rank, top: false });
          continue;
        }
        if (seed.top && options.onlyTopDirs) continue;
        if (!entry.isFile()) {
          if (!entry.isSymbolicLink()) continue;
          try {
            if (!(await stat(absolute)).isFile()) continue;
          } catch {
            continue;
          }
        }
        if (isIgnoredFileName(entry.name)) continue;
        if (options.include && !options.include(rel)) continue;
        if (options.onFile({ absolute, rel }) === false) {
          outcome.stopped = true;
          return outcome;
        }
      }
    }
  }
  return outcome;
}

export async function scanWorkspaceFiles(options: ScanOptions): Promise<ScanOutcome> {
  const unreal = options.unreal ?? detectUnrealRoot(options.root);
  const skipTop = options.skipTopDirs ?? defaultSkipTopDirs(options.root);
  if (options.useGit !== false && !options.skipDir) {
    const paths = await listViaGit(options.root);
    if (options.shouldStop?.()) {
      return { mode: "git", unreal, stopped: false, aborted: true, truncated: false };
    }
    if (paths) return scanGitPaths(paths, options, { mode: "git", unreal }, skipTop);
  }
  return scanWalk(options, { mode: "walk", unreal }, skipTop);
}

export type CollectedFiles = {
  files: ScanFile[];
  truncated: boolean;
  aborted: boolean;
  mode: ScanMode;
  unreal: boolean;
};

export async function collectWorkspaceFiles(
  options: Omit<ScanOptions, "onFile"> & { maxFiles?: number },
): Promise<CollectedFiles> {
  const files: ScanFile[] = [];
  const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
  let capped = false;
  const outcome = await scanWorkspaceFiles({
    ...options,
    onFile: (file) => {
      if (files.length >= maxFiles) {
        capped = true;
        return false;
      }
      files.push(file);
      return true;
    },
  });
  return {
    files,
    truncated: capped || outcome.truncated,
    aborted: outcome.aborted,
    mode: outcome.mode,
    unreal: outcome.unreal,
  };
}
