import type { SkillFileInput } from "../../skills/types.js";
import { SKILL_FILES_BATCH_MAX } from "../../skills/paths.js";

/** Parse optional `files` array from tool args. */
export function parseSkillFilesArg(
  raw: unknown,
): { ok: true; files: SkillFileInput[] } | { ok: false; message: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, files: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, message: '"files" must be an array of { path, content }.' };
  }
  if (raw.length > SKILL_FILES_BATCH_MAX) {
    return {
      ok: false,
      message: `"files" supports at most ${SKILL_FILES_BATCH_MAX} entries.`,
    };
  }
  const files: SkillFileInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return {
        ok: false,
        message: 'Each "files" entry must be an object with path and content.',
      };
    }
    const path =
      typeof (item as { path?: unknown }).path === "string"
        ? (item as { path: string }).path
        : "";
    const content =
      typeof (item as { content?: unknown }).content === "string"
        ? (item as { content: string }).content
        : null;
    if (!path.trim() || content === null) {
      return {
        ok: false,
        message:
          'Each "files" entry needs string "path" and string "content".',
      };
    }
    files.push({ path, content });
  }
  return { ok: true, files };
}

export function parseRemoveFilesArg(
  raw: unknown,
): { ok: true; paths: string[] } | { ok: false; message: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, paths: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, message: '"remove_files" must be an array of strings.' };
  }
  const paths: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      return {
        ok: false,
        message: 'Each "remove_files" entry must be a non-empty string.',
      };
    }
    paths.push(item.trim());
  }
  return { ok: true, paths };
}
