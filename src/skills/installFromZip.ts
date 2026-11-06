import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import AdmZip from "adm-zip";
import { parseSkillMarkdown } from "./parseSkillMd.js";
import { isValidSkillName, normalizeSkillName } from "./toolHelpers.js";

export type DiscoveredSkillPackage = {
  /** Absolute path to the skill folder (contains SKILL.md). */
  sourceDir: string;
  /** Resolved skill slug. */
  name: string;
  description: string;
  body: string;
};

export type InstallFromZipOptions = {
  /** Only install packages whose name matches (after normalize). */
  name?: string | undefined;
};

/**
 * Extract a zip and discover skill packages (directories containing SKILL.md).
 * Caller must delete `tempDir` when finished.
 */
export async function extractAndDiscoverSkills(
  zipPath: string,
  options?: InstallFromZipOptions,
): Promise<{ tempDir: string; packages: DiscoveredSkillPackage[] }> {
  const tempDir = await mkdtemp(join(tmpdir(), "jellybot-skill-"));
  try {
    const zip = new AdmZip(zipPath);
    // Guard zip-slip: only extract entries that stay under tempDir.
    for (const entry of zip.getEntries()) {
      const name = entry.entryName.replace(/\\/g, "/");
      if (!name || name.includes("\0")) {
        throw new Error(`Invalid zip entry: ${entry.entryName}`);
      }
      const parts = name.split("/");
      if (parts.some((p) => p === "..")) {
        throw new Error(`Zip entry escapes destination: ${entry.entryName}`);
      }
    }
    zip.extractAllTo(tempDir, true);

    let packages = await discoverSkillPackages(tempDir);
    const filterName =
      typeof options?.name === "string" && options.name.trim()
        ? normalizeSkillName(options.name)
        : null;
    if (filterName) {
      packages = packages.filter((p) => p.name === filterName);
      if (packages.length === 0) {
        throw new Error(
          `No skill named "${filterName}" found in the zip.`,
        );
      }
    }
    if (packages.length === 0) {
      throw new Error(
        "No skill packages found. Expected at least one directory containing SKILL.md.",
      );
    }
    return { tempDir, packages };
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/** Walk a directory tree and find folders that contain SKILL.md. */
export async function discoverSkillPackages(
  rootDir: string,
): Promise<DiscoveredSkillPackage[]> {
  const skillMdPaths: string[] = [];
  await findSkillMdFiles(rootDir, skillMdPaths);
  const packages: DiscoveredSkillPackage[] = [];

  for (const skillMdPath of skillMdPaths) {
    const sourceDir = dirname(skillMdPath);
    const raw = await readFile(skillMdPath, "utf8");
    const parsed = parseSkillMarkdown(raw);
    const folderName = normalizeSkillName(basename(sourceDir));
    const frontName = normalizeSkillName(parsed.name);
    const name = isValidSkillName(frontName)
      ? frontName
      : isValidSkillName(folderName)
        ? folderName
        : "";
    if (!name) {
      throw new Error(
        `Could not resolve a valid skill name for ${skillMdPath}. Set frontmatter name or use a slug folder name.`,
      );
    }
    const description = parsed.description.trim();
    if (!description) {
      throw new Error(
        `Skill "${name}" is missing a description in SKILL.md frontmatter.`,
      );
    }
    packages.push({
      sourceDir,
      name,
      description,
      body: parsed.body,
    });
  }

  // Prefer deeper packages if duplicates somehow appear; unique by name last-wins with warn via throw on conflict in same zip.
  const byName = new Map<string, DiscoveredSkillPackage>();
  for (const pkg of packages) {
    const existing = byName.get(pkg.name);
    if (existing && existing.sourceDir !== pkg.sourceDir) {
      throw new Error(
        `Zip contains multiple packages named "${pkg.name}".`,
      );
    }
    byName.set(pkg.name, pkg);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function findSkillMdFiles(
  dir: string,
  out: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await findSkillMdFiles(abs, out);
      continue;
    }
    if (entry.isFile() && entry.name === "SKILL.md") {
      out.push(abs);
    }
  }
}
