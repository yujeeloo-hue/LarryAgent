import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ToolReturnCode } from "../session/returnCodes.js";
import type { ToolExecuteResult } from "./types.js";

export type ResolvedToolPath = {
  absolute: string;
  outsideWorkspace: boolean;
};

export type ResolveToolPathOptions = {
  workspacePath: string;
  allowOutsideWorkspace: boolean;
};

let checkoutRoots: (workspacePath: string) => readonly string[] = () => [];

export function configureCheckoutRoots(resolver: (workspacePath: string) => readonly string[]): void {
  checkoutRoots = resolver;
}

const UNMATERIALIZED_HINT =
  "is inside a collaborative branch checkout but has not been checked out there. Call collaborative_branch op=materialize with its repository-relative path first; for a file the branch does not have yet, pass create: true";

function insideCheckoutRoot(workspacePath: string, absolute: string): boolean {
  let roots: readonly string[];
  try { roots = checkoutRoots(workspacePath); } catch { return false; }
  return roots.some((root) => {
    const resolved = resolve(root);
    if (outsideRoot(resolved, absolute)) return false;
    try { return !outsideRoot(canonicalPath(resolved), canonicalPath(absolute)); } catch { return false; }
  });
}

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

function canonicalPath(path: string): string {
  let ancestor = path;
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync.native(ancestor), ...missing.slice().reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
  if (outsideWorkspace && insideCheckoutRoot(options.workspacePath, absolute)) {
    try {
      lstatSync(absolute);
    } catch {
      return {
        ok: false,
        reason: `${absolute} ${UNMATERIALIZED_HINT}`,
        returnCode: ToolReturnCode.NotFound,
      };
    }
    return { ok: true, path: { absolute, outsideWorkspace: false } };
  }
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

export function workspaceRootAbsolute(workspacePath: string): string {
  return resolve(workspacePath);
}

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

export function abortIfSignaled(
  signal: AbortSignal | undefined,
): ToolExecuteResult | null {
  if (signal?.aborted) return cancelledResult();
  return null;
}
