import type {
  SkillConfig,
  SkillOrigin,
  SkillStatus,
} from "../toolsConfig/types.js";

export type { SkillConfig, SkillOrigin, SkillStatus };

export type SkillActor = SkillOrigin;

export type SkillWritePolicy = "direct" | "auto_owned_only";

export const AUTO_EDITABLE_ORIGINS: readonly SkillOrigin[] = ["reflector", "coco"];

export type SkillMutationContext = {
  actor: SkillActor;
  reason?: string | undefined;
  sessionId?: string | undefined;
  userMessageId?: string | undefined;
};

export type SkillRecord = {
  id: string;
  name: string;
  enabled: boolean;
  description: string;
  body: string;
  path: string;
  directory: string;
  files: string[];
  origin: SkillOrigin;
  status: SkillStatus;
  project?: string;
  supersededBy?: string;
  supersededByName?: string;
  createdAt?: number;
  updatedAt?: number;
  createdFrom?: { sessionId: string; userMessageId?: string };
  revision: number;
};

export type SkillCatalogEntry = {
  name: string;
  description: string;
  project?: string;
  enabled?: boolean;
  status?: SkillStatus;
  supersededByName?: string;
};

export type SkillFileInput = {
  path: string;
  content: string;
};

export type SkillUpsertInput = {
  id?: string | undefined;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  project?: string | undefined;
  files?: SkillFileInput[] | undefined;
  removeFiles?: string[] | undefined;
};

export type SkillInstallOptions = {
  overwrite?: boolean;
  enabled?: boolean;
  name?: string | undefined;
};

export type SkillInstallResult = {
  installed: SkillRecord[];
  overwritten: string[];
};

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

export type SkillRevisionEntry = SkillRevisionMeta & { current: boolean };

export type SkillRevisionContent = {
  revision: number;
  name: string;
  description: string;
  body: string;
  skillMd: string;
  files: string[];
};
