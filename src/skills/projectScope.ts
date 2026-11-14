/**
 * Skill project scope.
 *
 * A skill's `project` is the owning workspace folder slug (e.g. `jellybot`);
 * a missing / empty value means "universal" — visible in every project.
 * The scope is deliberately a folder slug, not an absolute path: the same
 * skill library travels between machines (Mac app, relay hosts) whose paths
 * differ, while `…/JellyBot` stays `jellybot` everywhere.
 */

/** Stored project slug max length (folder names are the source). */
export const SKILL_PROJECT_MAX = 64;

/**
 * Normalize a stored project value. `""`, `"*"`, `"all"`, `"universal"` and
 * anything unusable normalize to `""` (= universal), so the universal case has
 * exactly one representation.
 */
export function normalizeSkillProject(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const one = raw.trim().toLowerCase();
  if (!one || one === "*" || one === "all" || one === "universal") return "";
  const slug = one
    .replace(/[\s/\\]+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "");
  return slug.slice(0, SKILL_PROJECT_MAX);
}

/**
 * Project key for a session workspace root: last path segment, normalized.
 * Empty / unparsable paths yield `""` (no project → no filtering).
 */
export function skillProjectKey(workspacePath: unknown): string {
  if (typeof workspacePath !== "string") return "";
  const parts = workspacePath
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== "." && part !== "~");
  if (parts.length === 0) return "";
  const last = parts[parts.length - 1] ?? "";
  if (last === "..") return "";
  return normalizeSkillProject(last);
}

/**
 * Is a skill visible inside `projectKey`? Universal skills always are; a
 * project-scoped skill only inside its own project. An empty `projectKey`
 * (host without a workspace) shows everything, matching pre-scope behavior.
 */
export function isSkillVisibleInProject(
  skillProject: string | undefined,
  projectKey: string | undefined,
): boolean {
  const key = normalizeSkillProject(projectKey);
  if (!key) return true;
  const owner = normalizeSkillProject(skillProject);
  if (!owner) return true;
  return owner === key;
}

/** Drop skills owned by other projects. Same rule as {@link isSkillVisibleInProject}. */
export function filterCatalogForProject<T extends { project?: string | undefined }>(
  entries: readonly T[],
  projectKey: string | undefined,
): T[] {
  const key = normalizeSkillProject(projectKey);
  if (!key) return [...entries];
  return entries.filter((entry) => isSkillVisibleInProject(entry.project, key));
}

/** Display label: `Universal` for unscoped skills, otherwise the slug. */
export function skillProjectLabel(project: string | undefined): string {
  return normalizeSkillProject(project) || "Universal";
}

/** Project slugs referenced by a catalog (for pickers), sorted, universal excluded. */
export function listCatalogProjects(
  entries: readonly { project?: string | undefined }[],
): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    const slug = normalizeSkillProject(entry.project);
    if (slug) seen.add(slug);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}
