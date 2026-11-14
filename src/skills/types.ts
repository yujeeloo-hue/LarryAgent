import type {
  SkillConfig,
  SkillOrigin,
  SkillStatus,
} from "../toolsConfig/types.js";

export type { SkillConfig, SkillOrigin, SkillStatus };

/** Who performs a mutation. "user" = Skills UI / explicit user request. */
export type SkillActor = SkillOrigin;

/**
 * How agent skill writes land. `direct` applies them; `auto_owned_only`
 * applies them only to reflector / CoCo-owned skills and turns every other
 * edit into a pending proposal for the user.
 */
export type SkillWritePolicy = "direct" | "auto_owned_only";

/** Origins an automatic writer may edit without asking. */
export const AUTO_EDITABLE_ORIGINS: readonly SkillOrigin[] = ["reflector", "coco"];

export type SkillMutationContext = {
  actor: SkillActor;
  reason?: string | undefined;
  sessionId?: string | undefined;
  userMessageId?: string | undefined;
};

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
  origin: SkillOrigin;
  status: SkillStatus;
  /** Owning project slug; absent → universal (listed in every project). */
  project?: string;
  supersededBy?: string;
  /** Name of the {@link supersededBy} skill when it still exists. */
  supersededByName?: string;
  createdAt?: number;
  updatedAt?: number;
  createdFrom?: { sessionId: string; userMessageId?: string };
  revision: number;
};

/** Catalog entry for search_skills / Skills UI. */
export type SkillCatalogEntry = {
  name: string;
  description: string;
  /** Owning project slug; absent → universal. */
  project?: string;
  /** Present (false) only for disabled skills. */
  enabled?: boolean;
  status?: SkillStatus;
  supersededByName?: string;
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
  /**
   * Owning project slug. `undefined` keeps the current value on update and
   * means universal on create; `""` / `"*"` clears it back to universal.
   */
  project?: string | undefined;
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

/** One stored snapshot: the content of `revision` before it was replaced. */
export type SkillRevisionMeta = {
  revision: number;
  name: string;
  description: string;
  savedAt: number;
  replacedBy: {
    actor: SkillActor;
    reason?: string;
    sessionId?: string;
  };
};

/** History list row; the live version is `current: true` (no snapshot). */
export type SkillRevisionEntry = SkillRevisionMeta & { current: boolean };

export type SkillRevisionContent = {
  revision: number;
  name: string;
  description: string;
  body: string;
  /** SKILL.md text as stored. */
  skillMd: string;
  files: string[];
};
