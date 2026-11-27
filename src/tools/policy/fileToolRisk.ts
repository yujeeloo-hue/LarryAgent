import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { resolveToolPath } from "../pathUtil.js";
import { classifyPathTarget } from "./trustDomain.js";
import { extractV4aPaths } from "../patch/index.js";
import type { JsonObject, ToolRiskAssessment, ToolRiskAssessor } from "../types.js";


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

export const fileWriteRiskAssessor: ToolRiskAssessor = (input) =>
  assessFileWriteRisk(input);

function inTempDir(path: string): boolean {
  const roots = new Set([resolve(tmpdir())]);
  try { roots.add(realpathSync(tmpdir())); } catch {  }
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
