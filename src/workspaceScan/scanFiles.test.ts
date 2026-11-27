import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { execGit } from "../git/execGit.js";
import { isSkippedDir, isSkippedRelPath, ripgrepExcludeGlobs } from "./policy.js";
import { collectWorkspaceFiles, detectUnrealRoot } from "./scanFiles.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ws-scan-"));
}

async function touch(root: string, rel: string, text = "x"): Promise<void> {
  const path = join(root, ...rel.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function rels(root: string, options: Parameters<typeof collectWorkspaceFiles>[0] = { root }) {
  const out = await collectWorkspaceFiles(options);
  return { ...out, rels: out.files.map((file) => file.rel).sort() };
}

test("walk mode skips always/walk/dot dirs and noise files", async () => {
  const root = await tempRoot();
  try {
    for (const rel of [
      "src/app.ts",
      "src/.DS_Store",
      "src/app.ts.jbt.tmp",
      "node_modules/lib/index.js",
      ".git/config",
      ".cache/blob",
      "bin/Debug/app.dll",
      "release/app.exe",
      "Content/readme.txt",
    ]) {
      await touch(root, rel);
    }
    const result = await rels(root);
    assert.equal(result.mode, "walk");
    assert.equal(result.unreal, false);
    assert.deepEqual(result.rels, ["Content/readme.txt", "src/app.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Unreal roots skip generated trees at any depth and a nested Engine", async () => {
  const root = await tempRoot();
  try {
    await touch(root, "Game.uproject", "{}");
    for (const rel of [
      "Source/Game/Hero.cpp",
      "Plugins/X/Content/Hero.uasset",
      "Plugins/X/Source/X/X.cpp",
      "Intermediate/Build/Gen.cpp",
      "Saved/Logs/Game.log",
      "Engine/Source/Runtime/Actor.cpp",
      "Config/DefaultEngine.ini",
    ]) {
      await touch(root, rel);
    }
    assert.equal(detectUnrealRoot(root), true);
    const result = await rels(root);
    assert.equal(result.unreal, true);
    assert.deepEqual(result.rels, [
      "Config/DefaultEngine.ini",
      "Game.uproject",
      "Plugins/X/Source/X/X.cpp",
      "Source/Game/Hero.cpp",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("engine directories are recognised as Unreal roots", async () => {
  const base = await tempRoot();
  try {
    const engine = join(base, "UE_5.4", "Engine");
    await touch(engine, "Source/Runtime/Core/Core.h");
    await touch(engine, "Intermediate/Gen.h");
    assert.equal(detectUnrealRoot(engine), true);
    assert.equal(detectUnrealRoot(join(engine, "Source", "Runtime")), true);
    assert.equal(detectUnrealRoot(base), false);
    assert.deepEqual((await rels(engine)).rels, ["Source/Runtime/Core/Core.h"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("prefix, top-level filters, include and the file cap", async () => {
  const root = await tempRoot();
  try {
    for (const rel of ["Source/A.h", "Source/B.cpp", "Plugins/P.h", "Docs/readme.md", "top.h"]) {
      await touch(root, rel);
    }
    const scoped = await rels(root, {
      root,
      relPrefix: "Engine",
      onlyTopDirs: new Set(["source", "plugins"]),
      include: (rel) => rel.endsWith(".h"),
    });
    assert.deepEqual(scoped.rels, ["Engine/Plugins/P.h", "Engine/Source/A.h"]);

    const skipped = await rels(root, { root, skipTopDirs: new Set(["source"]) });
    assert.deepEqual(skipped.rels, ["Docs/readme.md", "Plugins/P.h", "top.h"]);

    const capped = await collectWorkspaceFiles({ root, maxFiles: 2 });
    assert.equal(capped.files.length, 2);
    assert.equal(capped.truncated, true);

    const stopped = await collectWorkspaceFiles({ root, shouldStop: () => true });
    assert.equal(stopped.aborted, true);
    assert.deepEqual(stopped.files, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("walk order puts source directories before deprioritized ones", async () => {
  const root = await tempRoot();
  try {
    await touch(root, "aaa_docs/docs/guide.md");
    await touch(root, "zzz/src/main.ts");
    const result = await collectWorkspaceFiles({ root });
    assert.deepEqual(result.files.map((file) => file.rel), [
      "zzz/src/main.ts",
      "aaa_docs/docs/guide.md",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git mode honours .gitignore, keeps tracked dot dirs, drops always-skipped dirs", async () => {
  const root = await tempRoot();
  try {
    await execGit(root, ["init", "--quiet"]);
    await touch(root, ".gitignore", "gen/\n*.log\n");
    for (const rel of [
      "src/app.ts",
      "gen/out.ts",
      "debug.log",
      ".github/workflows/ci.yml",
      "bin/tool.sh",
      "node_modules/pkg/index.js",
    ]) {
      await touch(root, rel);
    }
    await execGit(root, ["add", "-A"]);
    await execGit(root, ["add", "-f", "node_modules/pkg/index.js"]);
    await touch(root, "src/untracked.ts");
    const result = await rels(root);
    assert.equal(result.mode, "git");
    assert.deepEqual(result.rels, [
      ".github/workflows/ci.yml",
      ".gitignore",
      "bin/tool.sh",
      "src/app.ts",
      "src/untracked.ts",
    ]);

    const walked = await rels(root, { root, useGit: false });
    assert.equal(walked.mode, "walk");
    assert.ok(walked.rels.includes("gen/out.ts"));
    assert.ok(!walked.rels.includes("bin/tool.sh"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skipDir override keeps a caller's own walk rules", async () => {
  const root = await tempRoot();
  try {
    for (const rel of ["A/x.cpp", "Templates/y.cpp", "Saved/z.cpp", ".hidden/w.cpp"]) {
      await touch(root, rel);
    }
    const result = await rels(root, {
      root,
      skipDir: (name) => name.startsWith(".") || name.toLowerCase() === "saved",
    });
    assert.deepEqual(result.rels, ["A/x.cpp", "Templates/y.cpp"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("policy helpers agree on paths and emit case-insensitive ripgrep globs", () => {
  const ue = { mode: "git", unreal: true } as const;
  const plain = { mode: "walk", unreal: false } as const;
  assert.equal(isSkippedDir("Intermediate", ue), true);
  assert.equal(isSkippedDir("Intermediate", plain), false);
  assert.equal(isSkippedDir(".vscode", ue), false);
  assert.equal(isSkippedDir(".vscode", plain), true);
  assert.equal(isSkippedRelPath("Source/Intermediate/x.h", ue), true);
  assert.equal(isSkippedRelPath("Source/x.h", ue), false);
  assert.equal(isSkippedRelPath("src/x.ts.jbt.tmp", plain), true);

  const globs = ripgrepExcludeGlobs(ue);
  assert.ok(globs.includes("!**/[nN][oO][dD][eE]_[mM][oO][dD][uU][lL][eE][sS]/**"));
  assert.ok(globs.some((glob) => glob.includes("[iI][nN][tT][eE][rR]")));
  assert.ok(!globs.some((glob) => glob.includes("[bB][iI][nN]/")));
  assert.ok(ripgrepExcludeGlobs(plain).some((glob) => glob.includes("[bB][iI][nN]/")));
});
