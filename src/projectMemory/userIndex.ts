import {
  loadUserMemory,
  setUserMemoryProfile,
} from "../memory/store.js";
import type { Workspace } from "../workspace/types.js";

const PROJECTS_HEADING = "## Projects";

/**
 * Deterministically sync the USER.md "## Projects" index from workspace rows.
 * Preserves all other profile content. Creates the section when missing.
 */
export async function syncUserMemoryProjectsIndex(
  workspaces: Workspace[],
): Promise<void> {
  const current = await loadUserMemory();
  const next = upsertProjectsSection(current.profile, workspaces);
  if (next.trim() === current.profile.trim()) return;
  await setUserMemoryProfile(next);
}

export function upsertProjectsSection(
  profile: string,
  workspaces: Workspace[],
): string {
  const indexBody = formatProjectsIndex(workspaces);
  const text = profile.replace(/\r\n/g, "\n");
  const headingRe = /^##\s+Projects\s*$/im;
  const match = headingRe.exec(text);

  if (!match) {
    const base = text.trim();
    if (!base) {
      return `# User\n\n${PROJECTS_HEADING}\n\n${indexBody}\n`;
    }
    return `${base}\n\n${PROJECTS_HEADING}\n\n${indexBody}\n`;
  }

  const start = match.index;
  const afterHeading = start + match[0].length;
  const rest = text.slice(afterHeading);
  const nextHeading = rest.search(/\n##\s+/);
  const before = text.slice(0, start).trimEnd();
  const after =
    nextHeading >= 0 ? rest.slice(nextHeading).replace(/^\n+/, "") : "";
  const middle = `${PROJECTS_HEADING}\n\n${indexBody}`;
  if (before && after) return `${before}\n\n${middle}\n\n${after}`.trimEnd() + "\n";
  if (before) return `${before}\n\n${middle}\n`;
  if (after) return `${middle}\n\n${after}`.trimEnd() + "\n";
  return `${middle}\n`;
}

function formatProjectsIndex(workspaces: Workspace[]): string {
  const sorted = [...workspaces].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  return sorted
    .map((w) => `- ${w.name.trim() || "Untitled"} — ${w.path.trim()}`)
    .join("\n");
}
