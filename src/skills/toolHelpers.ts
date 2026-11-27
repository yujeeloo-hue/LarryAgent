import { skillManager } from "./manager.js";
import type { SkillRecord } from "./types.js";
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_NAME_MAX,
} from "./parseSkillMd.js";

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSkillName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= SKILL_NAME_MAX &&
    SKILL_NAME_RE.test(trimmed)
  );
}

export function normalizeSkillName(raw: string): string {
  return raw.trim().toLowerCase();
}

export function clampSkillDescription(raw: string): string {
  return raw.trim().slice(0, SKILL_DESCRIPTION_MAX);
}

export type ResolveSkillResult =
  | { ok: true; record: SkillRecord }
  | {
      ok: false;
      message: string;
      returnCodeHint: "not_found" | "invalid";
    };

export function resolveSkillRef(idOrName: string): ResolveSkillResult {
  const key = idOrName.trim();
  if (!key) {
    return {
      ok: false,
      message: "Skill id or name is required.",
      returnCodeHint: "invalid",
    };
  }
  const { record, ambiguous } = skillManager.findSkill(key);
  if (ambiguous) {
    return {
      ok: false,
      message: `Ambiguous skill name "${key}". Use the skill id instead.`,
      returnCodeHint: "invalid",
    };
  }
  if (!record) {
    return {
      ok: false,
      message: `Skill not found: ${key}`,
      returnCodeHint: "not_found",
    };
  }
  return { ok: true, record };
}

export function formatSkillSummary(record: SkillRecord): string {
  const enabled = record.enabled ? "enabled" : "disabled";
  const desc =
    record.description.trim() || "(no description)";
  const fileCount = record.files.length;
  const filesLine =
    fileCount === 0
      ? "Supporting files: none"
      : `Supporting files (${fileCount}): ${record.files.slice(0, 20).join(", ")}${fileCount > 20 ? ", …" : ""}`;
  return `Skill "${record.name}" (${record.id}) — ${enabled}\nDirectory: ${record.directory}\nDescription: ${desc}\n${filesLine}`;
}

