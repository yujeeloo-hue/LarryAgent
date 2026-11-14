import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { resolveToolPath } from "../pathUtil.js";
import { classifyPathTarget } from "./trustDomain.js";
import { extractV4aPaths } from "../patch/index.js";
import type { JsonObject, ToolRiskAssessment, ToolRiskAssessor } from "../types.js";

/**
 * Shared Safe-Mode assessor for path-writing file tools: a literal
 * absolute path inside the workspace trust domain is allowed without
 * approval; everything else defers to the legacy level matrix
 * (outside-workspace writes still need Bypass).
 */

export function assessFileWriteRisk(input: {
  arguments: JsonObject;
  fullPermissionsEnabled: boolean;
  reviewHighRisk?: boolean;
  workspacePath?: string;
}): ToolRiskAssessment {
  const pathArg = typeof input.arguments.path === "string" ? input.arguments.path : null;
  if (!pathArg || !pathArg.trim()) return { action: "defer" };
  const workspaceRoot = input.workspacePath?.trim();
  if (!workspaceRoot) return { action: "defer" };
  const abs = isAbsolute(pathArg) ? resolve(pathArg) : resolve(workspaceRoot, pathArg);
  if (pathInWorkspace(abs, workspaceRoot)) return { action: "allow" };
  return sensitiveWriteReview([abs], input) ?? { action: "defer" };
}

/**
 * Supervised turns under Bypass: a write into a sensitive (credential /
 * system) location goes to the supervisor instead of passing on level 1.
 */
function sensitiveWriteReview(
  paths: readonly string[],
  input: { fullPermissionsEnabled: boolean; reviewHighRisk?: boolean; workspacePath?: string },
): ToolRiskAssessment | null {
  if (!input.fullPermissionsEnabled || input.reviewHighRisk !== true) return null;
  const workspaceRoot = input.workspacePath?.trim() ?? "";
  const hit = paths.find((p) => !inTempDir(p) && classifyPathTarget({ absolutePath: p, workspaceRoot, homeDir: homedir() }) === "sensitive");
  if (!hit) return null;
  return {
    action: "confirm",
    fatal: false,
    reason: `Writes ${hit}, a sensitive credential or system location.`,
    hint: "Write inside the workspace unless this change was explicitly requested.",
  };
}

/** Typed wrapper for ToolDefinition.assessRisk attachment. */
export const fileWriteRiskAssessor: ToolRiskAssessor = (input) =>
  assessFileWriteRisk(input);

/** macOS temp lives under /var/folders (a sensitive prefix); scratch writes there are not credential writes. */
function inTempDir(path: string): boolean {
  const roots = new Set([resolve(tmpdir())]);
  try { roots.add(realpathSync(tmpdir())); } catch { /* keep the raw root */ }
  const p = resolve(path);
  return [...roots].some((root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep));
}

function pathInWorkspace(raw: string, workspaceRoot: string): boolean {
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(workspaceRoot, raw);
  return resolveToolPath(abs, {
    workspacePath: workspaceRoot,
    allowOutsideWorkspace: false,
  }).ok;
}

/**
 * Safe-Mode assessor for patch: replace mode uses `path`; V4A mode
 * extracts every Update/Add/Delete/Move header. All targets must resolve
 * inside the workspace trust domain.
 */
export const patchFileRiskAssessor: ToolRiskAssessor = (input) => {
  const workspaceRoot = input.workspacePath?.trim();
  if (!workspaceRoot) return { action: "defer" };

  const mode = input.arguments.mode;
  const patchBody =
    typeof input.arguments.patch === "string" ? input.arguments.patch : null;
  const isV4a =
    mode === "patch" ||
    (patchBody !== null && input.arguments.old_string === undefined);

  if (isV4a) {
    if (!patchBody) return { action: "defer" };
    const paths = extractV4aPaths(patchBody);
    if (paths.length === 0) return { action: "defer" };
    const outside = paths.filter((p) => !pathInWorkspace(p, workspaceRoot));
    if (outside.length === 0) return { action: "allow" };
    return sensitiveWriteReview(outside.map((p) => (isAbsolute(p) ? resolve(p) : resolve(workspaceRoot, p))), input) ?? { action: "defer" };
  }

  return assessFileWriteRisk(input);
};
