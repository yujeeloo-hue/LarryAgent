import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findUproject } from "../unreal/uproject.js";
import { recipeFromPackage, type ElectronPackageJson } from "../electron/manifest.js";
import { DEV_TASKS_FILE_REL } from "../main/devTaskConfig.js";

export type SuggestedTaskDef = {
  command: string;
  cwd?: string;
  openAfter?: string;
  mac?: { command?: string; openAfter?: string };
  win?: { command?: string; openAfter?: string };
};

export type SuggestedDevTasksFile = {
  version: 1;
  tasks: Record<string, SuggestedTaskDef>;
};

export type SuggestedDevTasksKind = "unreal" | "electron" | "web" | "node";

export type SuggestedDevTasks = {
  kind: SuggestedDevTasksKind;
  file: SuggestedDevTasksFile;
};

const MAC_BUILD_SCRIPTS = ["dist:mac", "build:mac", "package:mac", "pack:mac"];
const WIN_BUILD_SCRIPTS = ["dist:win", "build:win", "package:win", "pack:win"];
const GENERIC_BUILD_SCRIPTS = ["dist", "build", "package", "pack"];
const RUN_SCRIPTS = ["dev", "start"];
const OUTPUT_DIRS = ["dist", "out", "build", "release"];
const PACKAGING_SCRIPT_RE = /^(dist|package|pack)(:|$)/;
const TOOLCHAIN_OUT: Array<[string, string | null]> = [
  ["electron-builder", "dist"],
  ["electron-vite", "out"],
  ["vite", "dist"],
  ["react-scripts", "build"],
  ["next", null],
  ["astro", "dist"],
];
const BUILDER_CONFIG_FILES = [
  "electron-builder.yml",
  "electron-builder.yaml",
  "electron-builder.json",
  "electron-builder.json5",
  "electron-builder.jsonc",
];
const NESTED_SKIP = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  "release",
  "coverage",
  "docs",
  "public",
  ".git",
  ".svn",
  ".larry",
]);
const WEB_TOOLS = [
  "vite",
  "next",
  "react-scripts",
  "astro",
  "webpack",
  "parcel",
  "@angular/cli",
  "nuxt",
];

type PkgJson = ElectronPackageJson & { build?: unknown };
type Scripts = Record<string, string>;

function isPlainRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readPackageJson(dir: string): PkgJson | null {
  try {
    const text = readFileSync(join(dir, "package.json"), "utf8");
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (!isPlainRec(parsed)) return null;
    return parsed as PkgJson;
  } catch {
    return null;
  }
}

function scriptMap(pkg: PkgJson): Scripts {
  if (!isPlainRec(pkg.scripts)) return {};
  const out: Scripts = {};
  for (const [key, value] of Object.entries(pkg.scripts)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function depSet(pkg: PkgJson): Set<string> {
  const names = new Set<string>();
  for (const field of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
    if (!isPlainRec(field)) continue;
    for (const key of Object.keys(field)) names.add(key);
  }
  return names;
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function packageManager(projectDir: string): string {
  const has = (name: string) => existsSync(join(projectDir, name));
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("bun.lock") || has("bun.lockb")) return "bun";
  return "npm";
}

function firstScript(scripts: Scripts, names: string[]): string | null {
  for (const name of names) {
    if (scripts[name] !== undefined) return name;
  }
  return null;
}

function suggestBuildTask(
  scripts: Scripts,
  pm: string,
  pkg: PkgJson,
  projectDir: string,
  nestedPrefix: string,
): SuggestedTaskDef | null {
  const macScript = firstScript(scripts, MAC_BUILD_SCRIPTS);
  const winScript = firstScript(scripts, WIN_BUILD_SCRIPTS);
  const genericScript = firstScript(scripts, GENERIC_BUILD_SCRIPTS);
  const baseScript = genericScript ?? macScript ?? winScript;
  if (!baseScript) return null;

  const run = (script: string) => `${pm} run ${script}`;
  const def: SuggestedTaskDef = { command: run(baseScript) };
  if (macScript && macScript !== baseScript) {
    def.mac = { command: run(macScript) };
  }
  if (winScript && winScript !== baseScript) {
    def.win = { command: run(winScript) };
  }
  const dir = suggestOutputDir(
    projectDir,
    pkg,
    PACKAGING_SCRIPT_RE.test(baseScript) ||
      (macScript !== null && PACKAGING_SCRIPT_RE.test(macScript)) ||
      (winScript !== null && PACKAGING_SCRIPT_RE.test(winScript)),
  );
  if (dir) def.openAfter = `${nestedPrefix}${dir}`;
  return def;
}

function suggestOutputDir(
  projectDir: string,
  pkg: PkgJson,
  packaging: boolean,
): string | null {
  if (packaging) {
    if (depSet(pkg).has("electron-builder")) {
      return builderOutputDir(projectDir, pkg) ?? "dist";
    }
  }
  for (const rel of OUTPUT_DIRS) {
    if (existsSync(join(projectDir, rel))) return rel;
  }
  const deps = depSet(pkg);
  for (const [name, dir] of TOOLCHAIN_OUT) {
    if (deps.has(name)) return dir;
  }
  return null;
}

function builderOutputDir(projectDir: string, pkg: PkgJson): string | null {
  if (isPlainRec(pkg.build)) {
    const dirs = (pkg.build as Record<string, unknown>).directories;
    if (
      isPlainRec(dirs) &&
      typeof dirs.output === "string" &&
      dirs.output.trim()
    ) {
      return dirs.output.trim();
    }
  }
  for (const name of BUILDER_CONFIG_FILES) {
    const path = join(projectDir, name);
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8");
      const parsed = /\.json5?$/.test(name)
        ? jsonOutputDir(text)
        : yamlOutputDir(text);
      if (parsed) return parsed;
    } catch {
    }
  }
  return null;
}

function yamlOutputDir(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let inDirectories = false;
  let directoriesIndent = -1;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (inDirectories && indent <= directoriesIndent) return null;
    if (!inDirectories) {
      if (/^directories:\s*$/.test(line)) {
        inDirectories = true;
        directoriesIndent = indent;
      }
      continue;
    }
    const match = /^\s*output:\s*["']?([^"'\s#]+)["']?/.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

function jsonOutputDir(text: string): string | null {
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, "").replace(/\/\/.*$/gm, ""));
    if (!isPlainRec(parsed) || !isPlainRec(parsed.directories)) return null;
    const output = (parsed.directories as Record<string, unknown>).output;
    return typeof output === "string" && output.trim() ? output.trim() : null;
  } catch {
    return null;
  }
}

function resolveProjectDir(workspacePath: string): {
  projectDir: string;
  nestedPrefix: string;
} | null {
  if (existsSync(join(workspacePath, "package.json"))) {
    return { projectDir: workspacePath, nestedPrefix: "" };
  }
  let children: string[];
  try {
    children = readdirSync(workspacePath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !NESTED_SKIP.has(e.name) && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
  for (const child of children) {
    const dir = join(workspacePath, child);
    const pkg = readPackageJson(dir);
    if (!pkg) continue;
    const scripts = scriptMap(pkg);
    if (
      firstScript(scripts, RUN_SCRIPTS) ||
      firstScript(scripts, GENERIC_BUILD_SCRIPTS) ||
      firstScript(scripts, MAC_BUILD_SCRIPTS) ||
      firstScript(scripts, WIN_BUILD_SCRIPTS)
    ) {
      return { projectDir: dir, nestedPrefix: `${child}/` };
    }
  }
  return null;
}

export function suggestDevTasks(
  workspacePath: string,
): SuggestedDevTasks | null {
  if (findUproject(workspacePath)) {
    return { kind: "unreal", file: { version: 1, tasks: {} } };
  }

  const located = resolveProjectDir(workspacePath);
  if (!located) return null;
  const { projectDir, nestedPrefix } = located;
  const pkg = readPackageJson(projectDir);
  if (!pkg) return null;

  const scripts = scriptMap(pkg);
  const files = listFiles(projectDir);
  const pm = packageManager(projectDir);
  const tasks: SuggestedDevTasksFile["tasks"] = {};

  const withCwd = (def: SuggestedTaskDef): SuggestedTaskDef =>
    nestedPrefix ? { ...def, cwd: nestedPrefix.replace(/\/$/, "") } : def;

  const runScript = firstScript(scripts, RUN_SCRIPTS);
  if (runScript) tasks.run = withCwd({ command: `${pm} run ${runScript}` });

  const hasBuildScript =
    firstScript(scripts, GENERIC_BUILD_SCRIPTS) !== null ||
    firstScript(scripts, MAC_BUILD_SCRIPTS) !== null ||
    firstScript(scripts, WIN_BUILD_SCRIPTS) !== null;
  if (hasBuildScript) {
    const build = suggestBuildTask(scripts, pm, pkg, projectDir, nestedPrefix);
    if (build) tasks.build = withCwd(build);
  }

  if (Object.keys(tasks).length === 0) return null;

  if (recipeFromPackage(pkg, files)) {
    return { kind: "electron", file: { version: 1, tasks } };
  }
  const deps = depSet(pkg);
  const isWeb = WEB_TOOLS.some((name) => deps.has(name));
  return { kind: isWeb ? "web" : "node", file: { version: 1, tasks } };
}

export type EnsureDevTasksStatus = "created" | "exists" | "skipped" | "failed";

export async function ensureDevTasksConfig(
  workspacePath: string,
): Promise<EnsureDevTasksStatus> {
  try {
    await stat(join(workspacePath, DEV_TASKS_FILE_REL));
    return "exists";
  } catch {
  }
  let suggestion: SuggestedDevTasks | null;
  try {
    suggestion = suggestDevTasks(workspacePath);
  } catch (err) {
    console.error(
      `[devtasks] suggest failed for ${workspacePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "failed";
  }
  if (!suggestion) return "skipped";
  try {
    await mkdir(join(workspacePath, ".larry"), { recursive: true });
    await writeFile(
      join(workspacePath, DEV_TASKS_FILE_REL),
      `${JSON.stringify(suggestion.file, null, 2)}\n`,
      "utf8",
    );
    return "created";
  } catch (err) {
    console.error(
      `[devtasks] could not write ${DEV_TASKS_FILE_REL} for ${workspacePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "failed";
  }
}
