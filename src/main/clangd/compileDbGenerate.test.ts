import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { clearUeEngineRootCache } from "../../unreal/engineRoot.js";
import { ubtPlatformFor } from "../../unreal/ubtCommand.js";
import { installSucceeded } from "./install.js";
import { clangdCandidates, darwinClangdCandidates, findCompileDb } from "./locate.js";
import {
  compileDbArguments,
  compileDbFingerprint,
  ensureProjectCompileDatabase,
  planCompileDatabase,
  readCompileDbStamp,
  windowsCompileCommand,
} from "./compileDbGenerate.js";

test("compile database arguments name the editor target and the project output", () => {
  const args = compileDbArguments({
    target: "UnrealEditor",
    platform: "Mac",
    configuration: "Development",
    uproject: "/Users/Shared/Epic Games/TPSDemo/TPSDemo.uproject",
    outputDir: "/work/.jellybot",
  });
  assert.deepEqual(args.slice(0, 2), [
    "-Mode=GenerateClangDatabase",
    "-Project=/Users/Shared/Epic Games/TPSDemo/TPSDemo.uproject",
  ]);
  assert.deepEqual(args.slice(2, 5), ["UnrealEditor", "Mac", "Development"]);
  assert.ok(args.includes("-OutputDir=/work/.jellybot"));
  assert.ok(args.includes("-OutputFilename=compile_commands.json"));
});

test("Windows command line quotes a script path that contains spaces", () => {
  const command = windowsCompileCommand("C:\\Program Files\\UE\\Build.bat", ["-Mode=GenerateClangDatabase", "UnrealEditor"]);
  assert.equal(
    command,
    'call "C:\\Program Files\\UE\\Build.bat" "-Mode=GenerateClangDatabase" "UnrealEditor"',
  );
});

test("fingerprint follows build rules and source names, not an existing file's body", () => {
  const base = {
    uprojectText: "{\"FileVersion\":3}",
    rules: [{ path: "Source/TPSDemo/TPSDemo.Build.cs", text: "PublicDependencyModuleNames.Add(\"Core\");" }],
    sourcePaths: ["Source/TPSDemo/TPSDemo.cpp"],
  };
  const same = compileDbFingerprint(base);
  assert.equal(compileDbFingerprint({ ...base, sourcePaths: ["Source/TPSDemo/TPSDemo.cpp"] }), same);
  assert.notEqual(compileDbFingerprint({ ...base, sourcePaths: ["Source/TPSDemo/TPSDemo.cpp", "Source/TPSDemo/New.cpp"] }), same);
  assert.notEqual(compileDbFingerprint({
    ...base,
    rules: [{ path: base.rules[0]!.path, text: "PublicDependencyModuleNames.Add(\"Engine\");" }],
  }), same);
});

test("Xcode clangd is searched, with DEVELOPER_DIR first", () => {
  const paths = darwinClangdCandidates({ DEVELOPER_DIR: "/Dev" });
  assert.equal(paths[0], join("/Dev", "usr", "bin", "clangd"));
  assert.ok(paths.some((path) => path.includes("XcodeDefault.xctoolchain")));
});

test("Windows prefers the system LLVM clangd, then PATH, then the legacy app copy", () => {
  const paths = clangdCandidates(
    { ProgramFiles: "/PF", PATH: ["/tools", "/PF/LLVM/bin"].join(delimiter) },
    "win32",
  );
  assert.equal(paths[0], join("/PF", "LLVM", "bin", "clangd.exe"));
  assert.equal(paths[1], join("/tools", "clangd.exe"));
  assert.equal(paths.length, 2);
});

test("an explicit JB_CLANGD_PATH wins over the system install", () => {
  const paths = clangdCandidates({ JB_CLANGD_PATH: "/custom/clangd", PATH: "" }, "darwin");
  assert.equal(paths[0], "/custom/clangd");
  assert.ok(paths.indexOf("/opt/homebrew/opt/llvm/bin/clangd") > 0);
});

test("winget reporting no newer LLVM still counts as installed", () => {
  assert.equal(installSucceeded(0), true);
  assert.equal(installSucceeded(0x8a15002b), true);
  assert.equal(installSucceeded(0x8a15002b | 0), true);
  assert.equal(installSucceeded(1), false);
});

test("a project compile database is found under .jellybot", async () => {
  const root = await mkdtemp(join(tmpdir(), "jb-clangdb-"));
  try {
    await mkdir(join(root, ".jellybot"), { recursive: true });
    await writeFile(join(root, ".jellybot", "compile_commands.json"), "[]");
    const found = await findCompileDb(root);
    assert.equal(found?.compileCommandsDir, join(root, ".jellybot"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an installed content project plans one editor-target database", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jb-clangdb-plan-"));
  const project = join(parent, "Game");
  const engine = join(parent, "UnrealEngine", "Engine");
  try {
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "Game.uproject"), "{}");
    await mkdir(join(engine, "Source", "Runtime"), { recursive: true });
    await mkdir(join(engine, "Build", "BatchFiles", "Mac"), { recursive: true });
    await mkdir(join(engine, "Build", "BatchFiles", "Linux"), { recursive: true });
    await writeFile(join(engine, "Build", "InstalledBuild.txt"), "");
    await writeFile(join(engine, "Build", "BatchFiles", "Build.bat"), "@echo off\n");
    await writeFile(join(engine, "Build", "BatchFiles", "Build.sh"), "#!/bin/sh\n");
    await writeFile(join(engine, "Build", "BatchFiles", "Mac", "Build.sh"), "#!/bin/sh\n");
    await writeFile(join(engine, "Build", "BatchFiles", "Linux", "Build.sh"), "#!/bin/sh\n");
    clearUeEngineRootCache();
    const plan = await planCompileDatabase(project);
    assert.ok(plan);
    assert.equal(plan.stamp.target, "UnrealEditor");
    assert.equal(plan.stamp.configuration, "Development");
    assert.equal(plan.stamp.platform, ubtPlatformFor(process.platform));
    assert.equal(plan.outputFile, join(project, ".jellybot", "compile_commands.json"));
    assert.ok(plan.args.includes("-Mode=GenerateClangDatabase"));
    const again = await planCompileDatabase(project);
    assert.equal(again?.stamp.fingerprint, plan.stamp.fingerprint);
    await mkdir(join(project, "Source", "Game"), { recursive: true });
    await writeFile(join(project, "Source", "Game", "Game.cpp"), "void Added() {}\n");
    const grown = await planCompileDatabase(project);
    assert.notEqual(grown?.stamp.fingerprint, plan.stamp.fingerprint);
  } finally {
    clearUeEngineRootCache();
    await rm(parent, { recursive: true, force: true });
  }
});

async function fixture(withSources = true) {
  const parent = await mkdtemp(join(tmpdir(), "jb-clangdb full-"));
  const project = join(parent, "Game Project");
  const install = join(parent, "UnrealEngine");
  const engine = join(install, "Engine");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "Game.uproject"), "{}");
  await mkdir(join(engine, "Source", "Runtime"), { recursive: true });
  await mkdir(join(engine, "Build", "BatchFiles", "Mac"), { recursive: true });
  await mkdir(join(engine, "Build", "BatchFiles", "Linux"), { recursive: true });
  await writeFile(join(engine, "Build", "InstalledBuild.txt"), "");
  const dataFile = join(parent, "commands.json");
  const runsFile = join(parent, "runs.txt");
  const writer = join(parent, "generate.cjs");
  await writeFile(writer, `
    const fs = require("node:fs"), path = require("node:path");
    const out = process.argv.find(arg => arg.startsWith("-OutputDir=")).slice(11);
    fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(${JSON.stringify(dataFile)}, path.join(out, "compile_commands.json"));
    fs.appendFileSync(${JSON.stringify(runsFile)}, "run\\n");
  `);
  const batch = `@echo off\r\n"${process.execPath}" "${writer}" %*\r\n`;
  const shell = `#!/bin/sh\nexec '${process.execPath}' '${writer}' "$@"\n`;
  await writeFile(join(engine, "Build", "BatchFiles", "Build.bat"), batch);
  for (const dir of ["", "Mac", "Linux"]) {
    await writeFile(join(engine, "Build", "BatchFiles", dir, "Build.sh"), shell, { mode: 0o755 });
  }
  const files = [join(engine, "Source", "Runtime", "Engine.cpp")];
  if (withSources) {
    files.push(
      join(project, "Source", "Game", "Game.cpp"),
      join(project, "Intermediate", "Module.Game.gen.cpp"),
      join(project, "Source", "Messages.pb.cc"),
      join(project, "Plugins", "Vendor", "ThirdParty", "Codec.cpp"),
    );
  }
  for (const file of files) {
    await mkdir(resolve(file, ".."), { recursive: true });
    await writeFile(file, "int Value;\n");
  }
  const entries = files.map(file => ({ file, directory: engine, arguments: ["clang++", "-c", file] }));
  await writeFile(dataFile, JSON.stringify(entries));
  await mkdir(join(project, ".jellybot"), { recursive: true });
  await writeFile(join(project, ".jellybot", "clangd-engine.json"), JSON.stringify({ engineRoot: install }));
  return {
    parent, project, install, engine, entries, dataFile,
    async runs() { try { return (await readFile(runsFile, "utf8")).trim().split("\n").length; } catch { return 0; } },
    async cleanup() {
      assert.ok(resolve(parent).startsWith(resolve(tmpdir()) + sep));
      await rm(parent, { recursive: true, force: true });
    },
  };
}

test("complete v1 databases upgrade without dropping engine, generated or vendor commands", async () => {
  const f = await fixture();
  try {
    const plan = await planCompileDatabase(f.project);
    assert.ok(plan);
    await writeFile(plan.outputFile, JSON.stringify(f.entries));
    await writeFile(join(plan.outputDir, "compile_commands.stamp.json"), JSON.stringify({ ...plan.stamp, version: 1 }));
    const result = await ensureProjectCompileDatabase(f.project);
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(await readFile(plan.outputFile, "utf8")), f.entries);
    assert.equal(readCompileDbStamp(f.project)?.version, 4);
    assert.equal(await f.runs(), 0);
  } finally { await f.cleanup(); }
});

for (const version of [2, 3]) {
  test(`filtered v${version} databases regenerate once and then reuse the complete result`, async () => {
    const f = await fixture();
    try {
      const plan = await planCompileDatabase(f.project);
      assert.ok(plan);
      await writeFile(plan.outputFile, JSON.stringify([f.entries[1]]));
      await writeFile(join(plan.outputDir, "compile_commands.stamp.json"), JSON.stringify({ ...plan.stamp, version }));
      const result = await ensureProjectCompileDatabase(f.project);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.ok && result.skipped, false);
      assert.deepEqual(JSON.parse(await readFile(plan.outputFile, "utf8")), f.entries);
      assert.equal(readCompileDbStamp(f.project)?.version, 4);
      assert.equal(await f.runs(), 1);
      const reused = await ensureProjectCompileDatabase(f.project);
      assert.equal(reused.ok && reused.skipped, true);
      assert.equal(await f.runs(), 1);
    } finally { await f.cleanup(); }
  });
}

test("a legacy external cache cannot hide newly added project C++ sources", async () => {
  const f = await fixture(false);
  try {
    const external = join(f.engine, "compile_commands.json");
    await writeFile(external, JSON.stringify(f.entries));
    const outputDir = join(f.project, ".jellybot");
    const output = join(outputDir, "compile_commands.json");
    await writeFile(output, JSON.stringify(f.entries));
    await writeFile(join(outputDir, "compile_commands.source.json"), JSON.stringify({ version: 2, sourceFile: external }));
    const contentOnly = await ensureProjectCompileDatabase(f.project);
    assert.equal(contentOnly.ok && contentOnly.outputFile, external);
    const file = join(f.project, "Source", "New.cpp");
    await mkdir(join(f.project, "Source"));
    await writeFile(file, "int Added;\n");
    f.entries.push({ file, directory: f.engine, arguments: ["clang++", "-c", file] });
    await writeFile(f.dataFile, JSON.stringify(f.entries));
    const grown = await ensureProjectCompileDatabase(f.project);
    assert.equal(grown.ok, true, JSON.stringify(grown));
    assert.equal(grown.ok && grown.skipped, false);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), f.entries);
    assert.equal(await f.runs(), 1);
  } finally { await f.cleanup(); }
});

test("build rules and new source paths regenerate commands; body-only edits do not", async () => {
  const f = await fixture();
  try {
    assert.equal((await ensureProjectCompileDatabase(f.project)).ok, true);
    await writeFile(f.entries[1]!.file, "int ChangedBody;\n");
    assert.equal((await ensureProjectCompileDatabase(f.project)).ok, true);
    assert.equal(await f.runs(), 1);
    const file = join(f.project, "Source", "New.cpp");
    await writeFile(file, "int New;\n");
    f.entries.push({ file, directory: f.engine, arguments: ["clang++", "-c", file] });
    await writeFile(f.dataFile, JSON.stringify(f.entries));
    assert.equal((await ensureProjectCompileDatabase(f.project)).ok, true);
    assert.equal(await f.runs(), 2);
    await writeFile(join(f.project, "Source", "Game.Build.cs"), "// changed dependencies\n");
    assert.equal((await ensureProjectCompileDatabase(f.project)).ok, true);
    assert.equal(await f.runs(), 3);
  } finally { await f.cleanup(); }
});

test("a failed regeneration keeps the previous database and is not retried for the same inputs", async () => {
  const f = await fixture();
  const writer = join(f.parent, "generate.cjs");
  const working = await readFile(writer, "utf8");
  try {
    const first = await ensureProjectCompileDatabase(f.project);
    assert.ok(first.ok && !first.skipped);
    assert.equal(await f.runs(), 1);

    await writeFile(writer, `
      const fs = require("node:fs");
      fs.appendFileSync(${JSON.stringify(join(f.parent, "runs.txt"))}, "run\\n");
      console.log("Unable to find plugin 'CMAA2Plugin' (referenced via Game.uproject).");
      console.log("Result: Failed (OtherCompilationError)");
      process.exit(6);
    `);
    await writeFile(join(f.project, "Game.uproject"), JSON.stringify({ Plugins: [{ Name: "CMAA2Plugin", Enabled: true }] }));

    const stale = await ensureProjectCompileDatabase(f.project);
    assert.ok(stale.ok, JSON.stringify(stale));
    assert.equal(stale.ok && stale.outputFile, first.ok && first.outputFile);
    assert.equal(stale.ok && stale.skipped, true);
    assert.match((stale.ok && stale.staleReason) || "", /CMAA2Plugin/);
    assert.equal(await f.runs(), 2);

    const again = await ensureProjectCompileDatabase(f.project);
    assert.match((again.ok && again.staleReason) || "", /CMAA2Plugin/);
    assert.equal(await f.runs(), 2, "the same failing inputs do not rerun UBT");

    await writeFile(writer, working);
    await writeFile(join(f.project, "Game.uproject"), JSON.stringify({ Plugins: [] }));
    const fixed = await ensureProjectCompileDatabase(f.project);
    assert.ok(fixed.ok && !fixed.skipped && !fixed.staleReason, JSON.stringify(fixed));
    assert.equal(await f.runs(), 3);
  } finally { await f.cleanup(); }
});

test("user root databases take precedence over legacy filtered copies and remain intact", async () => {
  const f = await fixture();
  try {
    const rootDb = join(f.project, "compile_commands.json");
    const original = JSON.stringify(f.entries, null, 4);
    await writeFile(rootDb, original);
    await writeFile(join(f.project, ".jellybot", "compile_commands.json"), "[]");
    const result = await ensureProjectCompileDatabase(f.project);
    assert.equal(result.ok && result.outputFile, rootDb);
    assert.equal((await findCompileDb(f.project))?.compileCommandsDir, f.project);
    assert.equal(await readFile(rootDb, "utf8"), original);
    assert.equal(await f.runs(), 0);
  } finally { await f.cleanup(); }
});

test("an unrestorable filtered database reports failure instead of silently indexing a subset", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jb-clangdb-no-engine-"));
  try {
    await writeFile(join(parent, "Game.uproject"), '{"EngineAssociation":"UnavailableAuditEngine"}');
    await mkdir(join(parent, "Source"));
    await writeFile(join(parent, "Source", "New.cpp"), "int New;\n");
    const dir = join(parent, ".jellybot");
    await mkdir(dir);
    await writeFile(join(dir, "compile_commands.json"), "[]");
    await writeFile(join(dir, "compile_commands.stamp.json"), JSON.stringify({
      version: 3, target: "OldEditor", platform: "Win64", configuration: "Development",
      engineRoot: join(parent, "MissingEngine"), fingerprint: "old",
    }));
    const result = await ensureProjectCompileDatabase(parent);
    assert.equal(result.ok, false);
  } finally {
    assert.ok(resolve(parent).startsWith(resolve(tmpdir()) + sep));
    await rm(parent, { recursive: true, force: true });
  }
});

test("an unmarked project database takes precedence over a shared engine fallback", async () => {
  const f = await fixture(false);
  try {
    await writeFile(join(f.engine, "compile_commands.json"), JSON.stringify(f.entries));
    const ownFile = join(f.project, ".jellybot", "compile_commands.json");
    const original = JSON.stringify(f.entries, null, 4);
    await writeFile(ownFile, original);
    const result = await ensureProjectCompileDatabase(f.project);
    assert.equal(result.ok && result.outputFile, ownFile);
    assert.equal(await readFile(ownFile, "utf8"), original);
    assert.equal(await f.runs(), 0);
  } finally { await f.cleanup(); }
});
