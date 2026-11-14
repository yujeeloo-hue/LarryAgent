/**
 * V4A patch format (Codex / Cline / Hermes apply_patch dialect).
 *
 *   *** Begin Patch
 *   *** Update File: path/to/file
 *   @@ optional context hint @@
 *    context line
 *   -removed line
 *   +added line
 *   *** Add File: path/to/new
 *   +new file content
 *   *** Delete File: path/to/old
 *   *** Move File: old/path -> new/path
 *   *** End Patch
 *
 * Begin/End markers are optional. Unprefixed hunk lines are treated as
 * context (models often omit the leading space). Application is
 * validate-then-apply: any hunk miss fails the whole patch with no writes.
 */

import {
  formatNoMatchHint,
  fuzzyFindAndReplace,
  isAlreadyApplied,
} from "./fuzzyMatch.js";

export type V4aOpKind = "add" | "update" | "delete" | "move";

export type V4aHunkLine = {
  prefix: " " | "-" | "+";
  content: string;
};

export type V4aHunk = {
  contextHint: string | null;
  lines: V4aHunkLine[];
};

export type V4aOperation = {
  kind: V4aOpKind;
  filePath: string;
  newPath?: string;
  hunks: V4aHunk[];
};

export type V4aFileChange = {
  path: string;
  action: "update" | "add" | "delete" | "move";
  /** Destination for move. */
  destPath?: string;
  before: string | null;
  after: string | null;
};

export type V4aApplyResult =
  | { ok: true; files: V4aFileChange[] }
  | { ok: false; error: string };

const BEGIN_RE = /^\*\*\*\s*Begin\s+Patch\s*$/;
const END_RE = /^\*\*\*\s*End\s+Patch\s*$/;
const UPDATE_RE = /^\*\*\*\s*Update\s+File:\s*(.+)$/;
const ADD_RE = /^\*\*\*\s*Add\s+File:\s*(.+)$/;
const DELETE_RE = /^\*\*\*\s*Delete\s+File:\s*(.+)$/;
const MOVE_RE = /^\*\*\*\s*Move\s+File:\s*(.+?)\s*->\s*(.+)$/;

export function parseV4aPatch(
  patchContent: string,
): { operations: V4aOperation[]; error: string | null } {
  const lines = patchContent.split("\n").map((ln) => (ln.endsWith("\r") ? ln.slice(0, -1) : ln));
  let startIdx = -1;
  let endIdx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (BEGIN_RE.test(line)) startIdx = i;
    else if (END_RE.test(line)) {
      endIdx = i;
      break;
    }
  }

  const operations: V4aOperation[] = [];
  let current: V4aOperation | null = null;
  let currentHunk: V4aHunk | null = null;

  const flushHunk = () => {
    if (current && currentHunk && currentHunk.lines.length > 0) {
      current.hunks.push(currentHunk);
    }
    currentHunk = null;
  };
  const flushOp = () => {
    flushHunk();
    if (current) operations.push(current);
    current = null;
  };

  for (let i = startIdx + 1; i < endIdx; i++) {
    const line = lines[i] ?? "";
    const update = UPDATE_RE.exec(line);
    const add = ADD_RE.exec(line);
    const del = DELETE_RE.exec(line);
    const move = MOVE_RE.exec(line);

    if (update) {
      flushOp();
      current = { kind: "update", filePath: update[1]?.trim() ?? "", hunks: [] };
      continue;
    }
    if (add) {
      flushOp();
      current = { kind: "add", filePath: add[1]?.trim() ?? "", hunks: [] };
      currentHunk = { contextHint: null, lines: [] };
      continue;
    }
    if (del) {
      flushOp();
      operations.push({ kind: "delete", filePath: del[1]?.trim() ?? "", hunks: [] });
      current = null;
      continue;
    }
    if (move) {
      flushOp();
      operations.push({
        kind: "move",
        filePath: move[1]?.trim() ?? "",
        newPath: move[2]?.trim() ?? "",
        hunks: [],
      });
      current = null;
      continue;
    }

    if (line.startsWith("@@")) {
      if (!current) continue;
      flushHunk();
      const hintMatch = /^@@\s*(.+?)\s*@@/.exec(line);
      currentHunk = { contextHint: hintMatch?.[1] ?? null, lines: [] };
      continue;
    }

    if (!current || !line) continue;
    if (!currentHunk) currentHunk = { contextHint: null, lines: [] };
    if (line.startsWith("+")) {
      currentHunk.lines.push({ prefix: "+", content: line.slice(1) });
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ prefix: "-", content: line.slice(1) });
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ prefix: " ", content: line.slice(1) });
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file"
    } else {
      currentHunk.lines.push({ prefix: " ", content: line });
    }
  }
  flushOp();

  if (operations.length === 0) {
    return { operations: [], error: null };
  }
  const parseErrors: string[] = [];
  for (const op of operations) {
    if (!op.filePath) parseErrors.push("Operation with empty file path");
    if (op.kind === "update" && op.hunks.length === 0) {
      parseErrors.push(`UPDATE ${JSON.stringify(op.filePath)}: no hunks found`);
    }
    if (op.kind === "move" && !op.newPath) {
      parseErrors.push(`MOVE ${JSON.stringify(op.filePath)}: missing destination path`);
    }
  }
  if (parseErrors.length > 0) {
    return { operations: [], error: `Parse error: ${parseErrors.join("; ")}` };
  }
  return { operations, error: null };
}

/** Header paths from a V4A body (for risk / streaming reservation). */
export function extractV4aPaths(patchContent: string): string[] {
  const { operations } = parseV4aPatch(patchContent);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const op of operations) {
    for (const p of [op.filePath, op.newPath]) {
      if (!p || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

function countOccurrences(text: string, pattern: string): number {
  if (!pattern) return 0;
  let count = 0;
  let start = 0;
  while (start <= text.length) {
    const pos = text.indexOf(pattern, start);
    if (pos < 0) break;
    count += 1;
    start = pos + 1;
  }
  return count;
}

function hunkSearchReplace(hunk: V4aHunk): {
  search: string;
  replacement: string;
  searchLines: string[];
  replaceLines: string[];
} {
  const searchLines: string[] = [];
  const replaceLines: string[] = [];
  for (const line of hunk.lines) {
    if (line.prefix === " ") {
      searchLines.push(line.content);
      replaceLines.push(line.content);
    } else if (line.prefix === "-") {
      searchLines.push(line.content);
    } else {
      replaceLines.push(line.content);
    }
  }
  return {
    search: searchLines.join("\n"),
    replacement: replaceLines.join("\n"),
    searchLines,
    replaceLines,
  };
}

type Overlay = Map<string, string | null>;

/**
 * Apply parsed V4A operations against a reader. Pure: no filesystem.
 * `read` returns file text or null when missing. Final overlay is returned
 * as per-path before/after snapshots for the tool layer to write.
 */
export function applyV4aOperations(
  operations: V4aOperation[],
  read: (path: string) => string | null,
): V4aApplyResult {
  const overlay: Overlay = new Map();
  const removed = new Set<string>();
  const load = (path: string): { content: string | null; missing: boolean } => {
    if (removed.has(path) && !overlay.has(path)) {
      return { content: null, missing: true };
    }
    if (overlay.has(path)) {
      const v = overlay.get(path) ?? null;
      return { content: v, missing: v === null };
    }
    const disk = read(path);
    overlay.set(path, disk);
    return { content: disk, missing: disk === null };
  };

  const errors: string[] = [];
  let realChangeCount = 0;

  for (const op of operations) {
    if (op.kind !== "update") realChangeCount += 1;

    if (op.kind === "update") {
      const loaded = load(op.filePath);
      if (loaded.missing || loaded.content === null) {
        errors.push(`${op.filePath}: file not found`);
        continue;
      }
      let simulated = loaded.content;
      for (let hi = 0; hi < op.hunks.length; hi++) {
        const hunk = op.hunks[hi];
        if (!hunk) continue;
        const { search, replacement, searchLines, replaceLines } = hunkSearchReplace(hunk);
        const removedLines = hunk.lines.filter((l) => l.prefix === "-");
        const addedLines = hunk.lines.filter((l) => l.prefix === "+");
        if (removedLines.length === 0 && addedLines.length === 0) continue;
        realChangeCount += 1;

        if (searchLines.length === 0) {
          const hint = hunk.contextHint;
          const insertText = replaceLines.join("\n");
          if (hint) {
            const n = countOccurrences(simulated, hint);
            if (n === 0) {
              errors.push(
                `${op.filePath}: addition-only hunk context hint '${hint}' not found`,
              );
            } else if (n > 1) {
              errors.push(
                `${op.filePath}: addition-only hunk context hint '${hint}' is ambiguous (${n} occurrences)`,
              );
            } else {
              const hintPos = simulated.indexOf(hint);
              const eol = simulated.indexOf("\n", hintPos);
              if (eol !== -1) {
                simulated =
                  simulated.slice(0, eol + 1) + insertText + "\n" + simulated.slice(eol + 1);
              } else {
                simulated = `${simulated}\n${insertText}`;
              }
            }
          } else {
            simulated = simulated.replace(/\n?$/, "\n") + insertText + "\n";
          }
          continue;
        }
        if (searchLines.join("\n") === replaceLines.join("\n")) continue;

        const result = fuzzyFindAndReplace(simulated, search, replacement, false);
        if (result.matchCount === 0) {
          if (isAlreadyApplied(simulated, search, replacement)) continue;
          const label = hunk.contextHint ? `'${hunk.contextHint}'` : "(no hint)";
          let msg = `${op.filePath}: hunk ${hi + 1} ${label} not found`;
          if (result.error) msg += ` — ${result.error}`;
          msg += formatNoMatchHint(result.error, 0, search, simulated);
          errors.push(msg);
        } else {
          simulated = result.content;
        }
      }
      overlay.set(op.filePath, simulated);
    } else if (op.kind === "delete") {
      const loaded = load(op.filePath);
      if (loaded.missing) {
        errors.push(`${op.filePath}: file not found for deletion`);
      } else {
        removed.add(op.filePath);
        overlay.set(op.filePath, null);
      }
    } else if (op.kind === "move") {
      const dest = op.newPath ?? "";
      if (!dest) {
        errors.push(`${op.filePath}: MOVE operation missing destination path`);
        continue;
      }
      const src = load(op.filePath);
      if (src.missing || src.content === null) {
        errors.push(`${op.filePath}: source file not found for move`);
      }
      const dst = load(dest);
      if (!dst.missing && dst.content !== null) {
        errors.push(`${dest}: destination already exists — move would overwrite`);
      }
      if (!src.missing && src.content !== null && (dst.missing || dst.content === null)) {
        overlay.set(dest, src.content);
        overlay.set(op.filePath, null);
        removed.add(op.filePath);
      }
    } else if (op.kind === "add") {
      const contentLines: string[] = [];
      for (const hunk of op.hunks) {
        for (const line of hunk.lines) {
          if (line.prefix === "+") contentLines.push(line.content);
        }
      }
      overlay.set(op.filePath, contentLines.join("\n"));
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      error:
        "Patch validation failed (no files were modified):\n" +
        errors.map((e) => `  • ${e}`).join("\n"),
    };
  }
  if (realChangeCount === 0) {
    return {
      ok: false,
      error: "Patch contains no changes (only context lines were provided)",
    };
  }

  // Re-apply updates onto a fresh overlay so apply matches validation
  // (already-applied hunks skipped the same way). The overlay from the
  // validate pass already holds the final contents.
  const files: V4aFileChange[] = [];
  const seen = new Set<string>();
  for (const op of operations) {
    if (op.kind === "add") {
      if (seen.has(op.filePath)) continue;
      seen.add(op.filePath);
      files.push({
        path: op.filePath,
        action: "add",
        before: null,
        after: overlay.get(op.filePath) ?? "",
      });
    } else if (op.kind === "delete") {
      if (seen.has(op.filePath)) continue;
      seen.add(op.filePath);
      files.push({
        path: op.filePath,
        action: "delete",
        before: read(op.filePath),
        after: null,
      });
    } else if (op.kind === "move") {
      const key = `${op.filePath}->${op.newPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      files.push({
        path: op.filePath,
        action: "move",
        ...(op.newPath !== undefined ? { destPath: op.newPath } : {}),
        before: read(op.filePath),
        after: overlay.get(op.newPath ?? "") ?? "",
      });
    } else if (op.kind === "update") {
      if (seen.has(op.filePath)) continue;
      seen.add(op.filePath);
      const after = overlay.get(op.filePath);
      const before = read(op.filePath);
      if (after === undefined) continue;
      files.push({
        path: op.filePath,
        action: "update",
        before,
        after,
      });
    }
  }

  return { ok: true, files };
}
