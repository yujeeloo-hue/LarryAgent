import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
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
import { formatSymbolHit } from "./symbols.js";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "release",
  "tmp",
  ".jellybot",
]);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_MATCHES = 200;
const MAX_FILES = 4000;
/** Cap a single match line so minified/JSON dumps cannot blow the context window. */
const MAX_MATCH_LINE_CHARS = 500;
/** Cap total grep tool result text (aligned with read_file's 128 KB spirit). */
const MAX_OUTPUT_CHARS = 128 * 1024;
/** Zero-hit identifier fallback: top symbol-index definitions to surface. */
const SYMBOL_HINT_LIMIT = 10;
/** Plain identifier (no regex metachars) — safe to feed the symbol index. */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function clipMatchLine(text: string): string {
  if (text.length <= MAX_MATCH_LINE_CHARS) return text;
  return `${text.slice(0, MAX_MATCH_LINE_CHARS)}…(+${text.length - MAX_MATCH_LINE_CHARS} chars)`;
}

/** Default level: 0. */
export const grepDefinition: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents for a pattern (defaults to workspace root).",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Search pattern (JavaScript RegExp)." },
      path: {
        type: "string",
        description: "Optional absolute path to limit the search.",
      },
    },
    required: ["pattern"],
  },
  defaultPermissionLevel: 0,
};

type MatchLine = { file: string; line: number; text: string };

async function walkFiles(
  dir: string,
  files: string[],
  context: ToolExecuteContext,
): Promise<"ok" | "aborted"> {
  const { signal } = context;
  if (signal?.aborted) return "aborted";
  if (files.length >= MAX_FILES) return "ok";
  if (revalidateToolPath(dir, context)) return "ok";
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return "ok";
  }
  for (const entry of entries) {
    if (signal?.aborted) return "aborted";
    if (files.length >= MAX_FILES) return "ok";
    if (entry.name === "." || entry.name === "..") continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const walk = await walkFiles(absolute, files, context);
      if (walk === "aborted") return "aborted";
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(absolute);
    }
  }
  return "ok";
}

async function searchFile(
  absolute: string,
  regex: RegExp,
  matches: MatchLine[],
  context: ToolExecuteContext,
): Promise<"ok" | "aborted"> {
  const { signal } = context;
  if (signal?.aborted) return "aborted";
  if (matches.length >= MAX_MATCHES) return "ok";
  // A safe search root does not make symlinked descendants safe to read.
  if (revalidateToolPath(absolute, context)) return "ok";
  try {
    const info = await stat(absolute);
    if (signal?.aborted) return "aborted";
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return "ok";
    if (revalidateToolPath(absolute, context)) return "ok";
    const buf = await readFile(absolute);
    if (signal?.aborted) return "aborted";
    if (buf.includes(0)) return "ok";
    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    const shown = displayPath(absolute);
    for (let i = 0; i < lines.length; i++) {
      if (signal?.aborted) return "aborted";
      if (matches.length >= MAX_MATCHES) return "ok";
      const line = lines[i] ?? "";
      if (regex.test(line)) {
        matches.push({ file: shown, line: i + 1, text: clipMatchLine(line) });
      }
      regex.lastIndex = 0;
    }
  } catch {
    // skip unreadable
  }
  return "ok";
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

export async function runGrep(input: {
  pattern: string;
  path?: string;
  context: ToolExecuteContext;
}): Promise<{ text: string; returnCode: number }> {
  const { context } = input;
  if (context.signal?.aborted) {
    return { text: "Cancelled", returnCode: ToolReturnCode.Cancelled };
  }

  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, "g");
  } catch {
    return {
      text: `Invalid pattern: ${input.pattern}`,
      returnCode: ToolReturnCode.InvalidArguments,
    };
  }

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

  const files: string[] = [];
  if (startIsFile) {
    files.push(root);
  } else {
    const walk = await walkFiles(root, files, context);
    if (walk === "aborted") {
      return { text: "Cancelled", returnCode: ToolReturnCode.Cancelled };
    }
  }

  const matches: MatchLine[] = [];
  for (const file of files) {
    if (matches.length >= MAX_MATCHES) break;
    const search = await searchFile(file, regex, matches, context);
    if (search === "aborted") {
      return { text: "Cancelled", returnCode: ToolReturnCode.Cancelled };
    }
  }

  const truncatedByMatchCap = matches.length >= MAX_MATCHES;
  const headerBase = `grep /${input.pattern}/ in ${shownRoot} — ${matches.length} match(es)`;
  if (matches.length === 0) {
    const hint = symbolIndexHint({
      pattern: input.pattern,
      pathPrefix: root,
      workspacePath: context.workspacePath,
    });
    return {
      text:
        hint === null
          ? `${headerBase}\n(no matches)`
          : `${headerBase}\n(no matches)\n${hint}`,
      returnCode: ToolReturnCode.Success,
    };
  }

  const lines: string[] = [];
  let truncatedByOutputCap = false;
  let used = headerBase.length + 1; // + newline before body
  for (const m of matches) {
    const row = `${m.file}:${m.line}:${m.text}`;
    const next = used + (lines.length > 0 ? 1 : 0) + row.length;
    if (next > MAX_OUTPUT_CHARS) {
      truncatedByOutputCap = true;
      break;
    }
    lines.push(row);
    used = next;
  }

  const notes: string[] = [];
  if (truncatedByMatchCap) notes.push("match limit");
  if (truncatedByOutputCap) notes.push("output size limit");
  const header =
    notes.length > 0
      ? `${headerBase} (truncated: ${notes.join(", ")}; showing ${lines.length})`
      : headerBase;
  return {
    text: `${header}\n${lines.join("\n")}`,
    returnCode: ToolReturnCode.Success,
  };
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
  const path =
    typeof args.path === "string" && args.path.trim().length > 0
      ? args.path
      : undefined;

  const result = await runGrep({
    pattern,
    context,
    ...(path !== undefined ? { path } : {}),
  });
  if (result.returnCode === ToolReturnCode.Cancelled) {
    return cancelledResult(result.text);
  }
  return textResult(result.text, result.returnCode);
};
