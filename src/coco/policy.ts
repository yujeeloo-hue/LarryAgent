import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../session/types.js";

const inside = (root: string, path: string): boolean => { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
export function canonicalCocoPath(path: string): string {
  try { return realpathSync.native(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { lstatSync(path); throw new Error("Unresolvable symbolic link"); }
    catch (statError) { if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError; }
    const parent = dirname(path); if (parent === path) throw error;
    return resolve(canonicalCocoPath(parent), relative(parent, path));
  }
}
export class CocoPathError extends Error {
  constructor(readonly path: string, readonly projectRoot: string, readonly code: "excluded_project" | "other_project" | "outside_project") {
    super(code === "excluded_project" ? `This path belongs to an excluded project: ${path}` : code === "other_project" ? `This path belongs to another project: ${path}. Each piece of work runs inside its own project session; plan cross-project goals as separate per-project work items.` : `Path is outside project ${projectRoot}: ${path}. Use '.' for its root or a project-relative path.`);
  }
}
/** A denied project root: excluded projects are out of CoCo scope; other projects are in scope but belong to a different work session. */
export type CocoDeniedRoot = { path: string; code: "excluded_project" | "other_project" };
export function createCocoPolicy(root: string, excludedRoots: (string | CocoDeniedRoot)[], canWrite: boolean, valid: () => boolean, capabilities?: { fullAccess?: boolean; assertMcp?(name: string, args: JsonObject): void }) {
  const rootPath = canonicalCocoPath(resolve(root));
  const denied = excludedRoots.map(entry => typeof entry === "string" ? { path: entry, code: "excluded_project" as const } : entry).map(({ path, code }) => ({ lexical: resolve(path), canonical: canonicalCocoPath(resolve(path)), code }));
  const assertPath = (path: string): void => {
    if (!valid()) throw new Error("CoCo authorization changed or application is stopping");
    const lexical = resolve(root, path.startsWith("file:") ? fileURLToPath(path) : path), target = canonicalCocoPath(lexical);
    const hit = denied.find(p => inside(p.lexical, lexical) || inside(p.canonical, target));
    if (hit) throw new CocoPathError(lexical, rootPath, hit.code);
    if (!capabilities?.fullAccess && !inside(rootPath, target)) throw new CocoPathError(lexical, rootPath, "outside_project");
  };
  const assertArguments = (value: unknown, key = ""): void => {
    if (typeof value === "string" && (isAbsolute(value) || value.startsWith("file:") || /^(path|file_path|directory|cwd|root|src|dest|source|target)$/i.test(key))) assertPath(value);
    else if (Array.isArray(value)) value.forEach(v => assertArguments(v, key));
    else if (value && typeof value === "object") Object.entries(value).forEach(([k,v]) => assertArguments(v,k));
  };
  return {
    assertPath,
    assertTool(name: string, args: JsonObject): void {
      if (!valid()) throw new Error("CoCo execution was revoked");
      // Execution uses ordinary Larry Agent tools and permission checks.
      if (["write_file", "patch", "write_plan_doc"].includes(name) && !canWrite) throw new Error("This work is running in read-only mode");
      assertArguments(args);
      if (name.startsWith("mcp__")) capabilities?.assertMcp?.(name,args);
      if (["read_file", "list_dir", "grep", "glob", "write_file", "patch", "write_plan_doc", "adopt_plan_doc"].includes(name)) assertPath(typeof args.path === "string" ? args.path : root);
      if (name === "grep" || name === "glob") {
        const searchRoot = canonicalCocoPath(resolve(root, typeof args.path === "string" ? args.path : "."));
        if (denied.some(p => inside(searchRoot,p.canonical))) throw new Error("This search includes an excluded project. Search a specific non-excluded directory instead.");
      }
    },
  };
}
