import type { Dirent } from "node:fs";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { listSupportingFiles } from "./files.js";
import { parseSkillMarkdown } from "./parseSkillMd.js";
import type {
  SkillRevisionContent,
  SkillRevisionMeta,
} from "./types.js";

/**
 * Skill version snapshots under `{skillsRoot}/.history/<skillId>/<revision>/`
 * (`meta.json` + `package/`, a copy of the skill directory). Snapshots are
 * taken before a mutation replaces that revision.
 */

export const SKILL_HISTORY_DIR = ".history";
export const SKILL_HISTORY_KEEP = 20;
export const SKILL_HISTORY_DELETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DELETED_MARKER = ".deleted";

function skillHistoryDir(skillsRoot: string, skillId: string): string {
  const safe = skillId.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!safe) throw new Error("Skill id is required for history");
  return join(skillsRoot, SKILL_HISTORY_DIR, safe);
}

function revisionDir(skillsRoot: string, skillId: string, revision: number): string {
  return join(skillHistoryDir(skillsRoot, skillId), String(revision));
}

export function revisionPackageDir(
  skillsRoot: string,
  skillId: string,
  revision: number,
): string {
  return join(revisionDir(skillsRoot, skillId, revision), "package");
}

export async function snapshotSkillRevision(input: {
  skillsRoot: string;
  skillId: string;
  sourceDir: string;
  meta: SkillRevisionMeta;
  keep?: number;
}): Promise<void> {
  const dir = revisionDir(input.skillsRoot, input.skillId, input.meta.revision);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await cp(input.sourceDir, join(dir, "package"), { recursive: true });
  await writeFile(join(dir, "meta.json"), `${JSON.stringify(input.meta, null, 2)}\n`, "utf8");
  await pruneSkillRevisions(input.skillsRoot, input.skillId, input.keep ?? SKILL_HISTORY_KEEP);
}

async function revisionNumbers(skillsRoot: string, skillId: string): Promise<number[]> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(skillHistoryDir(skillsRoot, skillId), { withFileTypes: true });
  } catch {
    return [];
  }
  return dirents
    .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
    .map((d) => Number(d.name))
    .sort((a, b) => b - a);
}

export async function pruneSkillRevisions(
  skillsRoot: string,
  skillId: string,
  keep: number,
): Promise<void> {
  const revisions = await revisionNumbers(skillsRoot, skillId);
  for (const revision of revisions.slice(Math.max(0, keep))) {
    await rm(revisionDir(skillsRoot, skillId, revision), { recursive: true, force: true });
  }
}

/** Snapshots newest first. Unreadable entries are skipped. */
export async function listSkillRevisions(
  skillsRoot: string,
  skillId: string,
): Promise<SkillRevisionMeta[]> {
  const out: SkillRevisionMeta[] = [];
  for (const revision of await revisionNumbers(skillsRoot, skillId)) {
    try {
      const raw = JSON.parse(
        await readFile(join(revisionDir(skillsRoot, skillId, revision), "meta.json"), "utf8"),
      ) as SkillRevisionMeta;
      out.push({ ...raw, revision });
    } catch {
      // partial snapshot; skip
    }
  }
  return out;
}

export async function readSkillPackage(
  dir: string,
  revision: number,
  fallbackName: string,
): Promise<SkillRevisionContent> {
  const skillMd = await readFile(join(dir, "SKILL.md"), "utf8");
  const parsed = parseSkillMarkdown(skillMd);
  return {
    revision,
    name: parsed.name || fallbackName,
    description: parsed.description,
    body: parsed.body,
    skillMd,
    files: await listSupportingFiles(dir),
  };
}

export async function readSkillRevision(
  skillsRoot: string,
  skillId: string,
  revision: number,
): Promise<SkillRevisionContent> {
  const metas = await listSkillRevisions(skillsRoot, skillId);
  const meta = metas.find((m) => m.revision === revision);
  if (!meta) throw new Error(`Revision ${revision} not found for skill ${skillId}`);
  return readSkillPackage(
    revisionPackageDir(skillsRoot, skillId, revision),
    revision,
    meta.name,
  );
}

export async function markSkillHistoryDeleted(
  skillsRoot: string,
  skillId: string,
  at: number = Date.now(),
): Promise<void> {
  const dir = skillHistoryDir(skillsRoot, skillId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, DELETED_MARKER), String(at), "utf8");
}

/** Drop history of skills deleted longer than the retention window. */
export async function pruneDeletedSkillHistory(
  skillsRoot: string,
  now: number = Date.now(),
  retentionMs: number = SKILL_HISTORY_DELETED_RETENTION_MS,
): Promise<string[]> {
  const root = join(skillsRoot, SKILL_HISTORY_DIR);
  let dirents: Dirent[];
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const pruned: string[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const marker = join(root, dirent.name, DELETED_MARKER);
    let deletedAt: number;
    try {
      const text = (await readFile(marker, "utf8")).trim();
      deletedAt = Number(text) || (await stat(marker)).mtimeMs;
    } catch {
      continue;
    }
    if (now - deletedAt < retentionMs) continue;
    await rm(join(root, dirent.name), { recursive: true, force: true });
    pruned.push(dirent.name);
  }
  return pruned;
}
