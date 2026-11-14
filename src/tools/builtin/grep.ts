import { readFile, stat } from "node:fs/promises";
import { ToolReturnCode } from "../../session/returnCodes.js";
import {
  openCppSymbolDatabase,
  searchCppSymbols,
} from "../../main/cppSymbols/db.js";
import {
  cppSymbolDatabasePath,
  normalizeSymbolPath,
} from "../../main/cppSymbols/paths.js";
import type { ToolDefinition, ToolExecuteContext, ToolHandler } from "../types.js";
import {
  abortIfSignaled,
  cancelledResult,
  displayPath,
  failureResult,
  resolveToolPath,
  revalidateToolPath,
  textResult,
  workspaceRootAbsolute,
} from "../pathUtil.js";
import { compileGlob } from "../globMatch.js";
import {
  listCandidateFiles,
  MAX_CANDIDATE_FILES,
  type CandidateFile,
} from "../workspaceFiles.js";
import { formatSymbolHit } from "./symbols.js";

const MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_HEAD_LIMIT = 200;
const MAX_HEAD_LIMIT = 1000;
const MAX_CONTEXT_LINES = 10;
/** Files read concurrently; results are still consumed in path order. */
const READ_CONCURRENCY = 16;
/** Cap a single match line so minified/JSON dumps cannot blow the context window. */
const MAX_MATCH_LINE_CHARS = 500;
/** Cap total grep tool result text (aligned with read_file's 128 KB spirit). */
const MAX_OUTPUT_CHARS = 128 * 1024;
/** Zero-hit identifier fallback: top symbol-index definitions to surface. */
const SYMBOL_HINT_LIMIT = 10;
/** Plain identifier (no regex metachars) — safe to feed the symbol index. */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export type GrepOutputMode = "content" | "files_with_matches" | "count";

const OUTPUT_MODES: ReadonlySet<string> = new Set([
  "content",
  "files_with_matches",
  "count",
]);

function clipMatchLine(text: string): string {
  if (text.length <= MAX_MATCH_LINE_CHARS) return text;
  return `${text.slice(0, MAX_MATCH_LINE_CHARS)}…(+${text.length - MAX_MATCH_LINE_CHARS} chars)`;
}

/** Default level: 0. */
export const grepDefinition: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents with a regex (defaults to the workspace root). Respects .gitignore. " +
    "Narrow with path / glob first; use output_mode=files_with_matches to locate files, " +
    "context to see surrounding lines without a follow-up read_file. " +
    "The header reports truncation — when it says results may be incomplete, narrow the scope instead of rephrasing the pattern.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Search pattern (JavaScript RegExp, matched per line).",
      },
      path: {
        type: "string",
        description: "Optional absolute file or directory to limit the search.",
      },
      glob: {
        type: "string",
        description:
          'Optional file filter relative to the search root, e.g. "*.ts", "src/**/*.{ts,tsx}".',
      },
      case_insensitive: {
        type: "boolean",
        description: "Case-insensitive match (default false).",
      },
      context: {
        type: "integer",
        description: `Lines of context before and after each match (content mode; 0–${MAX_CONTEXT_LINES}, default 0).`,
        minimum: 0,
        maximum: MAX_CONTEXT_LINES,
      },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description:
          "content (default): matching lines; files_with_matches: file paths, most recently modified first; count: matches per file.",
      },
      head_limit: {
        type: "integer",
        description: `Max matches (content) or files (other modes) to return (default ${DEFAULT_HEAD_LIMIT}, max ${MAX_HEAD_LIMIT}).`,
        minimum: 1,
        maximum: MAX_HEAD_LIMIT,
      },
    },
    required: ["pattern"],
  },
  defaultPermissionLevel: 0,
};

export type GrepInput = {
  pattern: string;
  path?: string;
  glob?: string;
  caseInsensitive?: boolean;
  contextLines?: number;
  outputMode?: GrepOutputMode;
  headLimit?: number;
};

type FileScan = {
  file: CandidateFile;
  shown: string;
  mtimeMs: number;
  /** 0-based line indices of matches (capped by the caller's budget). */
  matchLines: number[];
  lines: string[];
};

type ReadOutcome =
  | { kind: "text"; text: string; mtimeMs: number }
  | { kind: "skip_large" }
  | { kind: "skip" };

async function readCandidate(
  absolute: string,
  context: ToolExecuteContext,
): Promise<ReadOutcome> {
  // A safe search root does not make symlinked descendants safe to read.
  if (revalidateToolPath(absolute, context)) return { kind: "skip" };
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return { kind: "skip" };
    if (info.size > MAX_FILE_BYTES) return { kind: "skip_large" };
    const buf = await readFile(absolute);
    if (buf.includes(0)) return { kind: "skip" };
    return { kind: "text", text: buf.toString("utf8"), mtimeMs: info.mtimeMs };
  } catch {
    return { kind: "skip" };
  }
}

/**
 * When a plain-identifier grep finds no text matches, surface top
 * symbol-index definitions for it (definitions often live outside the grep
 * file/match caps on large trees). Returns null when the pattern is
 * regex-shaped, too short, or the workspace has no usable symbol database —
 * grep output then stays exactly as before.
 */
function symbolIndexHint(input: {
  pattern: string;
  pathPrefix: string;
  workspacePath: string;
}): string | null {
  if (input.pattern.length < 2 || !IDENTIFIER_PATTERN.test(input.pattern)) {
    return null;
  }
  const root = workspaceRootAbsolute(input.workspacePath);
  let db;
  try {
    db = openCppSymbolDatabase(cppSymbolDatabasePath(root), { readOnly: true });
  } catch {
    return null;
  }
  try {
    const result = searchCppSymbols(db, {
      query: input.pattern,
      pathPrefix: normalizeSymbolPath(input.pathPrefix),
      limit: SYMBOL_HINT_LIMIT,
    });
    if (result.hits.length === 0) return null;
    return (
      `Symbol index definitions for "${input.pattern}" (no text matches; use the symbols tool for full results):\n` +
      result.hits.map(formatSymbolHit).join("\n")
    );
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function clampInt(raw: unknown, min: number, max: number): number | undefined {
  let n: number | undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) n = Math.trunc(raw);
  else if (typeof raw === "string" && /^\s*\d+\s*$/.test(raw)) n = Number(raw.trim());
  if (n === undefined) return undefined;
  return Math.min(max, Math.max(min, n));
}

function renderContent(
  scans: FileScan[],
  contextLines: number,
): string[] {
  const rows: string[] = [];
  for (const scan of scans) {
    if (contextLines === 0) {
      for (const idx of scan.matchLines) {
        rows.push(`${scan.shown}:${idx + 1}:${clipMatchLine(scan.lines[idx] ?? "")}`);
      }
      continue;
    }
    const matchSet = new Set(scan.matchLines);
    let lastPrinted = -1;
    for (const idx of scan.matchLines) {
      const from = Math.max(0, idx - contextLines, lastPrinted + 1);
      const to = Math.min(scan.lines.length - 1, idx + contextLines);
      if (rows.length > 0 && (lastPrinted === -1 || from > lastPrinted + 1)) rows.push("--");
      for (let i = from; i <= to; i++) {
        const sepChar = matchSet.has(i) ? ":" : "-";
        rows.push(`${scan.shown}${sepChar}${i + 1}${sepChar}${clipMatchLine(scan.lines[i] ?? "")}`);
      }
      lastPrinted = Math.max(lastPrinted, to);
    }
  }
  return rows;
}

export async function runGrep(input: GrepInput & {
  context: ToolExecuteContext;
}): Promise<{ text: string; returnCode: number }> {
  const { context } = input;
  if (context.signal?.aborted) {
    return { text: "Cancelled", returnCode: ToolReturnCode.Cancelled };
  }

  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, input.caseInsensitive ? "i" : "");
  } catch {
    return {
      text: `Invalid pattern: ${input.pattern}`,
      returnCode: ToolReturnCode.InvalidArguments,
    };
  }

  const outputMode: GrepOutputMode = input.outputMode ?? "content";
  const headLimit = input.headLimit ?? DEFAULT_HEAD_LIMIT;
  const contextLines = outputMode === "content" ? (input.contextLines ?? 0) : 0;

  const scopePath =
    input.path !== undefined
      ? input.path
      : workspaceRootAbsolute(context.workspacePath);

  const resolved = resolveToolPath(scopePath, {
    workspacePath: context.workspacePath,
    allowOutsideWorkspace: context.fullPermissionsEnabled,
  });
  if (!resolved.ok) {
    return { text: resolved.reason, returnCode: resolved.returnCode };
  }

  const root = resolved.path.absolute;
  const shownRoot = displayPath(root);
  let startIsFile = false;
  try {
    const info = await stat(root);
    if (context.signal?.aborted) {
      return { text: "Cancelled", returnCode: ToolReturnCode.Cancelled };
    }
    startIsFile = info.isFile();
  } catch {
    return {
      text: `Path not found: ${shownRoot}`,
      returnCode: ToolReturnCode.NotFound,
    };
  }

  let candidates: CandidateFile[];
  let listTruncated = false;
  if (startIsFile) {
    candidates = [{ absolute: root, relative: displayPath(root) }];
  } else {
    const matcher = input.glob?.trim() ? compileGlob(input.glob) : null;
    const listed = await listCandidateFiles({
      root,
      matches: matcher,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (listed.aborted) {
      return { text: "Cancelled", returnCode: ToolReturnCode.Cancelled };
    }
    candidates = listed.files;
    listTruncated = listed.truncated;
  }

  const scans: FileScan[] = [];
  let totalMatches = 0;
  let searchedFiles = 0;
  let skippedLarge = 0;
  let hitLimit = false;

  outer: for (let start = 0; start < candidates.length; start += READ_CONCURRENCY) {
    if (context.signal?.aborted) {
      return { text: "Cancelled", returnCode: ToolReturnCode.Cancelled };
    }
    const batch = candidates.slice(start, start + READ_CONCURRENCY);
    const reads = await Promise.all(batch.map((f) => readCandidate(f.absolute, context)));
    for (let i = 0; i < batch.length; i++) {
      const read = reads[i]!;
      if (read.kind === "skip_large") {
        skippedLarge++;
        continue;
      }
      if (read.kind !== "text") continue;
      searchedFiles++;
      const lines = read.text.split(/\r?\n/);
      const matchLines: number[] = [];
      for (let idx = 0; idx < lines.length; idx++) {
        if (!regex.test(lines[idx] ?? "")) continue;
        if (outputMode === "content" && totalMatches >= headLimit) {
          hitLimit = true;
          break;
        }
        matchLines.push(idx);
        totalMatches++;
        if (outputMode === "files_with_matches") break;
      }
      if (matchLines.length > 0) {
        if (outputMode !== "content" && scans.length >= headLimit) {
          hitLimit = true;
          break outer;
        }
        scans.push({
          file: batch[i]!,
          shown: displayPath(batch[i]!.absolute),
          mtimeMs: read.mtimeMs,
          matchLines,
          lines: outputMode === "content" ? lines : [],
        });
      }
      if (hitLimit) break outer;
    }
  }

  const notes: string[] = [];
  if (hitLimit) {
    notes.push(
      outputMode === "content"
        ? `stopped at head_limit ${headLimit} matches`
        : `stopped at head_limit ${headLimit} files`,
    );
  }
  if (listTruncated) {
    notes.push(
      `only the first ${MAX_CANDIDATE_FILES} files were searched — results may be incomplete; narrow with path or glob`,
    );
  }
  if (skippedLarge > 0) {
    notes.push(`${skippedLarge} file(s) over 1 MB skipped`);
  }

  const countLabel =
    outputMode === "files_with_matches"
      ? `${scans.length} file(s) with matches`
      : `${totalMatches} match(es) in ${scans.length} file(s)`;
  const headerBase = `grep /${input.pattern}/${input.caseInsensitive ? "i" : ""} in ${shownRoot} — ${countLabel}; searched ${searchedFiles} file(s)`;

  if (scans.length === 0) {
    const hint = symbolIndexHint({
      pattern: input.pattern,
      pathPrefix: root,
      workspacePath: context.workspacePath,
    });
    const header = notes.length > 0 ? `${headerBase}\nNote: ${notes.join("; ")}` : headerBase;
    return {
      text:
        hint === null
          ? `${header}\n(no matches)`
          : `${header}\n(no matches)\n${hint}`,
      returnCode: ToolReturnCode.Success,
    };
  }

  let rows: string[];
  if (outputMode === "files_with_matches") {
    rows = scans
      .slice()
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((s) => s.shown);
  } else if (outputMode === "count") {
    rows = scans.map((s) => `${s.shown}:${s.matchLines.length}`);
  } else {
    rows = renderContent(scans, contextLines);
  }

  const lines: string[] = [];
  let used = headerBase.length + 200;
  let truncatedByOutputCap = false;
  for (const row of rows) {
    const next = used + 1 + row.length;
    if (next > MAX_OUTPUT_CHARS) {
      truncatedByOutputCap = true;
      break;
    }
    lines.push(row);
    used = next;
  }
  if (truncatedByOutputCap) {
    notes.push(`output size limit — showing ${lines.length} of ${rows.length} rows`);
  }

  const header = notes.length > 0 ? `${headerBase}\nNote: ${notes.join("; ")}` : headerBase;
  return {
    text: `${header}\n${lines.join("\n")}`,
    returnCode: ToolReturnCode.Success,
  };
}

/** Parse grep options shared by grep and batch_search queries. */
export function readGrepOptions(
  args: Record<string, unknown>,
): Omit<GrepInput, "pattern"> | { error: string } {
  const out: Omit<GrepInput, "pattern"> = {};
  if (typeof args.path === "string" && args.path.trim().length > 0) {
    out.path = args.path;
  }
  if (typeof args.glob === "string" && args.glob.trim().length > 0) {
    out.glob = args.glob.trim();
  }
  if (args.case_insensitive === true || args.case_insensitive === "true") {
    out.caseInsensitive = true;
  }
  if (args.output_mode !== undefined) {
    if (typeof args.output_mode !== "string" || !OUTPUT_MODES.has(args.output_mode)) {
      return { error: 'output_mode must be "content", "files_with_matches" or "count"' };
    }
    out.outputMode = args.output_mode as GrepOutputMode;
  }
  const contextLines = clampInt(args.context, 0, MAX_CONTEXT_LINES);
  if (contextLines !== undefined) out.contextLines = contextLines;
  const headLimit = clampInt(args.head_limit, 1, MAX_HEAD_LIMIT);
  if (headLimit !== undefined) out.headLimit = headLimit;
  return out;
}

export const grepHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const pattern = typeof args.pattern === "string" ? args.pattern : null;
  if (pattern === null || pattern.length === 0) {
    return failureResult(
      'Invalid arguments: "pattern" (string) is required.',
      ToolReturnCode.InvalidArguments,
    );
  }
  const options = readGrepOptions(args);
  if ("error" in options) {
    return failureResult(`Invalid arguments: ${options.error}`, ToolReturnCode.InvalidArguments);
  }

  const result = await runGrep({ pattern, ...options, context });
  if (result.returnCode === ToolReturnCode.Cancelled) {
    return cancelledResult(result.text);
  }
  return textResult(result.text, result.returnCode);
};
