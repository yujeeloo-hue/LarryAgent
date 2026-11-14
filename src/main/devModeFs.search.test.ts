/**
 * devmode:searchFiles — recursive filename filter (ignore rules + budgets).
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  resolveDevModeSourcePath,
  resolveUeEngineSourceRoot,
  searchDevModeFiles,
} from "./devModeFs.js";

async function makeTree(root: string): Promise<void> {
  await mkdir(join(root, "src", "deep"), { recursive: true });
  await mkdir(join(root, "node_modules", "lib"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "src", "app.ts"), "x");
  await writeFile(join(root, "src", "deep", "app.controller.ts"), "x");
  await writeFile(join(root, "src", "readme.md"), "x");
  await writeFile(join(root, "node_modules", "lib", "app.ts"), "x");
  await writeFile(join(root, "bin", "app.ts"), "x");
  await writeFile(join(root, ".git", "app.ts"), "x");
}

describe("searchDevModeFiles", () => {
  it("matches names case-insensitively, skipping ignored dirs", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-dmsearch-"));
    try {
      await makeTree(root);
      const res = await searchDevModeFiles(root, "APP.TS");
      assert.equal(res.ok, true);
      if (!res.ok) return;
      const rels = res.files.map((f) => f.rel);
      assert.deepEqual(rels, ["src/app.ts"]);
      assert.equal(res.truncated, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches relative path substrings (dir narrowing)", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-dmsearch-dir-"));
    try {
      await makeTree(root);
      const res = await searchDevModeFiles(root, "deep/app");
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.deepEqual(
        res.files.map((f) => f.rel),
        ["src/deep/app.controller.ts"],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns empty for blank queries without walking", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-dmsearch-blank-"));
    try {
      const res = await searchDevModeFiles(root, "   ");
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.deepEqual(res.files, []);
      assert.equal(res.truncated, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blacklists UE asset dirs at any depth when a .uproject is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-dmsearch-ue-"));
    try {
      await writeFile(join(root, "Game.uproject"), "{}");
      await mkdir(join(root, "Source", "Game"), { recursive: true });
      await mkdir(join(root, "Content", "Blueprints"), { recursive: true });
      await mkdir(join(root, "Plugins", "X", "Content"), { recursive: true });
      await mkdir(join(root, "Intermediate", "Build"), { recursive: true });
      await mkdir(join(root, "Config"), { recursive: true });
      await writeFile(join(root, "Source", "Game", "NFCharacter.cpp"), "x");
      await writeFile(join(root, "Content", "Blueprints", "NFCharacter.uasset"), "x");
      await writeFile(join(root, "Plugins", "X", "Content", "NFCharacter.uasset"), "x");
      await writeFile(join(root, "Intermediate", "Build", "NFCharacter.cpp"), "x");
      await writeFile(join(root, "Config", "DefaultEngine.ini"), "x");

      const res = await searchDevModeFiles(root, "nfcharacter");
      assert.equal(res.ok, true);
      if (!res.ok) return;
      // Content/Intermediate pruned — including a Content dir nested in a plugin.
      assert.deepEqual(res.files.map((f) => f.rel), [
        "Source/Game/NFCharacter.cpp",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("walks Engine source dirs only when includeEngine is armed", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-dmsearch-eng-"));
    try {
      await writeFile(join(root, "UE5.sln"), "");
      await mkdir(join(root, "Engine", "Source", "Runtime"), { recursive: true });
      await mkdir(join(root, "Engine", "Content"), { recursive: true });
      await mkdir(join(root, "Programs"), { recursive: true });
      await writeFile(join(root, "Engine", "Source", "Runtime", "Actor.cpp"), "x");
      await writeFile(join(root, "Engine", "Content", "Actor.nt"), "x");
      await writeFile(join(root, "Programs", "Actor.cpp"), "x");

      const off = await searchDevModeFiles(root, "actor");
      assert.equal(off.ok, true);
      if (!off.ok) return;
      assert.deepEqual(off.files.map((f) => f.rel), ["Programs/Actor.cpp"]);

      const on = await searchDevModeFiles(root, "actor", { includeEngine: true });
      assert.equal(on.ok, true);
      if (!on.ok) return;
      // Engine/Content is blacklisted even at a source-engine root; Engine/
      // ranks below the root's own code.
      assert.deepEqual(on.files.map((f) => f.rel), [
        "Programs/Actor.cpp",
        "Engine/Source/Runtime/Actor.cpp",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finds a sibling source engine (game and engine side by side)", async () => {
    const parent = await mkdtemp(join(tmpdir(), "jb-dmsearch-sib-"));
    const project = join(parent, "Game");
    const engine = join(parent, "UnrealEngine", "Engine");
    try {
      await mkdir(join(project, "Source"), { recursive: true });
      await writeFile(join(project, "Game.uproject"), "{}");
      await writeFile(join(project, "Source", "Hero.cpp"), "x");
      await mkdir(join(engine, "Source", "Runtime"), { recursive: true });
      await mkdir(join(engine, "Content"), { recursive: true });
      await writeFile(join(engine, "Source", "Runtime", "HeroBase.cpp"), "x");
      await writeFile(join(engine, "Content", "Hero.uasset"), "x");

      assert.equal(await resolveUeEngineSourceRoot(project), engine);

      const off = await searchDevModeFiles(project, "hero");
      assert.ok(off.ok);
      if (!off.ok) return;
      assert.deepEqual(off.files.map((f) => f.rel), ["Source/Hero.cpp"]);

      const on = await searchDevModeFiles(project, "hero", { includeEngine: true });
      assert.ok(on.ok);
      if (!on.ok) return;
      // Sibling engine code joins the walk; its Content stays blacklisted.
      assert.deepEqual(on.files.map((f) => f.rel), [
        "Source/Hero.cpp",
        "Engine/Source/Runtime/HeroBase.cpp",
      ]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("reports no engine for a plain workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-dmsearch-none-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "app.ts"), "x");
      assert.equal(await resolveUeEngineSourceRoot(root), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ranks project code above engine code", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-dmsearch-rank-"));
    try {
      await writeFile(join(root, "UE5.sln"), "");
      await mkdir(join(root, "Engine", "Source"), { recursive: true });
      await mkdir(join(root, "Source"), { recursive: true });
      await writeFile(join(root, "Engine", "Source", "Widget.h"), "x");
      await writeFile(join(root, "Source", "Widget.h"), "x");

      const res = await searchDevModeFiles(root, "widget", { includeEngine: true });
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.deepEqual(res.files.map((f) => f.rel), [
        "Source/Widget.h",
        "Engine/Source/Widget.h",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("searchDevModeFiles engineOnly", () => {
  async function makeEngineTree(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "jb-dmsearch-eonly-"));
    await writeFile(join(root, "UE5.sln"), "");
    await mkdir(join(root, "Engine", "Source", "Runtime"), { recursive: true });
    await mkdir(join(root, "Engine", "Content"), { recursive: true });
    await mkdir(join(root, "Source"), { recursive: true });
    await writeFile(join(root, "Engine", "Source", "Runtime", "Widget.h"), "x");
    await writeFile(join(root, "Engine", "Content", "Widget.uasset"), "x");
    await writeFile(join(root, "Source", "Widget.h"), "x");
    return root;
  }

  it("returns the engine tree only, leaving the project root to the other pass", async () => {
    const root = await makeEngineTree();
    try {
      const res = await searchDevModeFiles(root, "", {
        listAll: true,
        engineOnly: true,
      });
      assert.equal(res.ok, true);
      if (!res.ok) return;
      // Project files belong to the first pass; Engine/Content stays blacklisted.
      assert.deepEqual(res.files.map((f) => f.rel), [
        "Engine/Source/Runtime/Widget.h",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is disjoint from the project pass, so the union has no duplicates", async () => {
    const root = await makeEngineTree();
    try {
      const projectPass = await searchDevModeFiles(root, "", { listAll: true });
      const enginePass = await searchDevModeFiles(root, "", {
        listAll: true,
        engineOnly: true,
      });
      assert.ok(projectPass.ok && enginePass.ok);
      if (!projectPass.ok || !enginePass.ok) return;
      const rels = [...projectPass.files, ...enginePass.files].map((f) => f.rel);
      assert.equal(new Set(rels).size, rels.length);
      assert.ok(rels.includes("Source/Widget.h"));
      assert.ok(rels.includes("Engine/Source/Runtime/Widget.h"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves empty when the workspace has no engine", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-dmsearch-noeng-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "app.ts"), "x");
      const res = await searchDevModeFiles(root, "", {
        listAll: true,
        engineOnly: true,
      });
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.deepEqual(res.files, []);
      assert.equal(res.truncated, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("resolveDevModeSourcePath", () => {
  it("maps a build-machine Engine suffix directly onto the local Engine root", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-dmsource-engine-"));
    try {
      await writeFile(join(root, "UE5.sln"), "");
      const local = join(
        root,
        "Engine",
        "Source",
        "Runtime",
        "Core",
        "Private",
        "Actor.cpp",
      );
      await mkdir(dirname(local), { recursive: true });
      await writeFile(local, "x");

      const resolved = await resolveDevModeSourcePath(
        root,
        "Z:/build/++UE5/Sync/Engine/Source/Runtime/Core/Private/Actor.cpp",
      );
      assert.equal(resolved, local);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps a build-machine project Source suffix onto the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-dmsource-project-"));
    try {
      const local = join(root, "Source", "Game", "Private", "Hero.cpp");
      await mkdir(dirname(local), { recursive: true });
      await writeFile(local, "x");

      const resolved = await resolveDevModeSourcePath(
        root,
        "D:/agent/_work/Game/Source/Game/Private/Hero.cpp",
      );
      assert.equal(resolved, local);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to an Engine-only basename scan when no stable tail exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-dmsource-fallback-"));
    try {
      await writeFile(join(root, "UE5.sln"), "");
      const local = join(root, "Engine", "Source", "Runtime", "OnlyInEngine.cpp");
      await mkdir(dirname(local), { recursive: true });
      await writeFile(local, "x");

      assert.equal(
        await resolveDevModeSourcePath(root, "OnlyInEngine.cpp"),
        local,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns null rather than an unrelated path when no source exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-dmsource-missing-"));
    try {
      assert.equal(
        await resolveDevModeSourcePath(root, "MissingSource.cpp"),
        null,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("searchDevModeFiles streaming", () => {
  it("streams batches and returns no accumulated files", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-dmsearch-stream-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      for (let i = 0; i < 10; i++) {
        await writeFile(join(root, "src", `file${i}.ts`), "x");
      }
      const batches: string[][] = [];
      const res = await searchDevModeFiles(
        root,
        "",
        { listAll: true },
        { batchSize: 4, onBatch: (files) => batches.push(files.map((f) => f.rel)) },
      );
      assert.equal(res.ok, true);
      if (!res.ok) return;
      // Streamed callers hold every batch; the reply carries none of them.
      assert.deepEqual(res.files, []);
      assert.ok(batches.length > 1, "expected more than one batch");
      assert.ok(
        batches.slice(0, -1).every((b) => b.length === 4),
        "non-final batches should be full",
      );
      const streamed = batches.flat();
      assert.equal(streamed.length, 10);
      assert.equal(new Set(streamed).size, 10);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops at the limit and reports truncation", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-dmsearch-streamcap-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      for (let i = 0; i < 10; i++) {
        await writeFile(join(root, "src", `file${i}.ts`), "x");
      }
      const streamed: string[] = [];
      const res = await searchDevModeFiles(
        root,
        "",
        { listAll: true, limit: 6 },
        {
          batchSize: 4,
          onBatch: (files) => streamed.push(...files.map((f) => f.rel)),
        },
      );
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(res.truncated, true);
      // The budget counts streamed files, not the current buffer length.
      assert.equal(streamed.length, 6);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a separate cancel key keeps a concurrent search from killing the walk", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-dmsearch-cancelkey-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      for (let i = 0; i < 20; i++) {
        await writeFile(join(root, "src", `file${i}.ts`), "x");
      }
      const streamed: string[] = [];
      const walk = searchDevModeFiles(
        root,
        "",
        { listAll: true },
        {
          batchSize: 2,
          cancelKey: `index:${root}`,
          onBatch: (files) => streamed.push(...files.map((f) => f.rel)),
        },
      );
      // A search box keystroke on the same root: latest-wins applies to its
      // own key only, so the index walk must survive.
      await searchDevModeFiles(root, "file1");
      const res = await walk;
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(streamed.length, 20);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
