import type { SkillConfig } from "../toolsConfig/types.js";

export type { SkillConfig };

/** Runtime record for Tools UI and agent tools. */
export type SkillRecord = {
  id: string;
  name: string;
  enabled: boolean;
  description: string;
  /** Markdown body after frontmatter (no leading --- block). */
  body: string;
  /** Absolute path to SKILL.md. */
  path: string;
  /** Absolute path to the skill package directory. */
  directory: string;
  /** Supporting files relative to {@link directory} (excludes SKILL.md). */
  files: string[];
};

/** Catalog entry for search_skills / Skills UI. */
export type SkillCatalogEntry = {
  name: string;
  description: string;
};

export type SkillFileInput = {
  path: string;
  content: string;
};

export type SkillUpsertInput = {
  /** Omit when creating a new skill. */
  id?: string | undefined;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  /** Optional supporting files to write (create or update). */
  files?: SkillFileInput[] | undefined;
  /** Relative paths to delete (update only). */
  removeFiles?: string[] | undefined;
};

export type SkillInstallOptions = {
  overwrite?: boolean;
  enabled?: boolean;
  /** Only install this skill name from a multi-skill zip. */
  name?: string | undefined;
};

export type SkillInstallResult = {
  installed: SkillRecord[];
  overwritten: string[];
};
