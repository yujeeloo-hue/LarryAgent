import { spawn } from "node:child_process";
import { join } from "node:path";
import { ripgrepExcludeGlobs } from "../../workspaceScan/policy.js";
import { resolveRipgrep } from "../../workspaceScan/ripgrep.js";

export const LUA_SCRIPT_ROOT_LIMIT = 12;
const LIST_TIMEOUT_MS = 15_000;
const GENERATED_DIRS = ["intermediate", "binaries", "deriveddatacache", "saved"];

function caseInsensitiveGlob(name: string): string {
  let out = "";
  for (const ch of name) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    out += lower === upper ? ch : `[${lower}${upper}]`;
  }
  return out;
}

export function luaListArgs(): string[] {
  const args = ["--files", "--hidden", "--no-messages", "--glob", "*.lua", "--glob", "!**/.*/**"];
  for (const glob of ripgrepExcludeGlobs({ mode: "walk", unreal: false })) args.push("--glob", glob);
  for (const dir of GENERATED_DIRS) args.push("--glob", `!**/${caseInsensitiveGlob(dir)}/**`);
  return args;
}

export function luaScriptRootsFromFiles(rels: Iterable<string>, limit = LUA_SCRIPT_ROOT_LIMIT): string[] {
  const counts = new Map<string, number>();
  for (const raw of rels) {
    const rel = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    const slash = rel.lastIndexOf("/");
    if (slash <= 0) continue;
    const dir = rel.slice(0, slash);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const roots = new Map<string, number>();
  for (const dir of [...counts.keys()].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
    const lower = dir.toLowerCase();
    const owner = [...roots.keys()].find((root) => lower.startsWith(`${root.toLowerCase()}/`));
    if (owner) roots.set(owner, roots.get(owner)! + counts.get(dir)!);
    else roots.set(dir, counts.get(dir)!);
  }
  return [...roots.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([dir]) => dir)
    .sort((a, b) => a.localeCompare(b));
}

export async function findLuaScriptRoots(workspaceRoot: string, program?: string): Promise<string[]> {
  const rg = program ?? (await resolveRipgrep());
  const rels: string[] = [];
  await new Promise<void>((resolve) => {
    let buffer = "";
    const child = spawn(rg, luaListArgs(), { cwd: workspaceRoot, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => child.kill(), LIST_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line) rels.push(line);
    });
    const done = () => {
      clearTimeout(timer);
      if (buffer) rels.push(buffer);
      resolve();
    };
    child.on("error", done);
    child.on("close", done);
  });
  return luaScriptRootsFromFiles(rels).map((rel) => join(workspaceRoot, ...rel.split("/")));
}
