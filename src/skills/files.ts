import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  normalizeSkillRelativePath,
  resolveUnderSkillDir,
  SKILL_FILE_CONTENT_MAX,
  SKILL_FILES_BATCH_MAX,
} from "./paths.js";

export type SkillFileWrite = {
  path: string;
  content: string;
};

/** List supporting files (everything except SKILL.md) as POSIX relative paths. */
export async function listSupportingFiles(
  skillDirectory: string,
): Promise<string[]> {
  const out: string[] = [];
  await walk(skillDirectory, skillDirectory, out);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function walk(
  root: string,
  current: string,
  out: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = abs.slice(root.length).replace(/^[/\\]+/, "").replace(/\\/g, "/");
    if (!rel || rel.toLowerCase() === "skill.md") continue;
    out.push(rel);
  }
}

export async function readSupportingFileText(
  skillDirectory: string,
  relativePath: string,
): Promise<string> {
  const abs = resolveUnderSkillDir(skillDirectory, relativePath);
  try {
    return await readFile(abs, "utf8");
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    if (code === "ENOENT") {
      throw new Error(`File not found: ${relativePath}`);
    }
    throw err;
  }
}

export async function writeSupportingFiles(
  skillDirectory: string,
  files: SkillFileWrite[],
): Promise<string[]> {
  if (files.length === 0) return [];
  if (files.length > SKILL_FILES_BATCH_MAX) {
    throw new Error(
      `Too many files in one batch (max ${SKILL_FILES_BATCH_MAX}).`,
    );
  }

  const written: string[] = [];
  for (const file of files) {
    const norm = normalizeSkillRelativePath(file.path);
    if (!norm.ok) {
      throw new Error(norm.message);
    }
    if (typeof file.content !== "string") {
      throw new Error(`File "${norm.path}" content must be a string.`);
    }
    if (file.content.length > SKILL_FILE_CONTENT_MAX) {
      throw new Error(
        `File "${norm.path}" is too large (max ${SKILL_FILE_CONTENT_MAX} characters).`,
      );
    }
    const abs = resolveUnderSkillDir(skillDirectory, norm.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content, "utf8");
    written.push(norm.path);
  }
  return written;
}

export async function removeSupportingFiles(
  skillDirectory: string,
  relativePaths: string[],
): Promise<string[]> {
  const removed: string[] = [];
  for (const raw of relativePaths) {
    const norm = normalizeSkillRelativePath(raw);
    if (!norm.ok) {
      throw new Error(norm.message);
    }
    const abs = resolveUnderSkillDir(skillDirectory, norm.path);
    try {
      await rm(abs, { force: true });
      removed.push(norm.path);
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: unknown }).code)
          : "";
      if (code !== "ENOENT") throw err;
    }
  }
  return removed;
}
