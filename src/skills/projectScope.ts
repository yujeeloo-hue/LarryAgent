
export const SKILL_PROJECT_MAX = 64;

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

export function filterCatalogForProject<T extends { project?: string | undefined }>(
  entries: readonly T[],
  projectKey: string | undefined,
): T[] {
  const key = normalizeSkillProject(projectKey);
  if (!key) return [...entries];
  return entries.filter((entry) => isSkillVisibleInProject(entry.project, key));
}

export function skillProjectLabel(project: string | undefined): string {
  return normalizeSkillProject(project) || "Universal";
}

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
