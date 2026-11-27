
export type SvnStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "replaced"
  | "untracked"
  | "missing"
  | "conflicted"
  | "obscured";

export type SvnStatusEntry = {
  path: string;
  kind: SvnStatusKind;
  /** SVN filed a tree conflict for this path (see TREE_CONFLICT_COLUMN). */
  treeConflict?: boolean;
};

const STATUS_LETTER_TO_KIND: Record<string, SvnStatusKind> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "replaced",
  "?": "untracked",
  "!": "missing",
  C: "conflicted",
  "~": "obscured",
};

const SKIPPED_LETTERS = new Set(["X", "I", " ", ""]);

/**
 * `svn status` puts a tree conflict in the seventh column, so a path SVN cannot
 * merge (`D     C Content/A.lua`) still carries its content letter ("D") in
 * column 1 — reading columns 1-2 alone reports it as deleted, not conflicted.
 */
const TREE_CONFLICT_COLUMN = 6;

export function parseSvnStatus(output: string): SvnStatusEntry[] {
  const entries: SvnStatusEntry[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) continue;
    if (line.startsWith(">")) continue;

    const treeConflict = line[TREE_CONFLICT_COLUMN] === "C";
    const letter = line[0] !== " " ? line[0]! : (line[1] ?? " ");
    if (SKIPPED_LETTERS.has(letter) && !treeConflict) continue;
    const kind = treeConflict || line[1] === "C" ? "conflicted" : STATUS_LETTER_TO_KIND[letter];
    if (!kind) continue;

    const path =
      (line.length > 8 ? line.slice(8) : line.slice(1)).trimStart() || "";
    if (!path) continue;
    entries.push(treeConflict ? { path, kind, treeConflict: true } : { path, kind });
  }
  return entries;
}

export type SvnDiffCounts = {
  insertions: number;
  deletions: number;
  binary: boolean;
  hasContent: boolean;
};

const BINARY_MARKER = "Cannot display: file marked as a binary type.";

export function parseSvnDiffCounts(output: string): Map<string, SvnDiffCounts> {
  const byPath = new Map<string, SvnDiffCounts>();
  let current: { path: string; counts: SvnDiffCounts } | null = null;
  let inPropertySection = false;

  const ensure = (path: string): SvnDiffCounts => {
    let counts = byPath.get(path);
    if (!counts) {
      counts = { insertions: 0, deletions: 0, binary: false, hasContent: false };
      byPath.set(path, counts);
    }
    return counts;
  };

  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");

    if (line.startsWith("Index: ")) {
      const path = line.slice("Index: ".length).trim();
      current = path ? { path, counts: ensure(path) } : null;
      inPropertySection = false;
      continue;
    }

    if (line.startsWith("Property changes on:")) {
      inPropertySection = true;
      continue;
    }

    if (!current) continue;

    if (line.includes(BINARY_MARKER)) {
      current.counts.binary = true;
      continue;
    }

    if (inPropertySection) continue;

    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("@@")) {
      current.counts.hasContent = true;
      continue;
    }
    if (line.startsWith("+")) {
      current.counts.insertions += 1;
      current.counts.hasContent = true;
      continue;
    }
    if (line.startsWith("-")) {
      current.counts.deletions += 1;
      current.counts.hasContent = true;
      continue;
    }
  }

  return byPath;
}

export function parseSvnCommitRevision(output: string): string | null {
  const match = output.match(/Committed revision (\d+)\./);
  return match?.[1] ? `r${match[1]}` : null;
}

export type SvnUpdateSummary = {
  revision: string | null;
  alreadyCurrent: boolean;
  changedCount: number;
  conflictCount: number;
  text: string;
};

const UPDATE_ACTION_LETTERS = new Set(["A", "D", "U", "G", "E", "R", "B"]);

export function parseSvnUpdateSummary(output: string): SvnUpdateSummary {
  const revisionMatch = output.match(/(Updated to|At) revision (\d+)\./);
  const revision = revisionMatch?.[2] ?? null;
  const alreadyCurrent = revisionMatch?.[1] === "At";

  let changedCount = 0;
  let markerConflicts = 0;
  let summaryConflicts = 0;
  let inConflictSummary = false;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) continue;

    if (/^Summary of conflicts:/.test(line)) {
      inConflictSummary = true;
      continue;
    }
    if (inConflictSummary) {
      const count = line.match(/conflicts?:\s*(\d+)/i);
      if (count?.[1]) summaryConflicts += Number(count[1]);
      continue;
    }

    if (/^(Updating|Fetching|External|Restored|Skipped)\b/.test(line)) continue;
    if (/revision \d+\./.test(line)) continue;

    const letter = line[0] ?? "";
    const propLetter = line[1] ?? "";
    if (letter === "C" || propLetter === "C") {
      markerConflicts += 1;
      changedCount += 1;
      continue;
    }
    if (UPDATE_ACTION_LETTERS.has(letter) || UPDATE_ACTION_LETTERS.has(propLetter)) {
      changedCount += 1;
    }
  }

  const conflictCount = summaryConflicts > 0 ? summaryConflicts : markerConflicts;
  const parts: string[] = [];
  if (revision) {
    parts.push(
      alreadyCurrent
        ? `Already at revision ${revision}`
        : `Updated to revision ${revision}`,
    );
  } else {
    parts.push("Update finished");
  }
  if (changedCount > 0) parts.push(`${changedCount} path(s)`);
  if (conflictCount > 0) parts.push(`${conflictCount} conflict(s)`);

  return {
    revision,
    alreadyCurrent,
    changedCount,
    conflictCount,
    text: parts.join(" · "),
  };
}
