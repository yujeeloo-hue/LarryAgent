import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolResultContentPart } from "../../session/types.js";
import type { ToolDefinition, ToolExecuteResult, ToolHandler } from "../types.js";
import { TOOL_RESULT_DIFF_PART_ID } from "../displayMeta.js";
import { buildEditHunkWithContext, buildLineDiff, serializeLineDiff } from "../lineDiff.js";
import {
  applyV4aOperations,
  extractV4aPaths,
  formatNoMatchHint,
  fuzzyFindAndReplace,
  isAlreadyApplied,
  parseV4aPatch,
} from "../patch/index.js";
import {
  abortIfSignaled,
  displayPath,
  failureResult,
  resolveToolPath,
  revalidateToolPath,
} from "../pathUtil.js";
import { patchFileRiskAssessor } from "../policy/fileToolRisk.js";
import {
  FileLockAbortError,
  FileLockTimeoutError,
  fileLockToken,
  withFileLock,
} from "../fileLock.js";

const MAX_PATCH_CHARS = 2_000_000;
const MAX_REPORT_CHARS = 12_000;

export const patchDefinition: ToolDefinition = {
  name: "patch",
  description:
    "Targeted find-and-replace edits in files. Prefer this over write_file for existing files, and over sed/awk in the shell. Default replace mode uses fuzzy matching (whitespace/indent/unicode) so minor quoting drift will not break the edit. Returns PATCH APPLIED / PATCH FAILED / PATCH APPLIED (no-op) plus a nearby excerpt on failure — read it before retrying. Copy old_string from a recent read_file snippet (omit N| prefixes). " +
    "REPLACE (default): path + old_string + new_string. Optional replace_all. " +
    "V4A (mode='patch'): multi-file Apply Patch body in `patch`. Format:\n" +
    "*** Begin Patch\n*** Update File: path/to/file\n@@ context hint @@\n context line\n-removed line\n+added line\n*** End Patch",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["replace", "patch"],
        description:
          "Edit mode. 'replace' (default): path + old_string + new_string. 'patch': V4A body in `patch`.",
      },
      path: {
        type: "string",
        description: "File to edit (replace mode). Absolute, or workspace-relative.",
      },
      old_string: {
        type: "string",
        description:
          "Exact text to find (replace mode). Must be unique unless replace_all=true. Include surrounding context. Copy from read_file without N| prefixes.",
      },
      new_string: {
        type: "string",
        description:
          "Replacement text (replace mode). Must differ from old_string. Pass '' to delete the matched text.",
      },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence instead of requiring a unique match (default false).",
      },
      patch: {
        type: "string",
        description:
          "REQUIRED when mode='patch'. V4A patch body:\n*** Begin Patch\n*** Update File: path\n@@ hint @@\n context\n-old\n+new\n*** End Patch",
      },
    },
    additionalProperties: false,
  },
  defaultPermissionLevel: 1,
  assessRisk: patchFileRiskAssessor,
};

function clipReport(text: string): string {
  if (text.length <= MAX_REPORT_CHARS) return text;
  return `${text.slice(0, MAX_REPORT_CHARS)}\n[…truncated…]`;
}

function lockErrorResult(err: unknown, shown?: string): ToolExecuteResult {
  if (err instanceof FileLockAbortError) {
    return failureResult("Cancelled", ToolReturnCode.Cancelled);
  }
  if (err instanceof FileLockTimeoutError) {
    const who = shown ? `${shown} is` : "A target file is";
    return failureResult(
      `${who} being written by another flow; timed out waiting for the file lock (${err.message}). Retry shortly.`,
      ToolReturnCode.GenericFailure,
    );
  }
  const code =
    err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
  if (code === "ENOENT") {
    return failureResult(
      shown ? `File not found: ${shown}` : "File not found",
      ToolReturnCode.NotFound,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return failureResult(`PATCH FAILED — ${message}`, ToolReturnCode.GenericFailure);
}

/**
 * Absolute path for a patch target. Relative paths resolve against the
 * workspace root (Hermes / V4A models emit cwd-relative headers).
 */
export function resolvePatchTargetPath(
  input: string,
  context: { workspacePath: string; fullPermissionsEnabled: boolean },
): ReturnType<typeof resolveToolPath> {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      ok: false,
      reason: "path is required",
      returnCode: ToolReturnCode.InvalidArguments,
    };
  }
  const absolute = isAbsolute(trimmed)
    ? resolve(trimmed)
    : resolve(context.workspacePath, trimmed);
  return resolveToolPath(absolute, {
    workspacePath: context.workspacePath,
    allowOutsideWorkspace: context.fullPermissionsEnabled,
  });
}

async function withSortedFileLocks<T>(
  paths: string[],
  opts: { signal?: AbortSignal; adoptToken?: string },
  fn: () => Promise<T>,
): Promise<T> {
  const unique = [...new Set(paths)].sort();
  const run = (i: number): Promise<T> => {
    const p = unique[i];
    if (p === undefined) return fn();
    return withFileLock(p, "write", opts, () => run(i + 1));
  };
  return run(0);
}

function detectMode(raw: Record<string, unknown>): "replace" | "patch" | "invalid" {
  const modeRaw = raw.mode;
  if (modeRaw === "patch") return "patch";
  if (modeRaw === "replace") return "replace";
  if (modeRaw !== undefined && modeRaw !== null && modeRaw !== "") return "invalid";
  if (typeof raw.patch === "string" && raw.old_string === undefined) return "patch";
  return "replace";
}

async function handleReplace(
  raw: Record<string, unknown>,
  context: Parameters<ToolHandler>[1],
): Promise<ToolExecuteResult> {
  const pathArg = typeof raw.path === "string" ? raw.path : null;
  const oldString = typeof raw.old_string === "string" ? raw.old_string : null;
  const newString = typeof raw.new_string === "string" ? raw.new_string : null;
  const replaceAll = raw.replace_all === true;

  if (pathArg === null || oldString === null || newString === null) {
    return failureResult(
      'Invalid arguments: replace mode requires "path", "old_string", and "new_string" (strings). For V4A multi-file edits pass mode="patch" with a `patch` body.',
      ToolReturnCode.InvalidArguments,
    );
  }
  if (oldString.length === 0) {
    return failureResult(
      'Invalid arguments: "old_string" must not be empty.',
      ToolReturnCode.InvalidArguments,
    );
  }
  if (oldString.length > MAX_PATCH_CHARS || newString.length > MAX_PATCH_CHARS) {
    return failureResult(
      `Invalid arguments: old_string/new_string exceeds ${MAX_PATCH_CHARS} chars; split the edit.`,
      ToolReturnCode.InvalidArguments,
    );
  }

  const resolved = resolvePatchTargetPath(pathArg, context);
  if (!resolved.ok) return failureResult(resolved.reason, resolved.returnCode);
  const shown = displayPath(resolved.path.absolute);
  const adoptToken = context.toolCallId
    ? fileLockToken(context.sessionId, context.toolCallId)
    : undefined;

  try {
    return await withFileLock(
      resolved.path.absolute,
      "write",
      { signal: context.signal, adoptToken },
      async () => {
        const aborted = abortIfSignaled(context.signal);
        if (aborted) return aborted;
        const denied = revalidateToolPath(resolved.path.absolute, context);
        if (denied) return denied;
        const before = await readFile(resolved.path.absolute, "utf8");

        if (isAlreadyApplied(before, oldString, newString)) {
          return {
            returnCode: ToolReturnCode.Success,
            content: [
              {
                type: "text",
                text:
                  `PATCH APPLIED (no-op) — the requested edit is already present in ${shown}. ` +
                  `Nothing was written. Re-read only if you need a different change.`,
              },
            ],
          } satisfies ToolExecuteResult;
        }

        const result = fuzzyFindAndReplace(before, oldString, newString, replaceAll);
        if (result.error || result.matchCount === 0) {
          if (isAlreadyApplied(before, oldString, newString)) {
            return {
              returnCode: ToolReturnCode.Success,
              content: [
                {
                  type: "text",
                  text:
                    `PATCH APPLIED (no-op) — the requested edit is already present in ${shown}. ` +
                    `Nothing was written.`,
                },
              ],
            } satisfies ToolExecuteResult;
          }
          const hint = formatNoMatchHint(result.error, 0, oldString, before);
          const headline = `PATCH FAILED — ${result.error ?? "old_string not found"}`;
          return failureResult(
            clipReport(`${headline} in ${shown}.${hint}`),
            result.error?.includes("Found ") && result.error.includes("matches")
              ? ToolReturnCode.InvalidArguments
              : ToolReturnCode.NotFound,
          );
        }

        const deniedBeforeWrite = revalidateToolPath(resolved.path.absolute, context);
        if (deniedBeforeWrite) return deniedBeforeWrite;
        await writeFile(resolved.path.absolute, result.content, "utf8");
        const uiHunk = buildEditHunkWithContext(before, result.content, oldString, newString);
        const lineNo = (() => {
          const idx = before.indexOf(oldString);
          if (idx >= 0) return before.slice(0, idx).split("\n").length;
          return null;
        })();
        const where =
          lineNo !== null
            ? `at line ${lineNo}`
            : `via ${result.strategy ?? "fuzzy"} match`;
        const n = result.matchCount;
        return {
          returnCode: ToolReturnCode.Success,
          content: [
            {
              type: "text",
              text:
                n > 1
                  ? `PATCH APPLIED — replaced ${n} occurrences in ${shown} (${where}).`
                  : `PATCH APPLIED — replaced unique match ${where} in ${shown}.`,
            },
            {
              type: "text",
              id: TOOL_RESULT_DIFF_PART_ID,
              text: serializeLineDiff(uiHunk),
              path: shown,
            },
          ],
        } satisfies ToolExecuteResult;
      },
    );
  } catch (err) {
    return lockErrorResult(err, shown);
  }
}

async function handleV4a(
  raw: Record<string, unknown>,
  context: Parameters<ToolHandler>[1],
): Promise<ToolExecuteResult> {
  const patchBody = typeof raw.patch === "string" ? raw.patch : null;
  if (patchBody === null || patchBody.length === 0) {
    return failureResult(
      'Invalid arguments: mode="patch" requires a non-empty "patch" V4A body.',
      ToolReturnCode.InvalidArguments,
    );
  }
  if (patchBody.length > MAX_PATCH_CHARS) {
    return failureResult(
      `Invalid arguments: "patch" exceeds ${MAX_PATCH_CHARS} chars; split into smaller patches.`,
      ToolReturnCode.InvalidArguments,
    );
  }

  const parsed = parseV4aPatch(patchBody);
  if (parsed.error) {
    return failureResult(`PATCH FAILED — ${parsed.error}`, ToolReturnCode.InvalidArguments);
  }
  if (parsed.operations.length === 0) {
    return failureResult(
      "PATCH FAILED — the patch text contains no file operations. Provide a V4A body with *** Update/Add/Delete/Move File headers.",
      ToolReturnCode.InvalidArguments,
    );
  }

  const headerToAbs = new Map<string, string>();
  for (const header of extractV4aPaths(patchBody)) {
    const resolved = resolvePatchTargetPath(header, context);
    if (!resolved.ok) return failureResult(resolved.reason, resolved.returnCode);
    headerToAbs.set(header, resolved.path.absolute);
  }
  const rewritePath = (p: string) => headerToAbs.get(p) ?? p;
  const ops = parsed.operations.map((op) => ({
    ...op,
    filePath: rewritePath(op.filePath),
    ...(op.newPath !== undefined ? { newPath: rewritePath(op.newPath) } : {}),
  }));

  const lockPaths = [...new Set(ops.flatMap((op) => [op.filePath, op.newPath].filter(Boolean)))] as string[];
  const adoptToken = context.toolCallId
    ? fileLockToken(context.sessionId, context.toolCallId)
    : undefined;

  const lockOpts: { signal?: AbortSignal; adoptToken?: string } = {};
  if (context.signal) lockOpts.signal = context.signal;
  if (adoptToken) lockOpts.adoptToken = adoptToken;

  try {
    return await withSortedFileLocks(lockPaths, lockOpts, async () => {
      const aborted = abortIfSignaled(context.signal);
      if (aborted) return aborted;

      const cache = new Map<string, string | null>();
      const readCached = (p: string): string | null => {
        if (cache.has(p)) return cache.get(p) ?? null;
        return null;
      };
      for (const p of lockPaths) {
        const denied = revalidateToolPath(p, context);
        if (denied) return denied;
        try {
          cache.set(p, await readFile(p, "utf8"));
        } catch {
          cache.set(p, null);
        }
      }

      const applied = applyV4aOperations(ops, readCached);
      if (!applied.ok) {
        return failureResult(clipReport(`PATCH FAILED — ${applied.error}`), ToolReturnCode.GenericFailure);
      }

      const content: ToolResultContentPart[] = [];
      const lines: string[] = [];
      let changed = 0;
      for (const file of applied.files) {
        const denied = revalidateToolPath(file.path, context);
        if (denied) return denied;
        const shown = displayPath(file.path);
        if (file.action === "delete") {
          await rm(file.path, { force: true });
          lines.push(`Deleting file ${shown}`);
          changed += 1;
          continue;
        }
        if (file.action === "move") {
          const dest = file.destPath;
          if (!dest) continue;
          const deniedDest = revalidateToolPath(dest, context);
          if (deniedDest) return deniedDest;
          await mkdir(dirname(dest), { recursive: true });
          const deniedAfterMkdir = revalidateToolPath(dest, context)
            ?? revalidateToolPath(file.path, context);
          if (deniedAfterMkdir) return deniedAfterMkdir;
          if (file.after !== null) {
            try {
              await rename(file.path, dest);
              const deniedAfterRename = revalidateToolPath(dest, context);
              if (deniedAfterRename) return deniedAfterRename;
              if ((await readFile(dest, "utf8").catch(() => null)) !== file.after) {
                const deniedBeforeWrite = revalidateToolPath(dest, context);
                if (deniedBeforeWrite) return deniedBeforeWrite;
                await writeFile(dest, file.after, "utf8");
              }
            } catch {
              const deniedFallback = revalidateToolPath(dest, context)
                ?? revalidateToolPath(file.path, context);
              if (deniedFallback) return deniedFallback;
              await writeFile(dest, file.after, "utf8");
              const deniedBeforeRemove = revalidateToolPath(file.path, context);
              if (deniedBeforeRemove) return deniedBeforeRemove;
              await rm(file.path, { force: true });
            }
          }
          lines.push(`Moving file ${shown} -> ${displayPath(dest)}`);
          changed += 1;
          continue;
        }
        const after = file.after ?? "";
        if (file.action === "update" && (file.before ?? "") === after) {
          continue;
        }
        if (file.action === "add") {
          await mkdir(dirname(file.path), { recursive: true });
        }
        const deniedBeforeWrite = revalidateToolPath(file.path, context);
        if (deniedBeforeWrite) return deniedBeforeWrite;
        await writeFile(file.path, after, "utf8");
        lines.push(file.action === "add" ? `Creating file ${shown}` : `Patching file ${shown}`);
        changed += 1;
        const before = file.before ?? "";
        if (before !== after) {
          content.push({
            type: "text",
            id: TOOL_RESULT_DIFF_PART_ID,
            text: serializeLineDiff(buildLineDiff(before, after)),
            // Explicit pairing — the report-text zip in the renderer drifts
            // when the patch also deletes/moves files or clips the report.
            path: shown,
          });
        }
      }

      const headline =
        changed === 0
          ? "PATCH APPLIED (no-op) — the patch appears to be already applied; nothing was written."
          : `PATCH APPLIED — ${changed} file(s) patched.`;
      content.unshift({ type: "text", text: clipReport([headline, ...lines].join("\n")) });
      return { returnCode: ToolReturnCode.Success, content } satisfies ToolExecuteResult;
    });
  } catch (err) {
    return lockErrorResult(err);
  }
}

export const patchHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;
  const raw = args as Record<string, unknown>;
  if (typeof raw.patch_text === "string") {
    return failureResult(
      'The patch tool no longer accepts GNU unified diffs (`patch_text`). Use replace mode: path + old_string + new_string. For multi-file edits use mode="patch" with a V4A `patch` body.',
      ToolReturnCode.InvalidArguments,
    );
  }
  const mode = detectMode(raw);
  if (mode === "invalid") {
    return failureResult(
      'Invalid arguments: "mode" must be "replace" or "patch".',
      ToolReturnCode.InvalidArguments,
    );
  }
  return mode === "patch" ? handleV4a(raw, context) : handleReplace(raw, context);
};
