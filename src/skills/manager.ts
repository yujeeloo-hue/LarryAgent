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
import { normalizeSkillMeta } from "../toolsConfig/types.js";
import { readToolsConfig } from "../toolsConfig/store.js";
import {
  listSupportingFiles,
  readSupportingFileText,
  removeSupportingFiles,
  writeSupportingFiles,
  type SkillFileWrite,
} from "./files.js";
import {
  listSkillRevisions,
  markSkillHistoryDeleted,
  pruneDeletedSkillHistory,
  readSkillPackage,
  readSkillRevision,
  revisionPackageDir,
  snapshotSkillRevision,
} from "./history.js";
import { extractAndDiscoverSkills } from "./installFromZip.js";
import { normalizeSkillProject } from "./projectScope.js";
import { configureSkillProposalsRoot } from "./proposals.js";
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
  SkillMutationContext,
  SkillRecord,
  SkillRevisionContent,
  SkillRevisionEntry,
  SkillUpsertInput,
} from "./types.js";

type SkillPersistHandler = (configs: SkillConfig[]) => Promise<void>;

let persistHandler: SkillPersistHandler | null = null;
let skillsRoot: string | null = null;

const UI_CONTEXT: SkillMutationContext = { actor: "user" };

export type SkillMutationEvent = {
  skillId: string;
  kind: "create" | "change" | "deprecate" | "reactivate" | "delete";
  ctx: SkillMutationContext;
};
const mutationListeners = new Set<(event: SkillMutationEvent) => void>();

/** Observe skill writes (curation trigger accounting). Returns an unsubscribe. */
export function onSkillMutation(listener: (event: SkillMutationEvent) => void): () => void {
  mutationListeners.add(listener);
  return () => mutationListeners.delete(listener);
}

function emitMutation(event: SkillMutationEvent): void {
  for (const listener of mutationListeners) {
    try {
      listener(event);
    } catch (err) {
      console.warn("[skills] mutation listener failed", err);
    }
  }
}

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
  configureSkillProposalsRoot(root);
}

type SkillState = {
  config: SkillConfig;
  description: string;
  body: string;
  files: string[];
};

function requireRoot(): string {
  if (!skillsRoot) {
    throw new Error("Skills root is not configured");
  }
  return skillsRoot;
}

function skillDir(name: string): string {
  return join(requireRoot(), name);
}

function skillFilePath(name: string): string {
  return join(skillDir(name), "SKILL.md");
}

function cloneConfig(config: SkillConfig): SkillConfig {
  return {
    ...config,
    ...(config.createdFrom ? { createdFrom: { ...config.createdFrom } } : {}),
  };
}

function currentRevision(config: SkillConfig): number {
  return config.revision ?? 1;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
    await mkdir(requireRoot(), { recursive: true });
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
          ...normalizeSkillMeta(config as unknown as Record<string, unknown>),
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
    const root = requireRoot();
    let dirents: Dirent[];
    try {
      dirents = await readdir(root, { withFileTypes: true });
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
        await access(join(root, name, "SKILL.md"));
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
      recovered.push(this.toRecord(state));
    }
    if (recovered.length > 0) {
      await this.persistMerged();
    }
    return recovered;
  }

  /** Drop history of skills deleted more than 30 days ago. */
  async pruneDeletedHistory(now?: number): Promise<string[]> {
    return pruneDeletedSkillHistory(requireRoot(), now);
  }

  getConfigs(): SkillConfig[] {
    return [...this.skills.values()].map((s) => cloneConfig(s.config));
  }

  listRecords(): SkillRecord[] {
    return [...this.skills.values()]
      .map((s) => this.toRecord(s))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getRecord(id: string): SkillRecord | null {
    const state = this.skills.get(id);
    return state ? this.toRecord(state) : null;
  }

  findSkill(idOrName: string): {
    record: SkillRecord | null;
    ambiguous: boolean;
  } {
    const key = idOrName.trim();
    if (!key) return { record: null, ambiguous: false };
    const byId = this.skills.get(key);
    if (byId) return { record: this.toRecord(byId), ambiguous: false };

    const needle = normalizeSkillName(key);
    const matches = [...this.skills.values()].filter(
      (s) => s.config.name === needle,
    );
    if (matches.length === 1) {
      return { record: this.toRecord(matches[0]!), ambiguous: false };
    }
    if (matches.length > 1) {
      return { record: null, ambiguous: true };
    }
    return { record: null, ambiguous: false };
  }

  /** Enabled, active skills; `includeInactive` adds disabled and deprecated ones. */
  listEnabledCatalog(options?: { includeInactive?: boolean }): SkillCatalogEntry[] {
    const all = options?.includeInactive === true;
    return [...this.skills.values()]
      .filter((s) => all || (s.config.enabled && s.config.status !== "deprecated"))
      .map((s) => {
        const entry: SkillCatalogEntry = {
          name: s.config.name,
          description: s.description.trim() || "(no description)",
        };
        if (s.config.project) entry.project = s.config.project;
        if (!s.config.enabled) entry.enabled = false;
        if (s.config.status === "deprecated") {
          entry.status = "deprecated";
          const successor = this.successorName(s.config);
          if (successor) entry.supersededByName = successor;
        }
        return entry;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async upsertSkill(
    input: SkillUpsertInput,
    ctx: SkillMutationContext = UI_CONTEXT,
  ): Promise<SkillRecord> {
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

      await this.snapshotBeforeChange(state, ctx);
      const oldName = state.config.name;
      if (oldName !== name) {
        await mkdir(requireRoot(), { recursive: true });
        await rename(skillDir(oldName), skillDir(name));
      }

      state.config.name = name;
      state.config.enabled = enabled;
      if (input.project !== undefined) {
        const project = normalizeSkillProject(input.project);
        if (project) state.config.project = project;
        else delete state.config.project;
      }
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
      return this.toRecord(state);
    }

    const nameTaken = [...this.skills.values()].some(
      (s) => s.config.name === name,
    );
    if (nameTaken) {
      throw new Error(`A skill named "${name}" already exists.`);
    }

    const now = Date.now();
    const project = normalizeSkillProject(input.project);
    const state: SkillState = {
      config: {
        id: randomUUID(),
        name,
        enabled,
        origin: ctx.actor,
        status: "active",
        createdAt: now,
        updatedAt: now,
        revision: 1,
        ...(project ? { project } : {}),
        ...(ctx.sessionId
          ? {
              createdFrom: {
                sessionId: ctx.sessionId,
                ...(ctx.userMessageId ? { userMessageId: ctx.userMessageId } : {}),
              },
            }
          : {}),
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
    emitMutation({ skillId: state.config.id, kind: "create", ctx });
    return this.toRecord(state);
  }

  async writeSkillFile(
    idOrName: string,
    relativePath: string,
    content: string,
    ctx: SkillMutationContext = UI_CONTEXT,
  ): Promise<SkillRecord> {
    const state = this.requireState(idOrName);
    await this.snapshotBeforeChange(state, ctx);
    await writeSupportingFiles(skillDir(state.config.name), [
      { path: relativePath, content },
    ]);
    state.files = await listSupportingFiles(skillDir(state.config.name));
    await this.persistMerged();
    return this.toRecord(state);
  }

  async readSkillFile(
    idOrName: string,
    relativePath: string,
  ): Promise<{ record: SkillRecord; content: string }> {
    const state = this.requireState(idOrName);
    const content = await readSupportingFileText(
      skillDir(state.config.name),
      relativePath,
    );
    return { record: this.toRecord(state), content };
  }

  async removeSkill(
    id: string,
    ctx: SkillMutationContext = UI_CONTEXT,
  ): Promise<void> {
    const state = this.skills.get(id);
    if (!state) {
      throw new Error(`Unknown skill id: ${id}`);
    }
    await this.snapshotBeforeChange(state, ctx);
    await markSkillHistoryDeleted(requireRoot(), id).catch((err) => {
      console.warn(`[skills] failed to mark history of ${state.config.name} as deleted`, err);
    });
    this.skills.delete(id);
    this.removedIds.add(id);
    try {
      await rm(skillDir(state.config.name), { recursive: true, force: true });
    } catch {
      // ignore missing dir
    }
    await this.persistMerged();
    emitMutation({ skillId: id, kind: "delete", ctx });
  }

  async setEnabled(id: string, enabled: boolean): Promise<SkillRecord> {
    const state = this.skills.get(id);
    if (!state) {
      throw new Error(`Unknown skill id: ${id}`);
    }
    state.config.enabled = enabled;
    await this.persistMerged();
    return this.toRecord(state);
  }

  /**
   * Mark a skill deprecated and disabled (hidden from the default catalog).
   * Content is untouched, so no snapshot; {@link reactivateSkill} undoes it.
   */
  async deprecateSkill(
    idOrName: string,
    options: { supersededBy?: string | undefined },
    ctx: SkillMutationContext = UI_CONTEXT,
  ): Promise<SkillRecord> {
    const state = this.requireState(idOrName);
    let successorId: string | undefined;
    if (options.supersededBy) {
      const successor = this.requireState(options.supersededBy);
      if (successor.config.id === state.config.id) {
        throw new Error("A skill cannot supersede itself.");
      }
      successorId = successor.config.id;
    }
    state.config.status = "deprecated";
    state.config.enabled = false;
    if (successorId) state.config.supersededBy = successorId;
    else delete state.config.supersededBy;
    state.config.updatedAt = Date.now();
    this.takeOwnershipIfUser(state, ctx);
    await this.persistMerged();
    emitMutation({ skillId: state.config.id, kind: "deprecate", ctx });
    return this.toRecord(state);
  }

  async reactivateSkill(
    idOrName: string,
    ctx: SkillMutationContext = UI_CONTEXT,
  ): Promise<SkillRecord> {
    const state = this.requireState(idOrName);
    state.config.status = "active";
    state.config.enabled = true;
    delete state.config.supersededBy;
    state.config.updatedAt = Date.now();
    this.takeOwnershipIfUser(state, ctx);
    await this.persistMerged();
    emitMutation({ skillId: state.config.id, kind: "reactivate", ctx });
    return this.toRecord(state);
  }

  /**
   * Write the merged content into `target` (an existing skill id / name, or
   * a new skill named `target`), then deprecate every other source as
   * superseded by it. Sources are untouched when the target write fails.
   */
  async mergeSkills(
    input: {
      target: string;
      sources: string[];
      description: string;
      body: string;
      /** Scope for a newly created target; existing targets keep their own. */
      project?: string | undefined;
      files?: SkillUpsertInput["files"];
      removeFiles?: SkillUpsertInput["removeFiles"];
    },
    ctx: SkillMutationContext,
  ): Promise<{ target: SkillRecord; created: boolean; deprecated: SkillRecord[] }> {
    const existing = this.findSkill(input.target);
    if (existing.ambiguous) {
      throw new Error(`Ambiguous skill name "${input.target}". Use the skill id instead.`);
    }
    const targetState = existing.record ? this.skills.get(existing.record.id) : undefined;
    const sources = [
      ...new Map(
        input.sources
          .map((ref) => this.requireState(ref))
          .filter((s) => s.config.id !== targetState?.config.id)
          .map((s) => [s.config.id, s] as const),
      ).values(),
    ];
    if (sources.length === 0) {
      throw new Error("At least one source skill other than the target is required.");
    }
    const merged = await this.upsertSkill(
      {
        ...(targetState ? { id: targetState.config.id } : {}),
        name: targetState ? targetState.config.name : input.target,
        description: input.description,
        body: input.body,
        enabled: true,
        ...(!targetState && input.project !== undefined
          ? { project: input.project }
          : {}),
        files: input.files,
        removeFiles: targetState ? input.removeFiles : undefined,
      },
      ctx,
    );
    const deprecated: SkillRecord[] = [];
    for (const source of sources) {
      deprecated.push(
        await this.deprecateSkill(source.config.id, { supersededBy: merged.id }, ctx),
      );
    }
    return { target: merged, created: !targetState, deprecated };
  }

  /** Live version first, then snapshots newest first. */
  async listRevisions(id: string): Promise<SkillRevisionEntry[]> {
    const state = this.skills.get(id);
    const snapshots = await listSkillRevisions(requireRoot(), id);
    const out: SkillRevisionEntry[] = [];
    if (state) {
      out.push({
        revision: currentRevision(state.config),
        name: state.config.name,
        description: state.description,
        savedAt: state.config.updatedAt ?? state.config.createdAt ?? 0,
        replacedBy: { actor: state.config.origin ?? "user" },
        current: true,
      });
    }
    for (const snap of snapshots) out.push({ ...snap, current: false });
    return out;
  }

  async readRevision(id: string, revision: number): Promise<SkillRevisionContent> {
    const state = this.skills.get(id);
    if (state && revision === currentRevision(state.config)) {
      return readSkillPackage(skillDir(state.config.name), revision, state.config.name);
    }
    return readSkillRevision(requireRoot(), id, revision);
  }

  /**
   * Replace the live package with a stored revision. The live version is
   * snapshotted first, so a restore is itself undoable. Keeps the current name.
   */
  async restoreRevision(
    id: string,
    revision: number,
    ctx: SkillMutationContext = UI_CONTEXT,
  ): Promise<SkillRecord> {
    const state = this.skills.get(id);
    if (!state) throw new Error(`Unknown skill id: ${id}`);
    if (revision === currentRevision(state.config)) {
      throw new Error(`Revision ${revision} is already the live version.`);
    }
    const content = await readSkillRevision(requireRoot(), id, revision);
    const root = requireRoot();
    const stageDir = join(root, ".staging", `restore-${randomUUID()}`);
    await mkdir(join(root, ".staging"), { recursive: true });
    await cp(revisionPackageDir(root, id, revision), stageDir, { recursive: true });
    await writeFile(
      join(stageDir, "SKILL.md"),
      serializeSkillMarkdown({
        name: state.config.name,
        description: content.description,
        body: content.body,
        project: state.config.project,
      }),
      "utf8",
    );
    await this.snapshotBeforeChange(state, {
      ...ctx,
      reason: ctx.reason ?? `Restore revision ${revision}`,
    });
    await this.swapIntoPlace(skillDir(state.config.name), stageDir, true);
    state.description = clampSkillDescription(content.description);
    state.body = content.body;
    state.files = await listSupportingFiles(skillDir(state.config.name));
    await this.persistMerged();
    return this.toRecord(state);
  }

  /**
   * Install one or more skill packages from a zip archive into `{userData}/skills`.
   */
  async installFromZip(
    zipPath: string,
    options?: SkillInstallOptions,
  ): Promise<SkillInstallResult> {
    requireRoot();
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
    const root = requireRoot();
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

    await mkdir(root, { recursive: true });
    const stagingRoot = join(root, ".staging");
    await mkdir(stagingRoot, { recursive: true });
    const stageDir = join(stagingRoot, `incoming-${randomUUID()}`);
    const target = skillDir(name);

    try {
      await cp(sourceDir, stageDir, { recursive: true });
    } catch (err) {
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }

    if (existing) {
      try {
        await this.snapshotBeforeChange(existing, {
          actor: "installed",
          reason: "Replaced by package install",
        });
      } catch (err) {
        await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
      existing.config.origin = "installed";
    }
    await this.swapIntoPlace(target, stageDir, Boolean(existing));

    const now = Date.now();
    const state: SkillState = existing ?? {
      config: {
        id: randomUUID(),
        name,
        enabled: options.enabled,
        origin: "installed",
        status: "active",
        createdAt: now,
        updatedAt: now,
        revision: 1,
      },
      description: "",
      body: "",
      files: [],
    };
    state.config.name = name;
    state.config.enabled = options.enabled;
    if (parsed.project !== undefined) {
      const project = normalizeSkillProject(parsed.project);
      if (project) state.config.project = project;
      else delete state.config.project;
    }
    state.description = description;
    state.body = body;
    state.files = await listSupportingFiles(target);
    this.skills.set(state.config.id, state);
    await this.persistMerged();
    return { record: this.toRecord(state), overwritten: Boolean(existing) };
  }

  private requireState(idOrName: string): SkillState {
    const { record, ambiguous } = this.findSkill(idOrName);
    if (ambiguous) {
      throw new Error(
        `Ambiguous skill name "${idOrName}". Use the skill id instead.`,
      );
    }
    const state = record ? this.skills.get(record.id) : undefined;
    if (!state) {
      throw new Error(`Skill not found: ${idOrName}`);
    }
    return state;
  }

  private successorName(config: SkillConfig): string | undefined {
    if (!config.supersededBy) return undefined;
    return this.skills.get(config.supersededBy)?.config.name;
  }

  /** A user edit takes ownership away from automatic writers. */
  private takeOwnershipIfUser(state: SkillState, ctx: SkillMutationContext): void {
    if (ctx.actor === "user") state.config.origin = "user";
  }

  /**
   * Snapshot the live package as its current revision, then advance the
   * revision. Throws (aborting the mutation) when the snapshot cannot be
   * written, so no version is lost silently.
   */
  private async snapshotBeforeChange(
    state: SkillState,
    ctx: SkillMutationContext,
  ): Promise<void> {
    const revision = currentRevision(state.config);
    const dir = skillDir(state.config.name);
    if (await pathExists(join(dir, "SKILL.md"))) {
      await snapshotSkillRevision({
        skillsRoot: requireRoot(),
        skillId: state.config.id,
        sourceDir: dir,
        meta: {
          revision,
          name: state.config.name,
          description: state.description,
          savedAt: Date.now(),
          replacedBy: {
            actor: ctx.actor,
            ...(ctx.reason ? { reason: ctx.reason } : {}),
            ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          },
        },
      });
    }
    state.config.revision = revision + 1;
    state.config.updatedAt = Date.now();
    this.takeOwnershipIfUser(state, ctx);
    emitMutation({ skillId: state.config.id, kind: "change", ctx });
  }

  private async swapIntoPlace(
    target: string,
    stageDir: string,
    hasExisting: boolean,
  ): Promise<void> {
    const backupDir = join(requireRoot(), ".staging", `previous-${randomUUID()}`);
    let movedExisting = false;
    try {
      if (hasExisting && (await pathExists(target))) {
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
  }

  private toRecord(state: SkillState): SkillRecord {
    const c = state.config;
    const record: SkillRecord = {
      id: c.id,
      name: c.name,
      enabled: c.enabled,
      description: state.description,
      body: state.body,
      path: skillFilePath(c.name),
      directory: skillDir(c.name),
      files: [...state.files],
      origin: c.origin ?? "user",
      status: c.status ?? "active",
      revision: currentRevision(c),
    };
    if (c.project) record.project = c.project;
    if (c.supersededBy) {
      record.supersededBy = c.supersededBy;
      const successor = this.successorName(c);
      if (successor) record.supersededByName = successor;
    }
    if (c.createdAt !== undefined) record.createdAt = c.createdAt;
    if (c.updatedAt !== undefined) record.updatedAt = c.updatedAt;
    if (c.createdFrom) record.createdFrom = { ...c.createdFrom };
    return record;
  }

  private async hydrateFromDisk(state: SkillState): Promise<void> {
    try {
      const raw = await readFile(skillFilePath(state.config.name), "utf8");
      const parsed = parseSkillMarkdown(raw);
      state.description = parsed.description;
      state.body = parsed.body;
      // Frontmatter wins for scope (hand edits / zip installs / copies), but
      // only when the key is present — otherwise an index-only scope survives.
      if (parsed.project !== undefined) {
        const project = normalizeSkillProject(parsed.project);
        if (project) state.config.project = project;
        else delete state.config.project;
      }
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
      project: state.config.project,
    });
    await writeFile(skillFilePath(state.config.name), markdown, "utf8");
  }
}

export const skillManager = new SkillManager();
