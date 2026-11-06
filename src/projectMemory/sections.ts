import {
  PROJECT_MEMORY_CONTENT_SECTIONS,
  PROJECT_MEMORY_SECTION_HEADINGS,
  PROJECT_RECENT_HANDOFF,
  PROJECT_RECENT_PITFALLS,
  PROJECT_RECENT_WORKLOG,
  LEGACY_PROJECT_SECTION_HEADINGS,
  type ProjectMemorySectionId,
} from "./types.js";

const SECTION_ORDER: ProjectMemorySectionId[] = [
  ...PROJECT_MEMORY_CONTENT_SECTIONS,
  "recent",
];

function headingLine(id: ProjectMemorySectionId): string {
  return `## ${PROJECT_MEMORY_SECTION_HEADINGS[id]}`;
}

/**
 * Parse a PROJECT.md body into titled sections (best-effort).
 * Content before the first known `##` heading is kept as `preamble`.
 */
export function parseProjectSections(body: string): {
  preamble: string;
  sections: Record<ProjectMemorySectionId, string>;
} {
  const sections: Record<ProjectMemorySectionId, string> = {
    basics: "",
    structure: "",
    conventions: "",
    docs_guide: "",
    recent: "",
  };
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let preambleLines: string[] = [];
  let current: ProjectMemorySectionId | null = null;
  const buffers: Record<ProjectMemorySectionId, string[]> = {
    basics: [],
    structure: [],
    conventions: [],
    docs_guide: [],
    recent: [],
  };

  const headingToId = new Map<string, ProjectMemorySectionId>();
  for (const id of SECTION_ORDER) {
    headingToId.set(headingLine(id).toLowerCase(), id);
  }

  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      const id = headingToId.get(`## ${match[1]!.trim()}`.toLowerCase());
      if (id) {
        current = id;
        continue;
      }
    }
    if (current) {
      buffers[current].push(line);
    } else {
      preambleLines.push(line);
    }
  }

  for (const id of SECTION_ORDER) {
    sections[id] = buffers[id].join("\n").replace(/^\n+|\n+$/g, "");
  }
  return {
    preamble: preambleLines.join("\n").replace(/^\n+|\n+$/g, ""),
    sections,
  };
}

/** Rebuild a canonical PROJECT.md from preamble + sections. */
export function formatProjectBody(input: {
  preamble?: string;
  sections: Partial<Record<ProjectMemorySectionId, string>>;
}): string {
  const parts: string[] = [];
  const preamble = (input.preamble ?? "").trim();
  if (preamble) {
    parts.push(preamble);
  } else {
    parts.push("# Project");
  }
  for (const id of SECTION_ORDER) {
    const content = (input.sections[id] ?? "").trim();
    parts.push(`${headingLine(id)}\n\n${content || "_Empty._"}`);
  }
  return `${parts.join("\n\n").trim()}\n`;
}

/**
 * Canonical Docs Guide boilerplate (static — same block the default template
 * and the workspace scaffolds emit). The guide is derivable, so writes that
 * leave it empty get it restored (same philosophy as the Recent mirror).
 */
export function canonicalDocsGuideSection(): string {
  return [
    "docs/ memory files (tracked in git; read_file them for details):",
    "- docs/WORKLOG.md — work log (newest first, ~4000 chars soft limit, 100 entries max)",
    "- docs/PITFALLS.md — pitfalls log (~4000 chars soft limit)",
    "- docs/HANDOFF.md — handoff log (unfinished / next-step items)",
    "- docs/STYLE.md — style digest (code / tech choices / interaction / visual)",
    "- docs/DEPLOY.md — deployment & release (flows / addresses / dirs; credentials as locations only)",
  ].join("\n");
}

/**
 * Guard: restore the canonical Docs Guide when a composed body left it
 * empty/placeholder. Customized guides pass through untouched.
 */
export function restoreDocsGuideSection(body: string): string {
  const parsed = parseProjectSections(body);
  const guide = parsed.sections.docs_guide.trim();
  if (guide && guide !== "_Empty._") return body;
  parsed.sections.docs_guide = canonicalDocsGuideSection();
  return formatProjectBody(parsed);
}

/**
 * Apply a section update.
 * - replace: overwrite that section body
 * - merge: append content within the section
 */
export function applySectionUpdate(
  body: string,
  section: ProjectMemorySectionId,
  content: string,
  mode: "merge" | "replace",
): string {
  const parsed = parseProjectSections(body);
  const trimmed = content.trim();
  const existing = parsed.sections[section].trim();
  if (mode === "replace" || !existing) {
    parsed.sections[section] = trimmed;
  } else {
    parsed.sections[section] = `${existing}\n\n${trimmed}`;
  }
  return formatProjectBody(parsed);
}

/** True when the body still uses the legacy four-section English headings. */
export function isLegacyProjectBody(body: string): boolean {
  return LEGACY_PROJECT_SECTION_HEADINGS.some((heading) =>
    new RegExp(`^##\\s+${heading}\\s*$`, "m").test(body),
  );
}

/** Bullet entries (`- …` lines) of a docs log body, top to bottom. */
export function extractDocEntries(body: string, max?: number): string[] {
  const entries: string[] = [];
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const match = line.match(/^[-*]\s+(.+?)\s*$/);
    if (match?.[1]) {
      entries.push(`- ${match[1]}`);
      if (max && entries.length >= max) break;
    }
  }
  return entries;
}

/**
 * Synthesize the "Recent" section from the heads of the docs log files.
 * Pure function: callers pass the raw docs bodies; the mirror counts are
 * fixed (3 worklog / 3 handoff / 10 pitfalls).
 */
export function synthesizeRecentSection(input: {
  worklogBody: string;
  handoffBody: string;
  pitfallsBody: string;
}): string {
  const worklog = extractDocEntries(input.worklogBody, PROJECT_RECENT_WORKLOG);
  const handoff = extractDocEntries(input.handoffBody, PROJECT_RECENT_HANDOFF);
  const pitfalls = extractDocEntries(input.pitfallsBody, PROJECT_RECENT_PITFALLS);

  const renderList = (entries: string[]): string =>
    entries.length > 0 ? entries.join("\n") : "- (none)";

  return [
    "(Auto-synthesized mirror of the docs log heads — do not hand-edit. Each list below is only the head; for the COMPLETE record read_file the corresponding docs/ file. Style and deployment details live in docs/STYLE.md and docs/DEPLOY.md.)",
    "",
    `Worklog (latest ${PROJECT_RECENT_WORKLOG} · complete log: docs/WORKLOG.md):`,
    renderList(worklog),
    "",
    `Handoff (latest ${PROJECT_RECENT_HANDOFF} · complete log: docs/HANDOFF.md):`,
    renderList(handoff),
    "",
    `Pitfalls (latest ${PROJECT_RECENT_PITFALLS} · complete log: docs/PITFALLS.md):`,
    renderList(pitfalls),
  ].join("\n");
}
