import { isAbsolute, relative, resolve } from "node:path";
import type { JsonObject } from "../session/types.js";

export type GuardProject = { id: string; name: string; path: string };

const within = (root: string, path: string): boolean => {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const V4A_FILE = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$|^\*\*\* Move to:\s*(.+?)\s*$/gm;

/** Paths a mutating commander tool would touch, resolved against `cwd`. Shell is matched by root substring instead. */
export function mutationPaths(name: string, args: JsonObject, cwd: string): string[] {
  const at = (value: unknown): string[] => typeof value === "string" && value.trim() ? [resolve(cwd, value.trim())] : [];
  if (name === "write_file") return at(args.path);
  if (name === "convert_to_pdf") return at(args.output);
  if (name === "patch") {
    const body = typeof args.patch === "string" ? args.patch : "";
    return [...at(args.path), ...[...body.matchAll(V4A_FILE)].flatMap(m => at(m[1] ?? m[2]))];
  }
  return [];
}

/**
 * The first project that a write / shell would touch while that project has an
 * active turn. CoCo must then steer or append into that session instead of
 * editing files underneath it.
 */
export function busyProjectFor(name: string, args: JsonObject, cwd: string, projects: GuardProject[], hasActiveTurn: (workspaceId: string) => boolean): GuardProject | undefined {
  const paths = mutationPaths(name, args, cwd);
  const command = name === "run_shell" && typeof args.command === "string" ? args.command : "";
  if (name === "update_project_memory" && typeof args.workspace_id === "string") {
    const target = projects.find(p => p.id === args.workspace_id);
    return target && hasActiveTurn(target.id) ? target : undefined;
  }
  if (!paths.length && !command) return undefined;
  // Longest root first so a nested project wins over its parent.
  const ordered = [...projects].sort((a, b) => b.path.length - a.path.length);
  const touched = new Set<GuardProject>();
  for (const path of paths) { const hit = ordered.find(p => within(p.path, path)); if (hit) touched.add(hit); }
  if (command) for (const p of ordered) if (command.includes(resolve(p.path))) touched.add(p);
  return [...touched].find(p => hasActiveTurn(p.id));
}

export function busyProjectMessage(project: GuardProject): string {
  return `Project "${project.name}" has an active session, so CoCo does not edit its files or run commands in it directly. Send the change to that session with coco_work action "submit" (executionSessionId + sessionStrategy "steer" or "append"), or wait until it is idle.`;
}
