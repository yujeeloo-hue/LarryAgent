
import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { execGit } from "../git/execGit.js";
import type { GlobMatcher } from "./globMatch.js";

export const WALK_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "out",
  "release",
  "tmp",
  ".jellybot",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".gradle",
  ".venv",
  "venv",
  "__pycache__",
  "coverage",
]);

export const MAX_CANDIDATE_FILES = 20_000;
const MAX_WALK_ENTRIES = 200_000;
const GIT_LIST_TIMEOUT_MS = 15_000;
const GIT_LIST_MAX_BUFFER = 64 * 1024 * 1024;

export type CandidateFile = {
  absolute: string;
  relative: string;
};

export type CandidateFileList = {
  files: CandidateFile[];
  truncated: boolean;
  source: "git" | "walk";
  aborted: boolean;
};

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

async function listViaWalk(input: {
  root: string;
  matches: GlobMatcher | null;
  maxFiles: number;
  signal: AbortSignal | undefined;
}): Promise<CandidateFileList> {
  const files: CandidateFile[] = [];
  let visited = 0;
  let truncated = false;

  const walk = async (dir: string, relDir: string): Promise<boolean> => {
    if (input.signal?.aborted) return false;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (input.signal?.aborted) return false;
      if (files.length >= input.maxFiles || visited >= MAX_WALK_ENTRIES) {
        truncated = true;
        return true;
      }
      visited++;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (WALK_SKIP_DIRS.has(entry.name)) continue;
        if (!(await walk(absolute, rel))) return false;
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (input.matches && !input.matches(rel)) continue;
        files.push({ absolute, relative: rel });
      }
    }
    return true;
  };

  const completed = await walk(input.root, "");
  return { files, truncated, source: "walk", aborted: !completed };
}

export async function listCandidateFiles(input: {
  root: string;
  matches?: GlobMatcher | null;
  maxFiles?: number;
  signal?: AbortSignal;
}): Promise<CandidateFileList> {
  const maxFiles = input.maxFiles ?? MAX_CANDIDATE_FILES;
  const matches = input.matches ?? null;

  const gitPaths = await listViaGit(input.root);
  if (input.signal?.aborted) {
    return { files: [], truncated: false, source: "git", aborted: true };
  }
  if (gitPaths) {
    const files: CandidateFile[] = [];
    let truncated = false;
    for (const rel of gitPaths) {
      if (matches && !matches(rel)) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      files.push({ absolute: join(input.root, rel.split("/").join(sep)), relative: rel });
    }
    return { files, truncated, source: "git", aborted: false };
  }

  return listViaWalk({ root: input.root, matches, maxFiles, signal: input.signal });
}
