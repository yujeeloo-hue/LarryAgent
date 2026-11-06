import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { SkillConfig } from "../toolsConfig/types.js";
import { readToolsConfig } from "../toolsConfig/store.js";
import {
  listSupportingFiles,
  readSupportingFileText,
  removeSupportingFiles,
  writeSupportingFiles,
  type SkillFileWrite,
} from "./files.js";
import { extractAndDiscoverSkills } from "./installFromZip.js";
import {
  parseSkillMarkdown,
  serializeSkillMarkdown,
} from "./parseSkillMd.js";
import {
  clampSkillDescription,
  isValidSkillName,
  normalizeSkillName,
} from "./toolHelpers.js";
import type {
  SkillCatalogEntry,
  SkillInstallOptions,
  SkillInstallResult,
  SkillRecord,
  SkillUpsertInput,
} from "./types.js";

type SkillPersistHandler = (configs: SkillConfig[]) => Promise<void>;

let persistHandler: SkillPersistHandler | null = null;
let skillsRoot: string | null = null;

/**
 * Wire settings persistence for mutating skill manager ops (IPC + agent tools).
 * Call once from main after app data root is known.
 */
export function configureSkillPersistence(
  handler: SkillPersistHandler,
): void {
  persistHandler = handler;
}

/** Set `{userData}/skills` root. Call once from main before startFromSettings. */
export function configureSkillsRoot(root: string): void {
  skillsRoot = root;
}

type SkillState = {
  config: SkillConfig;
  description: string;
  body: string;
  files: string[];
};

function skillDir(name: string): string {
  if (!skillsRoot) {
    throw new Error("Skills root is not configured");
  }
  return join(skillsRoot, name);
}

function skillFilePath(name: string): string {
  return join(skillDir(name), "SKILL.md");
}

function cloneConfig(config: SkillConfig): SkillConfig {
  return {
    id: config.id,
    name: config.name,
    enabled: config.enabled,
  };
}

function toRecord(state: SkillState): SkillRecord {
  return {
    id: state.config.id,
    name: state.config.name,
    enabled: state.config.enabled,
    description: state.description,
    body: state.body,
    path: skillFilePath(state.config.name),
    directory: skillDir(state.config.name),
    files: [...state.files],
  };
}

/**
 * Owns skill configs (settings index) and on-disk skill packages (SKILL.md + files).
 */
export class SkillManager {
  private readonly skills = new Map<string, SkillState>();

  /** Skill ids removed this session — excluded from persistMerged so a
   * legitimate delete is never resurrected by the disk merge. */
  private readonly removedIds = new Set<string>();

  /** Load index from settings and hydrate content from disk. */
  async startFromSettings(configs: SkillConfig[]): Promise<void> {
    if (!skillsRoot) {
      throw new Error("Skills root is not configured");
    }
    await mkdir(skillsRoot, { recursive: true });
    this.skills.clear();
    this.removedIds.clear();

    for (const config of configs) {
      const name = normalizeSkillName(config.name);
      if (!isValidSkillName(name)) continue;
      const state: SkillState = {
        config: {
          id: config.id.trim() || randomUUID(),
          name,
          enabled: config.enabled !== false,
        },
        description: "",
        body: "",
        files: [],
      };
      await this.hydrateFromDisk(state);
      this.skills.set(state.config.id, state);
    }
  }

  /**
   * Persist the runtime registry, merging in on-disk entries the runtime
   * never saw (failed hydration, skipped invalid-name loads, hand edits).
   * Memory wins by id; {@link removedIds} keeps real deletes final.
   */
  private async persistMerged(): Promise<void> {
    if (!persistHandler) return;
    const merged = new Map(
      this.getConfigs().map((config) => [config.id, config]),
    );
    try {
      const disk = await readToolsConfig();
      for (const entry of disk.skills) {
        if (merged.has(entry.id) || this.removedIds.has(entry.id)) continue;
        merged.set(entry.id, entry);
        console.warn(
          `[skills] preserving registry entry "${entry.name}" (${entry.id}) missing from runtime state`,
        );
      }
    } catch (err) {
      console.error(
        "[skills] failed to re-read tools.json before persist; writing runtime snapshot only",
        err,
      );
    }
    await persistHandler([...merged.values()]);
  }

  /**
   * Re-read tools.json from disk and re-hydrate all skills. Used after agent
   * skill tools (create/update/delete/install/write) to keep runtime state
   * (SKILL.md description/body/files) aligned with disk.
   */
  async reloadFromDisk(): Promise<void> {
    const tools = await readToolsConfig();
    await this.startFromSettings(tools.skills);
  }

  /**
   * Scan `{skillsRoot}` for unregistered skill directories (containing
   * SKILL.md) and re-register them. Heals registries lost to partial writes:
   * SKILL.md bodies live on disk, so the package survives even when the
   * tools.json index drops it. Returns records for re-registered skills.
   */
  async reconcileOrphans(): Promise<SkillRecord[]> {
    if (!skillsRoot) {
      throw new Error("Skills root is not configured");
    }
    let dirents: Dirent[];
    try {
      dirents = await readdir(skillsRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const registered = new Set(
      [...this.skills.values()].map((s) => s.config.name),
    );
    const recovered: SkillRecord[] = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const name = dirent.name;
      try {
        await access(join(skillsRoot, name, "SKILL.md"));
      } catch {
        continue;
      }
      if (registered.has(name)) continue;
      if (!isValidSkillName(name)) {
        console.warn(
          `[skills] orphan directory "${name}" has an invalid slug; rename it to a lowercase-hyphen form to recover`,
        );
        continue;
      }
      const state: SkillState = {
        config: { id: randomUUID(), name, enabled: true },
        description: "",
        body: "",
        files: [],
      };
      await this.hydrateFromDisk(state);
      this.skills.set(state.config.id, state);
      recovered.push(toRecord(state));
    }
    if (recovered.length > 0) {
      await this.persistMerged();
    }
    return recovered;
  }

  getConfigs(): SkillConfig[] {
    return [...this.skills.values()].map((s) => cloneConfig(s.config));
  }

  listRecords(): SkillRecord[] {
    return [...this.skills.values()]
      .map(toRecord)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getRecord(id: string): SkillRecord | null {
    const state = this.skills.get(id);
    return state ? toRecord(state) : null;
  }

  findSkill(idOrName: string): {
    record: SkillRecord | null;
    ambiguous: boolean;
  } {
    const key = idOrName.trim();
    if (!key) return { record: null, ambiguous: false };
    const byId = this.skills.get(key);
    if (byId) return { record: toRecord(byId), ambiguous: false };

    const needle = normalizeSkillName(key);
    const matches = [...this.skills.values()].filter(
      (s) => s.config.name === needle,
    );
    if (matches.length === 1) {
      return { record: toRecord(matches[0]!), ambiguous: false };
    }
    if (matches.length > 1) {
      return { record: null, ambiguous: true };
    }
    return { record: null, ambiguous: false };
  }

  listEnabledCatalog(): SkillCatalogEntry[] {
    return [...this.skills.values()]
      .filter((s) => s.config.enabled)
      .map((s) => ({
        name: s.config.name,
        description: s.description.trim() || "(no description)",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async upsertSkill(input: SkillUpsertInput): Promise<SkillRecord> {
    const name = normalizeSkillName(input.name);
    if (!isValidSkillName(name)) {
      throw new Error(
        `Invalid skill name "${input.name}". Use lowercase letters, numbers, and hyphens (max ${64}).`,
      );
    }
    const description = clampSkillDescription(input.description);
    if (!description) {
      throw new Error("Skill description is required.");
    }
    const body = typeof input.body === "string" ? input.body : "";
    const enabled = input.enabled !== false;
    const files = Array.isArray(input.files) ? input.files : [];
    const removeFiles = Array.isArray(input.removeFiles)
      ? input.removeFiles
      : [];

    const existingId =
      typeof input.id === "string" && input.id.trim()
        ? input.id.trim()
        : null;

    if (existingId) {
      const state = this.skills.get(existingId);
      if (!state) {
        throw new Error(`Unknown skill id: ${existingId}`);
      }
      const nameTaken = [...this.skills.values()].some(
        (s) => s.config.id !== existingId && s.config.name === name,
      );
      if (nameTaken) {
        throw new Error(`A skill named "${name}" already exists.`);
      }

      const oldName = state.config.name;
      if (oldName !== name) {
        await mkdir(skillsRoot!, { recursive: true });
        await rename(skillDir(oldName), skillDir(name));
      }

      state.config.name = name;
      state.config.enabled = enabled;
      state.description = description;
      state.body = body;
      await this.writeDisk(state);
      if (removeFiles.length > 0) {
        await removeSupportingFiles(skillDir(name), removeFiles);
      }
      if (files.length > 0) {
        await writeSupportingFiles(
          skillDir(name),
          files as SkillFileWrite[],
        );
      }
      state.files = await listSupportingFiles(skillDir(name));
      await this.persistMerged();
      return toRecord(state);
    }

    const nameTaken = [...this.skills.values()].some(
      (s) => s.config.name === name,
    );
    if (nameTaken) {
      throw new Error(`A skill named "${name}" already exists.`);
    }

    const state: SkillState = {
      config: {
        id: randomUUID(),
        name,
        enabled,
      },
      description,
      body,
      files: [],
    };
    await this.writeDisk(state);
    if (files.length > 0) {
      await writeSupportingFiles(skillDir(name), files as SkillFileWrite[]);
    }
    state.files = await listSupportingFiles(skillDir(name));
    this.skills.set(state.config.id, state);
    await this.persistMerged();
    return toRecord(state);
  }

  async writeSkillFile(
    idOrName: string,
    relativePath: string,
    content: string,
  ): Promise<SkillRecord> {
    const { record, ambiguous } = this.findSkill(idOrName);
    if (ambiguous) {
      throw new Error(
        `Ambiguous skill name "${idOrName}". Use the skill id instead.`,
      );
    }
    if (!record) {
      throw new Error(`Skill not found: ${idOrName}`);
    }
    const state = this.skills.get(record.id);
    if (!state) {
      throw new Error(`Skill not found: ${idOrName}`);
    }
    await writeSupportingFiles(skillDir(state.config.name), [
      { path: relativePath, content },
    ]);
    state.files = await listSupportingFiles(skillDir(state.config.name));
    return toRecord(state);
  }

  async readSkillFile(
    idOrName: string,
    relativePath: string,
  ): Promise<{ record: SkillRecord; content: string }> {
    const { record, ambiguous } = this.findSkill(idOrName);
    if (ambiguous) {
      throw new Error(
        `Ambiguous skill name "${idOrName}". Use the skill id instead.`,
      );
    }
    if (!record) {
      throw new Error(`Skill not found: ${idOrName}`);
    }
    const content = await readSupportingFileText(
      skillDir(record.name),
      relativePath,
    );
    return { record, content };
  }

  async removeSkill(id: string): Promise<void> {
    const state = this.skills.get(id);
    if (!state) {
      throw new Error(`Unknown skill id: ${id}`);
    }
    this.skills.delete(id);
    this.removedIds.add(id);
    try {
      await rm(skillDir(state.config.name), { recursive: true, force: true });
    } catch {
      // ignore missing dir
    }
    await this.persistMerged();
  }

  async setEnabled(id: string, enabled: boolean): Promise<SkillRecord> {
    const state = this.skills.get(id);
    if (!state) {
      throw new Error(`Unknown skill id: ${id}`);
    }
    state.config.enabled = enabled;
    await this.persistMerged();
    return toRecord(state);
  }

  /**
   * Install one or more skill packages from a zip archive into `{userData}/skills`.
   */
  async installFromZip(
    zipPath: string,
    options?: SkillInstallOptions,
  ): Promise<SkillInstallResult> {
    if (!skillsRoot) {
      throw new Error("Skills root is not configured");
    }
    try {
      await access(zipPath);
    } catch {
      throw new Error(`Zip not found: ${zipPath}`);
    }

    const overwrite = options?.overwrite === true;
    const enabled = options?.enabled !== false;
    const { tempDir, packages } = await extractAndDiscoverSkills(zipPath, {
      name: options?.name,
    });

    try {
      const conflicts = packages.filter((pkg) =>
        [...this.skills.values()].some((s) => s.config.name === pkg.name),
      );
      if (conflicts.length > 0 && !overwrite) {
        const names = conflicts.map((c) => c.name).join(", ");
        throw new Error(
          `Skill(s) already installed: ${names}. Pass overwrite=true to replace.`,
        );
      }

      const installed: SkillRecord[] = [];
      const overwritten: string[] = [];
      for (const pkg of packages) {
        const result = await this.installLocalPackage(pkg.sourceDir, {
          name: pkg.name,
          enabled,
          overwrite,
          fallback: { description: pkg.description, body: pkg.body },
        });
        installed.push(result.record);
        if (result.overwritten) overwritten.push(pkg.name);
      }
      await this.persistMerged();
      return { installed, overwritten };
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Install one already-extracted skill package directory into
   * `{skillsRoot}/<name>`. Replacing an existing package is a rename swap:
   * the new package is staged first and the previous directory is kept as a
   * backup until the switch succeeds, so a failed copy never leaves the
   * device without a usable skill directory.
   */
  async installLocalPackage(
    sourceDir: string,
    options: {
      name: string;
      enabled: boolean;
      overwrite?: boolean;
      /** Used when SKILL.md carries no frontmatter description/body. */
      fallback?: { description?: string; body?: string };
    },
  ): Promise<{ record: SkillRecord; overwritten: boolean }> {
    if (!skillsRoot) {
      throw new Error("Skills root is not configured");
    }
    const name = normalizeSkillName(options.name);
    if (!isValidSkillName(name)) {
      throw new Error(
        `Invalid skill name "${options.name}". Use lowercase letters, numbers, and hyphens (max 64).`,
      );
    }
    const sourceSkillMd = join(sourceDir, "SKILL.md");
    try {
      await access(sourceSkillMd);
    } catch {
      throw new Error(`Skill package is missing SKILL.md: ${sourceDir}`);
    }
    const parsed = parseSkillMarkdown(await readFile(sourceSkillMd, "utf8"));
    const description = clampSkillDescription(
      parsed.description || options.fallback?.description || "",
    );
    if (!description) {
      throw new Error(
        `Skill "${name}" is missing a description in SKILL.md frontmatter.`,
      );
    }
    const body = parsed.description ? parsed.body : (options.fallback?.body ?? parsed.body);

    const existing = [...this.skills.values()].find(
      (s) => s.config.name === name,
    );
    if (existing && options.overwrite !== true) {
      throw new Error(
        `A skill named "${name}" already exists. Pass overwrite=true to replace.`,
      );
    }

    await mkdir(skillsRoot, { recursive: true });
    const stagingRoot = join(skillsRoot, ".staging");
    await mkdir(stagingRoot, { recursive: true });
    const stageDir = join(stagingRoot, `incoming-${randomUUID()}`);
    const backupDir = join(stagingRoot, `previous-${randomUUID()}`);
    const target = skillDir(name);

    try {
      await cp(sourceDir, stageDir, { recursive: true });
    } catch (err) {
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }

    let movedExisting = false;
    try {
      if (existing) {
        await rename(target, backupDir);
        movedExisting = true;
      }
      await rename(stageDir, target);
    } catch (err) {
      // Keep the previous package usable: restore the backup, drop staging.
      if (movedExisting) {
        await rename(backupDir, target).catch(() => undefined);
      }
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    if (movedExisting) {
      await rm(backupDir, { recursive: true, force: true }).catch((err) => {
        console.warn(`[skills] failed to clean up replaced package at ${backupDir}`, err);
      });
    }

    const state: SkillState = existing ?? {
      config: {
        id: randomUUID(),
        name,
        enabled: options.enabled,
      },
      description: "",
      body: "",
      files: [],
    };
    state.config.name = name;
    state.config.enabled = options.enabled;
    state.description = description;
    state.body = body;
    state.files = await listSupportingFiles(target);
    this.skills.set(state.config.id, state);
    await this.persistMerged();
    return { record: toRecord(state), overwritten: Boolean(existing) };
  }

  private async hydrateFromDisk(state: SkillState): Promise<void> {
    try {
      const raw = await readFile(skillFilePath(state.config.name), "utf8");
      const parsed = parseSkillMarkdown(raw);
      state.description = parsed.description;
      state.body = parsed.body;
    } catch {
      state.description = "";
      state.body = "";
    }
    try {
      state.files = await listSupportingFiles(skillDir(state.config.name));
    } catch {
      state.files = [];
    }
  }

  private async writeDisk(state: SkillState): Promise<void> {
    await mkdir(skillDir(state.config.name), { recursive: true });
    const markdown = serializeSkillMarkdown({
      name: state.config.name,
      description: state.description,
      body: state.body,
    });
    await writeFile(skillFilePath(state.config.name), markdown, "utf8");
  }
}

export const skillManager = new SkillManager();
