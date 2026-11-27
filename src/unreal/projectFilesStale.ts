import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { findUproject } from "./uproject.js";
import { discoverFiles } from "./workspace.js";

const SOURCE_FILE_RE = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inl)$/i;
const GENERATION_SKEW_MS = 1_000;

export type UnrealProjectFilesStaleResult =
  | {
      ok: true;
      stale: boolean;
      reason: "missing" | "newer-files" | "up-to-date";
      newer?: string[];
      count?: number;
    }
  | { ok: false; message: string };

async function filesWithSuffix(dir: string, suffix: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(suffix))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

async function newestMtime(files: string[]): Promise<number | null> {
  let newest: number | null = null;
  for (const file of files) {
    try {
      const mtime = (await stat(file)).mtimeMs;
      if (newest === null || mtime > newest) newest = mtime;
    } catch {
    }
  }
  return newest;
}

function createdAtMs(birthtimeMs: number, ctimeMs: number): number {
  return Number.isFinite(birthtimeMs) && birthtimeMs > 0 ? birthtimeMs : ctimeMs;
}

export async function checkUnrealProjectFilesStale(
  workspacePath: string,
): Promise<UnrealProjectFilesStaleResult> {
  const hit = findUproject(workspacePath);
  if (!hit) return { ok: true, stale: false, reason: "up-to-date" };
  const projectRoot = hit.projectRoot;
  const solutions = await filesWithSuffix(projectRoot, ".sln");
  const projects = [
    ...(await filesWithSuffix(join(projectRoot, "Intermediate", "ProjectFiles"), ".vcxproj")),
    ...(await filesWithSuffix(projectRoot, ".vcxproj")),
  ];
  const generatedAt = await newestMtime([...solutions, ...projects]);
  if (!solutions.length || !projects.length || generatedAt === null) {
    return { ok: true, stale: true, reason: "missing" };
  }

  const sources = [
    ...(await discoverFiles(join(projectRoot, "Source"), (name) => SOURCE_FILE_RE.test(name))),
    ...(await discoverFiles(join(projectRoot, "Plugins"), (name) => SOURCE_FILE_RE.test(name))),
  ];
  const newer: string[] = [];
  for (const file of sources) {
    try {
      const info = await stat(file);
      if (createdAtMs(info.birthtimeMs, info.ctimeMs) <= generatedAt + GENERATION_SKEW_MS) continue;
      newer.push(relative(projectRoot, file).replace(/\\/g, "/").toLowerCase());
    } catch {
    }
  }
  newer.sort();
  return newer.length
    ? { ok: true, stale: true, reason: "newer-files", newer: newer.slice(0, 5), count: newer.length }
    : { ok: true, stale: false, reason: "up-to-date" };
}
