import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { agentLogInfo, agentLogWarn } from "../../logging/agentLog.js";
import { isUnrealProjectRoot } from "../../unreal/engineRoot.js";
import { UNREAL_UBT_TIMEOUT_MS } from "../../unreal/launchContext.js";
import { resolveBuildScript, ubtPlatformFor } from "../../unreal/ubtCommand.js";
import { getUnrealWorkspace } from "../../unreal/workspace.js";
import type { UnrealBuildChoice, UnrealWorkspace } from "../../unreal/workspaceTypes.js";
import { findCompileDb } from "./locate.js";

const STAMP_NAME = "compile_commands.stamp.json";
const DB_NAME = "compile_commands.json";
const SOURCE_STAMP_NAME = "compile_commands.source.json";
const CURRENT_STAMP_VERSION = 4;
const SKIP_DIRS = new Set([
  "intermediate",
  "binaries",
  "saved",
  "deriveddatacache",
  "node_modules",
  ".git",
  ".svn",
]);

export type CompileDbStamp = {
  version: 1 | 2 | 3 | 4;
  target: string;
  platform: string;
  configuration: string;
  engineRoot: string;
  fingerprint: string;
};

export type CompileDbPlan = {
  workspacePath: string;
  script: string;
  args: string[];
  outputDir: string;
  outputFile: string;
  stamp: CompileDbStamp;
  hasProjectSources: boolean;
};

export type CompileDbGenerateResult =
  | { ok: true; outputFile: string; skipped: boolean }
  | { ok: false; message: string };

const jobs = new Map<string, Promise<CompileDbGenerateResult>>();

export function compileDatabaseInFlight(workspacePath: string): boolean {
  return jobs.has(keyOf(workspacePath));
}

export function compileDbOutputDir(workspacePath: string): string {
  return join(workspacePath, ".jellybot");
}

export function isProjectCompileDbDir(workspacePath: string, compileCommandsDir: string): boolean {
  return keyOf(compileCommandsDir) === keyOf(compileDbOutputDir(workspacePath));
}

export function compileDbArguments(input: {
  target: string;
  platform: string;
  configuration: string;
  uproject: string | null;
  outputDir: string;
}): string[] {
  return [
    "-Mode=GenerateClangDatabase",
    ...(input.uproject ? [`-Project=${input.uproject}`] : []),
    input.target,
    input.platform,
    input.configuration,
    `-OutputDir=${input.outputDir}`,
    `-OutputFilename=${DB_NAME}`,
    "-WaitMutex",
  ];
}

export function windowsCompileCommand(script: string, args: string[]): string {
  const quote = (part: string) => `"${part.replace(/"/g, '""')}"`;
  return `call ${[script, ...args].map(quote).join(" ")}`;
}

export function compileDbFingerprint(input: {
  uprojectText: string;
  rules: Array<{ path: string; text: string }>;
  sourcePaths: string[];
}): string {
  const hash = createHash("sha256");
  hash.update(input.uprojectText);
  hash.update("\0");
  const rules = [...input.rules].sort((a, b) => a.path.localeCompare(b.path));
  for (const rule of rules) {
    hash.update(rule.path.replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(rule.text);
    hash.update("\0");
  }
  for (const path of [...input.sourcePaths].map((p) => p.replace(/\\/g, "/")).sort()) {
    hash.update(path);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function readCompileDbStamp(workspacePath: string): CompileDbStamp | null {
  try {
    const parsed = JSON.parse(readFileSync(join(compileDbOutputDir(workspacePath), STAMP_NAME), "utf8")) as Partial<CompileDbStamp>;
    if (
      ![1, 2, 3, 4].includes(parsed.version ?? 0) ||
      typeof parsed.target !== "string" ||
      typeof parsed.platform !== "string" ||
      typeof parsed.configuration !== "string" ||
      typeof parsed.engineRoot !== "string" ||
      typeof parsed.fingerprint !== "string"
    ) {
      return null;
    }
    return parsed as CompileDbStamp;
  } catch {
    return null;
  }
}

function compileDbStampInputsMatch(saved: CompileDbStamp | null, next: CompileDbStamp): boolean {
  return !!saved
    && saved.target === next.target
    && saved.platform === next.platform
    && saved.configuration === next.configuration
    && saved.engineRoot === next.engineRoot
    && saved.fingerprint === next.fingerprint;
}

export function compileDbStampMatches(saved: CompileDbStamp | null, next: CompileDbStamp): boolean {
  return !!saved && saved.version === next.version && compileDbStampInputsMatch(saved, next);
}

function legacySource(workspacePath: string): { present: boolean; file: string | null } {
  const path = join(compileDbOutputDir(workspacePath), SOURCE_STAMP_NAME);
  if (!existsSync(path)) return { present: false, file: null };
  try {
    const stamp = JSON.parse(readFileSync(path, "utf8")) as { sourceFile?: unknown };
    const ownFile = join(compileDbOutputDir(workspacePath), DB_NAME);
    const file = typeof stamp.sourceFile === "string"
      && keyOf(stamp.sourceFile) !== keyOf(ownFile)
      && existsSync(stamp.sourceFile) ? stamp.sourceFile : null;
    return { present: true, file };
  } catch {
    return { present: true, file: null };
  }
}

function keyOf(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pickEditorChoice(model: UnrealWorkspace): UnrealBuildChoice | null {
  const host = ubtPlatformFor(process.platform);
  const editors = model.choices.filter((choice) =>
    choice.kind === "native"
    && choice.targetType === "Editor"
    && choice.platform === host
    && !choice.runReason);
  return editors.find((choice) => choice.id === model.selectedId)
    ?? editors.find((choice) => choice.configuration === "DebugGame")
    ?? editors.find((choice) => choice.configuration === "Development")
    ?? editors[0]
    ?? null;
}

function collectProjectInputs(projectRoot: string, uproject: string | null): {
  uprojectText: string;
  rules: Array<{ path: string; text: string }>;
  sourcePaths: string[];
} {
  let uprojectText = "";
  if (uproject) {
    try { uprojectText = readFileSync(uproject, "utf8"); } catch { uprojectText = ""; }
  }
  const rules: Array<{ path: string; text: string }> = [];
  const sourcePaths: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(projectRoot, path);
      if (/\.(?:Build|Target)\.cs$/i.test(entry.name)) {
        let text = "";
        try { text = readFileSync(path, "utf8"); } catch { text = ""; }
        rules.push({ path: rel, text });
      } else if (/\.(?:cpp|cc|cxx|c|h|hpp|inl)$/i.test(entry.name)) {
        sourcePaths.push(rel);
      }
    }
  };
  walk(join(projectRoot, "Source"));
  walk(join(projectRoot, "Plugins"));
  return { uprojectText, rules, sourcePaths };
}

export async function planCompileDatabase(workspacePath: string): Promise<CompileDbPlan | null> {
  if (!isUnrealProjectRoot(workspacePath)) return null;
  const model = await getUnrealWorkspace(workspacePath);
  const choice = model ? pickEditorChoice(model) : null;
  if (!choice || !model?.engineRoot) return null;
  const script = resolveBuildScript(choice.engineRoot, process.platform);
  if (!existsSync(script)) return null;
  const outputDir = compileDbOutputDir(workspacePath);
  const inputs = collectProjectInputs(choice.projectRoot, choice.uproject);
  const stamp: CompileDbStamp = {
    version: CURRENT_STAMP_VERSION,
    target: choice.target,
    platform: choice.platform,
    configuration: choice.configuration,
    engineRoot: resolve(choice.engineRoot),
    fingerprint: compileDbFingerprint(inputs),
  };
  return {
    workspacePath,
    script,
    args: compileDbArguments({
      target: choice.target,
      platform: choice.platform,
      configuration: choice.configuration,
      uproject: choice.uproject,
      outputDir,
    }),
    outputDir,
    outputFile: join(outputDir, DB_NAME),
    stamp,
    hasProjectSources: inputs.sourcePaths.length > 0 || inputs.rules.length > 0,
  };
}

function writeStamp(plan: CompileDbPlan): void {
  mkdirSync(plan.outputDir, { recursive: true });
  writeFileSync(join(plan.outputDir, STAMP_NAME), JSON.stringify(plan.stamp, null, 2), "utf8");
  try { rmSync(join(plan.outputDir, SOURCE_STAMP_NAME), { force: true }); } catch {  }
}

export function ensureProjectCompileDatabase(
  workspacePath: string,
  onProgress?: (line: string) => void,
  exists: (path: string) => boolean = existsSync,
): Promise<CompileDbGenerateResult> {
  const key = keyOf(workspacePath);
  const running = jobs.get(key);
  if (running) return running;
  const job = runEnsure(workspacePath, onProgress, exists).finally(() => {
    if (jobs.get(key) === job) jobs.delete(key);
  });
  jobs.set(key, job);
  return job;
}

async function runEnsure(
  workspacePath: string,
  onProgress: ((line: string) => void) | undefined,
  exists: (path: string) => boolean,
): Promise<CompileDbGenerateResult> {
  const rootDb = join(workspacePath, DB_NAME);
  if (exists(rootDb)) return { ok: true, outputFile: rootDb, skipped: true };
  if (!isUnrealProjectRoot(workspacePath)) {
    return { ok: true, outputFile: "", skipped: true };
  }
  const ownFile = join(compileDbOutputDir(workspacePath), DB_NAME);
  const saved = readCompileDbStamp(workspacePath);
  const source = legacySource(workspacePath);
  const plan = await planCompileDatabase(workspacePath);
  if (plan && exists(ownFile) && compileDbStampMatches(saved, plan.stamp)) {
    return { ok: true, outputFile: ownFile, skipped: true };
  }
  if (plan && exists(ownFile) && saved?.version === 1 && compileDbStampInputsMatch(saved, plan.stamp)) {
    writeStamp(plan);
    return { ok: true, outputFile: ownFile, skipped: true };
  }
  if (exists(ownFile) && !source.present && !saved) {
    return { ok: true, outputFile: ownFile, skipped: true };
  }
  const inputs = plan ? null : collectProjectInputs(workspacePath, null);
  const hasProjectSources = plan?.hasProjectSources
    ?? !!(inputs && (inputs.sourcePaths.length || inputs.rules.length));
  if (!hasProjectSources) {
    if (source.file) return { ok: true, outputFile: source.file, skipped: true };
    const external = await findCompileDb(workspacePath, { skipProjectDb: true });
    if (external) {
      return { ok: true, outputFile: join(external.compileCommandsDir, DB_NAME), skipped: true };
    }
  }
  if (!plan) {
    if (exists(ownFile) && !source.present && (saved?.version === 1 || saved?.version === CURRENT_STAMP_VERSION)) {
      return { ok: true, outputFile: ownFile, skipped: true };
    }
    return { ok: false, message: "The Unreal editor target is unavailable. A complete compile_commands.json is required; a previously filtered database cannot be restored without UBT or its original database." };
  }
  return runPlan(plan, onProgress);
}

function notableLine(line: string): boolean {
  return /Creating target|Executing actions that produce|Filtering compile actions|Writing database|ClangDatabase written/i.test(line);
}

function runPlan(plan: CompileDbPlan, onProgress?: (line: string) => void): Promise<CompileDbGenerateResult> {
  mkdirSync(plan.outputDir, { recursive: true });
  const label = `${plan.stamp.target} · ${plan.stamp.platform} · ${plan.stamp.configuration}`;
  onProgress?.(label);
  agentLogInfo("clangd.compile_db.start", {
    workspace: plan.workspacePath,
    script: plan.script,
    args: plan.args,
  });
  const child = process.platform === "win32"
    ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", windowsCompileCommand(plan.script, plan.args)], {
        windowsHide: true,
        windowsVerbatimArguments: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    : spawn(plan.script, plan.args, { stdio: ["ignore", "pipe", "pipe"] });

  const tail: string[] = [];
  const take = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      tail.push(text);
      if (tail.length > 30) tail.shift();
      if (notableLine(text)) onProgress?.(text.slice(0, 180));
    }
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);

  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (result: CompileDbGenerateResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, message: "Generating compile_commands.json timed out." });
    }, UNREAL_UBT_TIMEOUT_MS);
    child.once("error", (error) => {
      agentLogWarn("clangd.compile_db_spawn_failed", { message: error.message });
      finish({ ok: false, message: error.message });
    });
    child.once("exit", (code) => {
      if (code === 0 && existsSync(plan.outputFile)) {
        try {
          const entries: unknown = JSON.parse(readFileSync(plan.outputFile, "utf8"));
          if (!Array.isArray(entries) || entries.length === 0) throw new Error("UBT produced an empty or invalid compile database.");
          writeStamp(plan);
          agentLogInfo("clangd.compile_db.ready", { output: plan.outputFile, entries: entries.length });
          finish({ ok: true, outputFile: plan.outputFile, skipped: false });
        } catch (error) {
          finish({ ok: false, message: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      const detail = tail.slice(-8).join("\n");
      const message = detail
        ? `Generating compile_commands.json failed (exit ${code ?? "?"}).\n${detail}`
        : `Generating compile_commands.json failed (exit ${code ?? "?"}).`;
      agentLogWarn("clangd.compile_db_failed", { code, detail });
      finish({ ok: false, message });
    });
  });
}
