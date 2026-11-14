import { stat } from "node:fs/promises";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
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
import { listCandidateFiles, MAX_CANDIDATE_FILES } from "../workspaceFiles.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const STAT_CONCURRENCY = 32;

/** Default level: 0. */
export const globDefinition: ToolDefinition = {
  name: "glob",
  description:
    "Find files by name/path pattern (respects .gitignore), most recently modified first. " +
    'Patterns without "/" match at any depth: "*.ts", "**/*Controller.ts", "src/**/grep*.{ts,tsx}". ' +
    "Use instead of repeated list_dir or shell dir/find to locate files.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob over paths relative to the search root.",
      },
      path: {
        type: "string",
        description: "Optional absolute directory to search (default: workspace root).",
      },
      limit: {
        type: "integer",
        description: `Max files to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        minimum: 1,
        maximum: MAX_LIMIT,
      },
    },
    required: ["pattern"],
  },
  defaultPermissionLevel: 0,
};

function readLimit(raw: unknown): number {
  let n: number | undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) n = Math.trunc(raw);
  else if (typeof raw === "string" && /^\s*\d+\s*$/.test(raw)) n = Number(raw.trim());
  if (n === undefined) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

export const globHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
  if (!pattern) {
    return failureResult(
      'Invalid arguments: "pattern" (string) is required.',
      ToolReturnCode.InvalidArguments,
    );
  }
  const limit = readLimit(args.limit);

  const scopePath =
    typeof args.path === "string" && args.path.trim().length > 0
      ? args.path
      : workspaceRootAbsolute(context.workspacePath);
  const resolved = resolveToolPath(scopePath, {
    workspacePath: context.workspacePath,
    allowOutsideWorkspace: context.fullPermissionsEnabled,
  });
  if (!resolved.ok) return failureResult(resolved.reason, resolved.returnCode);

  const root = resolved.path.absolute;
  const shownRoot = displayPath(root);
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      return failureResult(`Not a directory: ${shownRoot}`, ToolReturnCode.InvalidArguments);
    }
  } catch {
    return failureResult(`Directory not found: ${shownRoot}`, ToolReturnCode.NotFound);
  }

  let matcher;
  try {
    matcher = compileGlob(pattern);
  } catch {
    return failureResult(`Invalid glob: ${pattern}`, ToolReturnCode.InvalidArguments);
  }

  const listed = await listCandidateFiles({
    root,
    matches: matcher,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  if (listed.aborted) return cancelledResult();

  const entries: Array<{ shown: string; mtimeMs: number }> = [];
  for (let start = 0; start < listed.files.length; start += STAT_CONCURRENCY) {
    if (context.signal?.aborted) return cancelledResult();
    const batch = listed.files.slice(start, start + STAT_CONCURRENCY);
    const stats = await Promise.all(
      batch.map(async (file) => {
        if (revalidateToolPath(file.absolute, context)) return null;
        try {
          const info = await stat(file.absolute);
          return info.isFile() ? info.mtimeMs : null;
        } catch {
          return null;
        }
      }),
    );
    for (let i = 0; i < batch.length; i++) {
      const mtimeMs = stats[i];
      if (mtimeMs === null || mtimeMs === undefined) continue;
      entries.push({ shown: displayPath(batch[i]!.absolute), mtimeMs });
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const notes: string[] = [];
  if (entries.length > limit) notes.push(`showing ${limit} most recent of ${entries.length}`);
  if (listed.truncated) {
    notes.push(
      `stopped after ${MAX_CANDIDATE_FILES} matching files — results may be incomplete; narrow the pattern or path`,
    );
  }
  const header = `glob "${pattern}" in ${shownRoot} — ${entries.length} file(s)`;
  const headerWithNotes = notes.length > 0 ? `${header}\nNote: ${notes.join("; ")}` : header;
  if (entries.length === 0) {
    return textResult(`${headerWithNotes}\n(no files)`, ToolReturnCode.Success);
  }
  const body = entries.slice(0, limit).map((e) => e.shown).join("\n");
  return textResult(`${headerWithNotes}\n${body}`, ToolReturnCode.Success);
};
