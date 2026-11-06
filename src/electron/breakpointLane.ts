import { basename, relative } from "node:path";

export type BreakpointLane = "main" | "renderer" | "all";

function posixRel(projectRoot: string, filePath: string): string {
  return relative(projectRoot, filePath).replace(/\\/g, "/");
}

function under(rel: string, folder: string): boolean {
  const prefix = `${folder}/`;
  return rel === folder || rel.startsWith(prefix);
}

/**
 * Which Electron debug session(s) should receive a gutter breakpoint.
 * Paths outside the project (or shared code) fan out to every live session.
 */
export function breakpointLane(filePath: string, projectRoot: string): BreakpointLane {
  const rel = posixRel(projectRoot, filePath);
  if (!rel || rel.startsWith("..")) return "all";
  const lower = rel.replace(/\\/g, "/");
  const file = basename(lower);
  if (/^electron\.vite\.config\./i.test(file)) return "main";
  if (under(lower, "src/main")) return "main";
  if (under(lower, "src/preload")) return "all";
  if (under(lower, "src/renderer") || /\.html?$/i.test(lower)) return "renderer";
  return "all";
}
