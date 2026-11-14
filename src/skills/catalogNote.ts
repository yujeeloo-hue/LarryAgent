import type { SkillCatalogEntry } from "./types.js";

export const SKILL_CATALOG_HEADER =
  "[Installed skills — enabled when this turn started, scoped to this project (universal + this project's own). If one fits the task, read_skill({ name }) and follow it before improvising; search_skills finds more by keyword]";

const MAX_LISTED = 40;
const DESC_MAX = 140;
const MAX_CHARS = 3_000;

function clip(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= DESC_MAX ? one : `${one.slice(0, DESC_MAX - 1)}…`;
}

/**
 * Turn-start skill catalog for the trailing wire-only note: one line per
 * enabled skill (name + clipped description, project-scoped ones tagged),
 * capped so large libraries stay cheap. Callers filter by project first
 * (`filterCatalogForProject`). Returns null when no skill is enabled.
 */
export function buildSkillCatalogNote(
  entries: readonly SkillCatalogEntry[],
): string | null {
  if (entries.length === 0) return null;
  const lines: string[] = [SKILL_CATALOG_HEADER];
  let size = SKILL_CATALOG_HEADER.length;
  let listed = 0;
  for (const entry of entries) {
    if (listed >= MAX_LISTED) break;
    const tag = entry.project ? ` [${entry.project}]` : "";
    const line = `- ${entry.name}${tag}: ${clip(entry.description)}`;
    if (size + line.length + 1 > MAX_CHARS) break;
    lines.push(line);
    size += line.length + 1;
    listed += 1;
  }
  const rest = entries.length - listed;
  if (rest > 0) {
    lines.push(`- … ${rest} more — use search_skills to find them.`);
  }
  return lines.join("\n");
}
