import { isAbsolute, join, normalize, relative, sep } from "node:path";

/** Max relative path length inside a skill package. */
export const SKILL_RELATIVE_PATH_MAX = 240;

/** Max UTF-8 text size for tool-written supporting files. */
export const SKILL_FILE_CONTENT_MAX = 512_000;

/** Max supporting files written in one create/update/write batch. */
export const SKILL_FILES_BATCH_MAX = 50;

/**
 * Normalize a skill-relative path to POSIX-style (`a/b/c`).
 * Rejects absolute paths, `..`, empty segments, and SKILL.md (managed separately).
 */
export function normalizeSkillRelativePath(
  raw: string,
  options?: { allowSkillMd?: boolean },
): { ok: true; path: string } | { ok: false; message: string } {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, message: "Relative path is required." };
  }
  let p = raw.trim().replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  if (isAbsolute(p) || /^[A-Za-z]:\//.test(p)) {
    return { ok: false, message: "Path must be relative to the skill directory." };
  }
  if (p.includes("\0")) {
    return { ok: false, message: "Path contains invalid characters." };
  }
  const parts = p.split("/").filter((seg) => seg.length > 0);
  if (parts.length === 0) {
    return { ok: false, message: "Path must be relative to the skill directory." };
  }
  if (parts.some((seg) => seg === "." || seg === "..")) {
    return { ok: false, message: 'Path must not contain "." or "..".' };
  }
  const normalized = parts.join("/");
  if (normalized.length > SKILL_RELATIVE_PATH_MAX) {
    return {
      ok: false,
      message: `Path is too long (max ${SKILL_RELATIVE_PATH_MAX} characters).`,
    };
  }
  if (
    !options?.allowSkillMd &&
    normalized.toLowerCase() === "skill.md"
  ) {
    return {
      ok: false,
      message:
        "SKILL.md is managed via create_skill / update_skill. Use those tools instead.",
    };
  }
  return { ok: true, path: normalized };
}

/**
 * Resolve a relative path under a skill directory; throws if it escapes.
 */
export function resolveUnderSkillDir(
  skillDirectory: string,
  relativePath: string,
): string {
  const norm = normalizeSkillRelativePath(relativePath, { allowSkillMd: true });
  if (!norm.ok) {
    throw new Error(norm.message);
  }
  const absolute = normalize(join(skillDirectory, ...norm.path.split("/")));
  const rel = relative(skillDirectory, absolute);
  if (
    rel.startsWith("..") ||
    isAbsolute(rel) ||
    rel.split(sep).includes("..")
  ) {
    throw new Error("Path escapes the skill directory.");
  }
  return absolute;
}
