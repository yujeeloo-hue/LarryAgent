import { basename, relative } from "node:path";
import type { BreakpointLane } from "../electron/breakpointLane.js";

function posixRel(projectRoot: string, filePath: string): string {
  return relative(projectRoot, filePath).replace(/\\/g, "/");
}

function under(rel: string, folder: string): boolean {
  const prefix = `${folder}/`;
  return rel === folder || rel.startsWith(prefix);
}

const SERVER_FOLDERS = [
  "server",
  "backend",
  "api",
  "src/server",
  "src/backend",
  "src/api",
  "apps/server",
  "apps/api",
  "apps/backend",
  "packages/server",
  "packages/api",
];

const PAGE_FOLDERS = [
  "client",
  "web",
  "frontend",
  "public",
  "src/client",
  "src/web",
  "src/frontend",
  "apps/web",
  "apps/client",
  "apps/frontend",
  "packages/web",
  "packages/client",
];

const PAGE_EXT = /\.(html?|css|scss|sass|less|vue|svelte)$/i;

/**
 * Which web debug session(s) should receive a gutter breakpoint.
 * Server folders → Node; client/page folders → Chrome; shared code → both.
 */
export function webBreakpointLane(
  filePath: string,
  projectRoot: string,
): BreakpointLane {
  const rel = posixRel(projectRoot, filePath);
  if (!rel || rel.startsWith("..")) return "all";
  const lower = rel.replace(/\\/g, "/");
  if (SERVER_FOLDERS.some((folder) => under(lower, folder))) return "main";
  if (PAGE_FOLDERS.some((folder) => under(lower, folder))) return "renderer";
  if (PAGE_EXT.test(basename(lower)) || PAGE_EXT.test(lower)) return "renderer";
  return "all";
}
