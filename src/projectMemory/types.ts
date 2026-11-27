
export const PROJECT_MEMORY_FILENAME = "PROJECT.md";

export const PROJECT_MEMORY_MAX_CHARS = 3_000;

export const PROJECT_DOCS_DIR = "docs";

export const PROJECT_DOC_MAX_CHARS = 4_000;

export const PROJECT_WORKLOG_MAX_ENTRIES = 100;

export const PROJECT_RECENT_WORKLOG = 3;
export const PROJECT_RECENT_HANDOFF = 3;
export const PROJECT_RECENT_PITFALLS = 10;

export type ProjectMemorySectionId =
  | "basics"
  | "structure"
  | "conventions"
  | "docs_guide"
  | "recent";

export const PROJECT_MEMORY_SECTION_HEADINGS: Record<
  ProjectMemorySectionId,
  string
> = {
  basics: "Basics",
  structure: "Structure",
  conventions: "Conventions",
  docs_guide: "Docs Guide",
  recent: "Recent",
};

export const PROJECT_MEMORY_CONTENT_SECTIONS: ProjectMemorySectionId[] = [
  "basics",
  "structure",
  "conventions",
  "docs_guide",
];

export const LEGACY_PROJECT_SECTION_HEADINGS = [
  "Overview",
  "Work log",
  "Pitfalls",
  "Handoff",
] as const;

export type ProjectDocId = "worklog" | "pitfalls" | "handoff" | "style" | "deploy";

export const PROJECT_DOC_FILENAMES: Record<ProjectDocId, string> = {
  worklog: "WORKLOG.md",
  pitfalls: "PITFALLS.md",
  handoff: "HANDOFF.md",
  style: "STYLE.md",
  deploy: "DEPLOY.md",
};

export const PROJECT_DOC_TITLES: Record<ProjectDocId, string> = {
  worklog: "WORKLOG — Work Log",
  pitfalls: "PITFALLS — Pitfalls Log",
  handoff: "HANDOFF — Handoff Log",
  style: "STYLE — Style Digest",
  deploy: "DEPLOY — Deployment & Release",
};

export const PROJECT_DOC_RULES: Record<ProjectDocId, string> = {
  worklog:
    "Agent appends a summary after each turn; newest first; ~4000 chars soft limit (compress oldest in place when over; never archived elsewhere); 100 entries max.",
  pitfalls:
    "Write only when a pitfall was hit this turn; one per entry (symptom → root cause → fix); ~4000 chars soft limit (compress oldest in place).",
  handoff:
    "Write when there is unfinished / follow-up / to-explore work at turn end; newest first; delete completed entries.",
  style:
    "Distill code style, tech choices, UI interaction and visual style; append by section; merge similar items when overlong.",
  deploy:
    "Credential red line: record WHERE credentials live (ssh alias, key path, keychain entry) — never plaintext passwords. Addresses / directories / flows are fine.",
};

export type ProjectMemorySnapshot = {
  workspacePath: string;
  body: string;
  updatedAt: number;
  empty: boolean;
  filePath: string;
};

export function normalizeProjectMemorySection(
  raw: unknown,
): ProjectMemorySectionId | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (key === "recent") return null;
  if (
    key === "basics" ||
    key === "structure" ||
    key === "conventions" ||
    key === "docs_guide"
  ) {
    return key;
  }
  return null;
}

