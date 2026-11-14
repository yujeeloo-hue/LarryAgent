import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, delimiter, join, resolve, sep } from "node:path";
import { parseSln, parseSlnConfigurations } from "../dotnet/slnParser.js";
import { resolveUeEngineSourceRoot, clearUeEngineRootCache } from "./engineRoot.js";
import { findUprojects } from "./uproject.js";
import { parseTargetCs } from "./targets.js";
import { buildUbtCommand, editorBinaryRel, quoteShellArg, resolveBuildScript, ubtPlatformFor } from "./ubtCommand.js";
import { parseNativeConfigurations, readRiderHeader, readText, resolveProjectPath } from "./projectMetadata.js";
import type { UnrealBuildChoice, UnrealProject, UnrealWorkspace } from "./workspaceTypes.js";

const ignored = new Set(["intermediate", "binaries", "saved", "content", "deriveddatacache", "node_modules", "bin", "obj"]);
const keyOf = (path: string): string => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const identity = (...parts: string[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);

/** Async, no target-count/depth truncation, and never follows directory symlinks. */
export async function discoverFiles(root: string, accept: (name: string) => boolean): Promise<string[]> {
  const result: string[] = [];
  let pending = [root];
  while (pending.length) {
    const batch = pending.splice(0, 16);
    const entries = await Promise.all(batch.map(async (dir) => {
      try { return { dir, entries: await readdir(dir, { withFileTypes: true }) }; }
      catch { return { dir, entries: [] }; }
    }));
    for (const { dir, entries: children } of entries) for (const item of children) {
      if (item.isDirectory() && !item.name.startsWith(".") && !ignored.has(item.name.toLowerCase())) pending.push(join(dir, item.name));
      else if (item.isFile() && accept(item.name)) result.push(join(dir, item.name));
    }
  }
  return result.sort();
}

async function filesAt(root: string, suffix: string): Promise<string[]> {
  try { return (await readdir(root, { withFileTypes: true })).filter(e => e.isFile() && e.name.toLowerCase().endsWith(suffix)).map(e => join(root, e.name)); }
  catch { return []; }
}

export async function findDotnet(engineRoot: string): Promise<string | null> {
  const exe = process.platform === "win32" ? "dotnet.exe" : "dotnet";
  // Match the engine bootstrap's pinned SDK before considering global installs.
  const host = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const setup = await readText(join(engineRoot, "Build", "BatchFiles", process.platform === "win32" ? "GetDotnetPath.bat" : `${process.platform === "darwin" ? "Mac" : "Linux"}/SetupDotnet.sh`));
  const pinned = /(?:set\s+UE_DOTNET_VERSION\s*=\s*|DotNet\/)(\d+\.\d+\.\d+)/i.exec(setup)?.[1];
  const bundledRoot = join(engineRoot, "Binaries", "ThirdParty", "DotNet");
  let versions: string[] = [];
  try { versions = (await readdir(bundledRoot)).filter(name => /^\d+\.\d+\.\d+$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); } catch { /* no bundled SDK */ }
  for (const version of [...new Set([...(pinned ? [pinned] : []), ...versions])]) {
    const candidate = join(bundledRoot, version, `${host}-${arch}`, exe);
    if (existsSync(candidate)) return candidate;
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory.trim()) continue;
    const candidate = join(directory, exe);
    if (existsSync(candidate)) return candidate;
  }
  const bundled = await discoverFiles(join(engineRoot, "Binaries", "ThirdParty", "DotNet"), name => name === exe);
  return bundled.find(p => p.replace(/\\/g, "/").split("/").includes(`${host}-${arch}`)) ?? null;
}

function isUnderPath(root: string, path: string): boolean {
  const base = resolve(root);
  const full = resolve(path);
  const fold = process.platform === "win32" || process.platform === "darwin";
  const prefix = fold ? base.toLowerCase() : base;
  const target = fold ? full.toLowerCase() : full;
  return target === prefix || target.startsWith(`${prefix}${sep}`);
}

function nativeChoice(input: Omit<UnrealBuildChoice, "id" | "command" | "buildReason" | "runReason" | "debugReason" | "kind">): UnrealBuildChoice {
  const script = resolveBuildScript(input.engineRoot, process.platform);
  const commandFor = (buildScript: string) => [{ target: input.target, platform: input.platform, configuration: input.configuration }, ...(input.additionalTargets ?? [])]
    .map(target => buildUbtCommand({ buildScript, editorTarget: target.target,
      uproject: input.uproject ?? "", os: process.platform, configuration: target.configuration,
      platform: target.platform, architecture: input.architecture })).join(" && ");
  let runReason: string | null = null;
  const host = ubtPlatformFor(process.platform);
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const architectures = input.architecture.replace(/x86_64/g, "x64").split("+");
  if (input.platform !== host || (input.architecture && !architectures.includes(arch))) runReason = "This machine cannot run the selected platform or architecture";
  else if (!input.output) runReason = "Executable information is unavailable. Regenerate the Unreal project files";
  // Like Rider / VS, a Game / Client / Server target launches its executable
  // as built; projects with their own content pipeline run without a cook.
  const runNote = ["Game", "Client", "Server"].includes(input.targetType) && !existsSync(join(input.projectRoot, "Saved", "Cooked"))
    ? "No cooked content found (Saved/Cooked). The target may need a cook to start"
    : undefined;
  const buildReason = existsSync(script) ? null : `Build script not found: ${script}`;
  const extension = process.platform === "win32" ? "bat" : "sh";
  return { ...input, id: identity(input.engineRoot, input.solution, input.project, input.target, input.configuration, input.platform, input.architecture),
    kind: "native", command: commandFor(script),
    rebuildCommand: commandFor(join(dirname(script), `Rebuild.${extension}`)),
    cleanCommand: commandFor(join(dirname(script), `Clean.${extension}`)),
    buildReason, runReason: buildReason ?? runReason, debugReason: buildReason ?? runReason,
    ...(runNote ? { runNote } : {}) };
}

const cache = new Map<string, { at: number; promise: Promise<UnrealWorkspace | null> }>();
const selections = new Map<string, string>();

export function rememberUnrealSelection(workspacePath: string, id: string): void { selections.set(keyOf(workspacePath), id); }
export function invalidateUnrealWorkspace(workspacePath: string): void { cache.delete(keyOf(workspacePath)); clearUeEngineRootCache(); }

export async function getUnrealWorkspace(workspacePath: string, refresh = false): Promise<UnrealWorkspace | null> {
  const key = keyOf(workspacePath);
  if (refresh) invalidateUnrealWorkspace(workspacePath);
  let entry = cache.get(key);
  if (!entry || Date.now() - entry.at > 30_000) {
    entry = { at: Date.now(), promise: discoverWorkspace(resolve(workspacePath)) };
    cache.set(key, entry);
    entry.promise.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
  }
  const model = await entry.promise;
  if (!model) return null;
  const selected = selections.get(key);
  return { ...model, selectedId: model.choices.some(c => c.id === selected) ? selected! : model.selectedId };
}

export async function selectedUnrealBuild(workspacePath: string, buildId?: string): Promise<UnrealBuildChoice | null> {
  const model = await getUnrealWorkspace(workspacePath);
  if (!model) return null;
  if (!model.choices.length && !buildId) return null;
  const id = buildId ?? model.selectedId;
  const choice = model.choices.find(c => c.id === id);
  if (!choice) throw new Error("The build configuration is no longer available. Reload the workspace and select another configuration");
  return choice;
}

async function discoverWorkspace(workspacePath: string): Promise<UnrealWorkspace | null> {
  const hits = findUprojects(workspacePath);
  const hit = hits[0];
  const uprojects = hits.map(h => h.uproject);
  if (!uprojects.length && !existsSync(join(workspacePath, "Engine", "Build", "Build.version"))) return null;
  const engineRoot = await resolveUeEngineSourceRoot(hit?.projectRoot ?? workspacePath);
  const warnings: string[] = [];
  let managedAdapter: UnrealBuildChoice["managedAdapter"];
  try {
    const settings = JSON.parse(await readText(join(workspacePath, ".larry", "unreal.json"))) as { managedDebugAdapter?: { path?: string; args?: string[] } };
    const adapter = settings.managedDebugAdapter;
    if (typeof adapter?.path === "string") {
      const path = resolveProjectPath(workspacePath, adapter.path);
      if (existsSync(path)) managedAdapter = { path, args: Array.isArray(adapter.args) && adapter.args.every(a => typeof a === "string") ? adapter.args : ["--interpreter=vscode"] };
      else warnings.push(`.NET debug adapter not found: ${path}`);
    }
  } catch { /* optional workspace settings */ }
  if (!engineRoot) return { workspacePath, engineRoot: null, projects: [], choices: [], selectedId: null, hasChoices: false, warnings: ["The Unreal Engine associated with this project could not be found"] };
  const roots = [...new Set([workspacePath, ...uprojects.map(dirname)])];
  const solutions = [...new Set((await Promise.all(roots.map(root => filesAt(root, ".sln")))).flat())];
  const projects = new Map<string, UnrealProject>();
  const projectEngines = new Map<string, string>();
  for (const project of uprojects) projectEngines.set(project, await resolveUeEngineSourceRoot(dirname(project), project) ?? engineRoot);
  const engineRoots = [...new Set([engineRoot, ...projectEngines.values()])];
  const choices = new Map<string, UnrealBuildChoice>();
  const targetFiles = [...new Set([
    ...(await Promise.all(uprojects.map(p => discoverFiles(join(dirname(p), "Source"), n => /\.Target\.cs$/i.test(n))))).flat(),
    ...(await Promise.all(engineRoots.map(engine => discoverFiles(join(engine, "Source", "Programs"), n => /\.(?:Target\.cs|csproj)$/i.test(n))))).flat(),
    ...(await Promise.all(engineRoots.map(engine => filesAt(join(engine, "Source"), ".target.cs")))).flat(),
  ])];
  const targets = new Map<string, ReturnType<typeof parseTargetCs>>();
  for (const file of targetFiles.filter(p => /\.Target\.cs$/i.test(p))) {
    const info = parseTargetCs(file, await readText(file));
    targets.set(info.name, info);
    if (file.replace(/\\/g, "/").includes("/Programs/")) projects.set(keyOf(file), { id: identity(file), name: info.name, path: file, sourceRoot: dirname(file), kind: "native" });
  }
  const managed = new Map<string, { path: string; solution: string; configs: Set<string> }>();
  for (const file of targetFiles.filter(p => /\.csproj$/i.test(p))) managed.set(keyOf(file), { path: file, solution: solutions[0] ?? workspacePath, configs: new Set() });
  for (const solution of solutions) {
    const text = await readText(solution);
    const sln = parseSln(text);
    const { mappings } = parseSlnConfigurations(text);
    for (const project of sln.projects.filter(p => p.kind === "project")) {
      const file = resolveProjectPath(dirname(solution), project.path);
      const mapped = mappings.filter(m => m.projectGuid === project.guid);
      if (/\.csproj$/i.test(file)) {
        const entry = managed.get(keyOf(file)) ?? { path: file, solution, configs: new Set<string>() };
        for (const m of mapped) entry.configs.add(m.projectConfiguration.split("|")[0]!);
        managed.set(keyOf(file), entry);
      }
      if (!/\.vcxproj$/i.test(file)) continue;
      const configurations = parseNativeConfigurations(await readText(file), file);
      for (const config of configurations) {
        if (mapped.length && !mapped.some(m => m.projectConfiguration === config.key)) continue;
        const target = targets.get(config.target);
        const uproject = uprojects.find(p => basename(p, ".uproject") === project.name) ?? uprojects.find(p => target?.path.startsWith(dirname(p))) ?? null;
        const choice = nativeChoice({ solution, project: file, target: config.target, targetType: target?.type ?? (/Editor$/.test(config.target) ? "Editor" : /Server$/.test(config.target) ? "Server" : "Game"),
          configuration: config.configuration, platform: config.platform, architecture: config.architecture,
          additionalTargets: config.additionalTargets,
          engineRoot: uproject ? projectEngines.get(uproject) ?? engineRoot : engineRoot, projectRoot: uproject ? dirname(uproject) : engineRoot, uproject, output: config.output });
        choices.set(choice.id, choice);
        if (target?.type === "Program") {
          projects.delete(keyOf(target.path));
          projects.set(keyOf(file), { id: identity(file), name: config.target, path: file, sourceRoot: dirname(target.path), kind: "native" });
        }
      }
    }
  }
  // Rider generates native Programs which are deliberately absent from the VS solution.
  for (const root of [...roots, ...engineRoots]) {
    const riderFiles = await discoverFiles(join(root, "Intermediate", "ProjectFiles", ".Rider"), n => n.endsWith(".json") && n !== "root.json");
    for (const file of riderFiles) {
      const meta = await readRiderHeader(file);
      if (!meta?.Name || !meta.Configuration || !meta.Platform || !meta.BuildInfo?.BuildCmd || !meta.TargetFile) continue;
      const target = targets.get(meta.Name);
      const solution = solutions.find(s => dirname(s) === root) ?? solutions[0] ?? workspacePath;
      const architecture = meta.ToolchainInfo?.Architecture ?? "";
      if ([...choices.values()].some(c => c.solution === solution && c.target === meta.Name && c.configuration === meta.Configuration && c.platform === meta.Platform && (c.architecture === architecture || !architecture))) continue;
      const uproject = meta.ProjectFile && /\.uproject$/i.test(meta.ProjectFile) ? meta.ProjectFile : null;
      const targetEngine = engineRoots.find(engine => keyOf(meta.TargetFile!).startsWith(`${keyOf(engine)}${process.platform === "win32" ? "\\" : "/"}`)) ?? engineRoot;
      const choice = nativeChoice({ solution, project: meta.TargetFile, target: meta.Name, targetType: target?.type ?? file.replace(/\\/g, "/").split("/").at(-2) ?? "unknown",
        configuration: meta.Configuration, platform: meta.Platform, architecture,
        additionalTargets: [...(meta.BuildInfo.BuildCmd.Args ?? "").matchAll(/-Target="([\w.-]+)\s+(\w+)\s+(DebugGame|Debug|Development|Shipping|Test)\b/g)].slice(1).map(m => ({ target: m[1]!, platform: m[2]!, configuration: m[3]! })),
        engineRoot: uproject ? projectEngines.get(uproject) ?? targetEngine : targetEngine, projectRoot: uproject ? dirname(uproject) : targetEngine, uproject, output: meta.BuildInfo.Output ?? null });
      choices.set(choice.id, choice);
    }
  }
  if (![...choices.values()].some(c => c.kind === "native")) {
    // Preserve the existing .uproject-only launch until the user generates a
    // complete IDE matrix. Do not invent a Cartesian set from Target.cs text.
    const projectRoot = hit?.projectRoot;
    const projectTargets = projectRoot ? [...targets.values()].filter(t => isUnderPath(projectRoot, t.path)) : [];
    const contentOnly = Boolean(hit) && projectTargets.length === 0;
    const projectEditor = projectTargets.find(t => t.type === "Editor");
    const namedEditor = [...targets.values()].find(t => t.name === `${hit?.baseName}Editor`)
      ?? [...targets.values()].find(t => t.type === "Editor");
    const editor = projectEditor ?? (contentOnly
      ? ([...targets.values()].find(t => t.name === "UnrealEditor" && t.type === "Editor")
        ?? { name: "UnrealEditor", path: join(engineRoot, "Source", "UnrealEditor.Target.cs"), type: "Editor" as const })
      : namedEditor);
    if (editor) {
      const installed = existsSync(join(engineRoot, "Build", "InstalledBuild.txt"));
      const configuration = installed ? "Development" : "DebugGame";
      const choice = nativeChoice({ solution: solutions[0] ?? workspacePath, project: editor.path, target: editor.name, targetType: "Editor",
        configuration, platform: ubtPlatformFor(process.platform), architecture: "", engineRoot,
        projectRoot: hit?.projectRoot ?? engineRoot, uproject: hit?.uproject ?? null,
        output: join(engineRoot, editorBinaryRel(process.platform, configuration)) });
      if (contentOnly && installed) {
        choice.skipBuild = true;
        choice.buildReason = "Installed Unreal Editor — this project has no C++ modules to compile";
        choice.debugReason = choice.runReason;
      }
      choices.set(choice.id, choice);
      if (!(contentOnly && installed)) warnings.push("Using the default Editor configuration. Generate Visual Studio or Rider project files to load all configurations");
    }
  }
  const dotnet = managed.size ? await findDotnet(engineRoot) : null;
  for (const { path, solution, configs } of managed.values()) {
    const text = await readText(path);
    const name = basename(path, ".csproj");
    projects.set(keyOf(path), { id: identity(path), name, path, sourceRoot: dirname(path), kind: "managed" });
    if (!text) continue;
    if (!configs.size) for (const config of (/<Configurations>([^<]+)<\/Configurations>/.exec(text)?.[1] ?? "Debug;Release").split(";")) configs.add(config);
    const executable = /<OutputType>\s*(?:Exe|WinExe)\s*<\/OutputType>/i.test(text);
    for (const configuration of configs) {
      const buildReason = dotnet ? null : ".NET SDK not found";
      const runReason = buildReason ?? (executable ? null : "This .NET class library cannot be run directly");
      const id = identity(engineRoot, solution, path, configuration);
      choices.set(id, { id, solution, project: path, target: name, targetType: executable ? "Program" : "Library", kind: "managed", configuration, platform: "Any CPU", architecture: "", engineRoot,
        ...(managedAdapter ? { managedAdapter } : {}),
        projectRoot: dirname(path), uproject: null, output: null,
        command: `${quoteShellArg(dotnet ?? "dotnet", process.platform)} build ${quoteShellArg(path, process.platform)} --configuration ${quoteShellArg(configuration, process.platform)} --nologo`,
        buildReason, runReason, debugReason: runReason ?? (managedAdapter ? null : "A .NET debugger is required. Configure managedDebugAdapter (netcoredbg) in .larry/unreal.json") });
    }
  }
  const all = [...choices.values()];
  if (!all.some(c => c.kind === "native")) warnings.push("No native build configurations found. Generate Visual Studio or Rider project files and reload the workspace");
  const host = ubtPlatformFor(process.platform);
  const preferred = all.find(c => c.target === `${hit?.baseName}Editor` && c.configuration === "DebugGame" && c.platform === host && (!c.architecture || c.architecture === process.arch))
    ?? all.find(c => c.targetType === "Editor" && c.platform === host && c.configuration === "Development") ?? all[0];
  return { workspacePath, engineRoot, projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)), choices: all,
    selectedId: preferred?.id ?? null, hasChoices: all.length > 1, warnings };
}
