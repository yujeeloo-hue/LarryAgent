/**
 * Line parser for `svn update` progress output.
 *
 * SVN prints one action line per touched path: a content letter in column 1
 * (or a blank when only a property changed, with the property letter in
 * column 2) followed by spaces and the path:
 *
 *   U    Content/UI/T_Hero.uasset
 *    U   Config/DefaultGame.ini
 *   C    Content/Maps/NF_Hub.umap
 *
 * Everything else (headers, revision line, the "Summary of conflicts" block
 * with its two-space indented entries) is noise for the file list.
 */

export type SvnUpdateActionLetter =
  | "A"
  | "D"
  | "U"
  | "G"
  | "C"
  | "E"
  | "R"
  | "B";

export type SvnUpdateLogEntry = {
  /** Content letter when present, otherwise the property letter. */
  letter: SvnUpdateActionLetter;
  /** Path relative to the working copy root, as SVN printed it. */
  path: string;
  /** Property-only change (the content column was blank). */
  propertyOnly: boolean;
};

const ACTION_LETTERS = new Set<string>(["A", "D", "U", "G", "C", "E", "R", "B"]);

const NOISE_PREFIX =
  /^(Updating\b|Fetching\b|External\b|Restored\b|Skipped\b|Summary of conflicts|Select\b|svn\b|At revision|Updated to revision|Checked out|Checkout of|Exported|Performing status|Lock|Unlock)/;

export function parseSvnUpdateLogLine(raw: string): SvnUpdateLogEntry | null {
  const line = raw.replace(/\r$/, "");
  if (!line.trim()) return null;
  if (NOISE_PREFIX.test(line)) return null;

  const contentLetter = line[0] ?? "";
  const propertyLetter = line[1] ?? " ";
  const hasContent = ACTION_LETTERS.has(contentLetter);
  const hasProperty = ACTION_LETTERS.has(propertyLetter);
  // Continuation lines of a header ("  Text conflicts: 1") land here with two
  // blanks and fall through; a property-only change keeps its letter in column 2.
  if (!hasContent && !hasProperty) return null;

  // Column 3 onward is the path; SVN pads the letters with spaces.
  const path = line.slice(2).trimStart().trimEnd();
  if (!path) return null;

  const letter = (hasContent ? contentLetter : propertyLetter) as SvnUpdateActionLetter;
  return {
    letter,
    path: path.replace(/\\/g, "/"),
    propertyOnly: !hasContent,
  };
}

export function parseSvnUpdateRevisionLine(
  raw: string,
): { revision: string; alreadyCurrent: boolean } | null {
  const match = raw.replace(/\r$/, "").match(/^(Updated to|At) revision (\d+)\./);
  if (!match?.[2]) return null;
  return { revision: match[2], alreadyCurrent: match[1] === "At" };
}

/** Letters whose path was actually received (used for the "N paths · X MB" counter). */
export function isSvnUpdateReceivedLetter(letter: SvnUpdateActionLetter): boolean {
  return letter === "A" || letter === "U" || letter === "G" || letter === "R" || letter === "B";
}
