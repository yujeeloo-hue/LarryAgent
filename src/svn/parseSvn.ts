/**
 * Pure parsers for `svn status` / `svn diff` / `svn commit` output.
 * No subprocess involvement — fully unit-testable with fixtures.
 */

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
  /** WC-root-relative posix path as printed by `svn status`. */
  path: string;
  kind: SvnStatusKind;
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

/** Letters never surfaced in the Changes UI (externals / ignored / elsewhere). */
const SKIPPED_LETTERS = new Set(["X", "I", " ", ""]);

/**
 * Parse `svn status` output. Takes the strongest signal from the first two
 * status columns (col 1 = item/props, col 2 = props/tree). Skips move
 * annotation lines (`>  moved ...`), externals (X) and ignored (I) entries.
 */
export function parseSvnStatus(output: string): SvnStatusEntry[] {
  const entries: SvnStatusEntry[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) continue;
    // ">        moved to/from ..." annotations belong to the previous entry.
    if (line.startsWith(">")) continue;

    const letter = line[0] !== " " ? line[0]! : (line[1] ?? " ");
    if (SKIPPED_LETTERS.has(letter)) continue;
    const kind = STATUS_LETTER_TO_KIND[letter];
    if (!kind) continue;

    // Plain `svn status` pads an 8-column status field before the path
    // (covers " M", "MM", "A  +" shapes); trimStart is safe because svn
    // pads with spaces (leading-space filenames are not supported).
    const path =
      (line.length > 8 ? line.slice(8) : line.slice(1)).trimStart() || "";
    if (!path) continue;
    entries.push({ path, kind });
  }
  return entries;
}

export type SvnDiffCounts = {
  insertions: number;
  deletions: number;
  binary: boolean;
  /** True when at least one content hunk was seen (props-only diffs stay false). */
  hasContent: boolean;
};

const BINARY_MARKER = "Cannot display: file marked as a binary type.";

/**
 * Aggregate per-path +/- line counts from `svn diff` unified output.
 *
 * Handles the svn-specific quirks that git never has:
 * - `Index: <path>` headers open a file section;
 * - `Property changes on: <path>` sections (svn:eol-style etc.) emit fake
 *   `## -1 +1 ##` hunks with `+`/`-` lines — skipped via a property-mode flag
 *   that lasts until the next `Index:` header;
 * - binary files print a marker line instead of hunks.
 */
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

/** Extract `r123` from `svn commit` output ("Committed revision 123."). */
export function parseSvnCommitRevision(output: string): string | null {
  const match = output.match(/Committed revision (\d+)\./);
  return match?.[1] ? `r${match[1]}` : null;
}

export type SvnUpdateSummary = {
  /** Revision the working copy sits at afterwards ("12345"), when reported. */
  revision: string | null;
  /** True for "At revision N." — nothing came down from the server. */
  alreadyCurrent: boolean;
  /** Paths svn touched (added / updated / deleted / merged / restored). */
  changedCount: number;
  conflictCount: number;
  /** One-line result for the UI. */
  text: string;
};

/** Action letters `svn update` prints in the first column, minus conflicts. */
const UPDATE_ACTION_LETTERS = new Set(["A", "D", "U", "G", "E", "R", "B"]);

/**
 * Summarize `svn update` output for the Dev Mode result popover.
 *
 * Conflicts are read from the trailing "Summary of conflicts:" block when svn
 * prints one (it counts tree conflicts the per-line `C` markers miss) and fall
 * back to counting `C` markers in the action columns.
 */
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

    // "Updating '.':" / "Fetching external item into…" are not per-path lines.
    if (/^(Updating|Fetching|External|Restored|Skipped)\b/.test(line)) continue;
    if (/revision \d+\./.test(line)) continue;

    const letter = line[0] ?? "";
    // Column 2 carries property-only actions; column 1 wins when both are set.
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
