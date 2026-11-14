import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ToolReturnCode } from "../session/returnCodes.js";
import type { ToolExecuteResult } from "./types.js";

export type ResolvedToolPath = {
  absolute: string;
  /** True when the path is outside the workspace root. */
  outsideWorkspace: boolean;
};

export type ResolveToolPathOptions = {
  workspacePath: string;
  /** When false, paths outside the workspace are rejected. */
  allowOutsideWorkspace: boolean;
};

/**
 * Attachment wire stubs surface `file://` URLs (e.g. generate_image /
 * display_image outputs); accept both forms and normalize to a filesystem
 * path. Invalid URLs fall through untouched to fail later with a clear
 * "must be an absolute path" error.
 */
function normalizeFileUri(input: string): string {
  if (!input.startsWith("file:")) return input;
  try {
    return fileURLToPath(input);
  } catch {
    return input;
  }
}

function outsideRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** Resolve existing symlinks/junctions, including parents of a new file. */
function canonicalPath(path: string): string {
  let ancestor = path;
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync.native(ancestor), ...missing.slice().reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // ENOENT can also mean a dangling symlink. Never treat an existing
      // link as a missing component: a later write would follow its target.
      try {
        lstatSync(ancestor);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        missing.push(basename(ancestor));
        ancestor = parent;
        continue;
      }
      throw error;
    }
  }
}

/**
 * Resolve a tool path argument.
 * Requires an absolute path. Both lexical and canonical targets must stay
 * in the workspace unless Bypass is enabled. Keep the requested path for
 * display and unlink/rename semantics (an internal symlink is still a link).
 */
export function resolveToolPath(
  inputPath: string,
  options: ResolveToolPathOptions,
):
  | { ok: true; path: ResolvedToolPath }
  | { ok: false; reason: string; returnCode: number } {
  const trimmed = normalizeFileUri(inputPath.trim());
  if (!trimmed) {
    return {
      ok: false,
      reason: "path is required",
      returnCode: ToolReturnCode.InvalidArguments,
    };
  }
  if (!isAbsolute(trimmed)) {
    return {
      ok: false,
      reason: "path must be an absolute path",
      returnCode: ToolReturnCode.InvalidArguments,
    };
  }

  const absolute = resolve(trimmed);
  const root = resolve(options.workspacePath);
  let outsideWorkspace = outsideRoot(root, absolute);
  try {
    outsideWorkspace ||= outsideRoot(canonicalPath(root), canonicalPath(absolute));
  } catch {
    if (!options.allowOutsideWorkspace) {
      return {
        ok: false,
        reason: "cannot verify that path resolves inside the workspace; enable Bypass permissions to access it",
        returnCode: ToolReturnCode.PermissionDenied,
      };
    }
    // Bypass preserves normal filesystem behavior, including errors for
    // missing targets, dangling links, and inaccessible paths.
  }

  if (outsideWorkspace && !options.allowOutsideWorkspace) {
    return {
      ok: false,
      reason:
        "path is outside the workspace; enable Bypass permissions to access it",
      returnCode: ToolReturnCode.PermissionDenied,
    };
  }

  return { ok: true, path: { absolute, outsideWorkspace } };
}

/**
 * Recheck after waits, before filesystem access. This narrows symlink-swap
 * races; it is not an OS sandbox: portable Node APIs cannot atomically bind
 * an entire path walk to the following read/write/rename operation.
 */
export function revalidateToolPath(
  path: string,
  context: { workspacePath: string; fullPermissionsEnabled: boolean; assertPath?: (path: string) => void },
): ToolExecuteResult | null {
  try { context.assertPath?.(path); } catch (error) { return failureResult(String(error), ToolReturnCode.PermissionDenied); }
  const resolved = resolveToolPath(path, {
    workspacePath: context.workspacePath,
    allowOutsideWorkspace: context.fullPermissionsEnabled,
  });
  return resolved.ok ? null : failureResult(resolved.reason, resolved.returnCode);
}

/** Workspace root as an absolute path (default scope when a path arg is omitted). */
export function workspaceRootAbsolute(workspacePath: string): string {
  return resolve(workspacePath);
}

/** Display form: always absolute, POSIX-style separators for logs. */
export function displayPath(absolute: string): string {
  return absolute.split(sep).join("/");
}

export function textResult(
  text: string,
  returnCode: number,
): ToolExecuteResult {
  return {
    returnCode,
    content: [{ type: "text", text }],
  };
}

export function failureResult(
  message: string,
  returnCode: number = ToolReturnCode.GenericFailure,
): ToolExecuteResult {
  return textResult(message, returnCode);
}

export function cancelledResult(
  message: string = "Cancelled",
): ToolExecuteResult {
  return failureResult(message, ToolReturnCode.Cancelled);
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String((err as { name: unknown }).name) : "";
  return name === "AbortError";
}

/** Return a cancelled result if the signal is already aborted. */
export function abortIfSignaled(
  signal: AbortSignal | undefined,
): ToolExecuteResult | null {
  if (signal?.aborted) return cancelledResult();
  return null;
}
