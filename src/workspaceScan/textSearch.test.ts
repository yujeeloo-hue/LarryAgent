import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { execGit } from "../git/execGit.js";
import { ripgrepCandidates } from "./ripgrep.js";
import {
  parseRipgrepMatch,
  searchWorkspaceText,
  type TextSearchHit,
  type TextSearchRequest,
} from "./textSearch.js";

const program = ripgrepCandidates({ devRoots: [process.cwd()] })[0]!;
const available = spawnSync(program, ["--version"], { windowsHide: true }).status === 0;
const needsRipgrep = { skip: available ? false : "ripgrep is not available" };

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ws-text-"));
}

async function touch(root: string, rel: string, text: string): Promise<void> {
  const path = join(root, ...rel.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function run(
  request: Omit<TextSearchRequest, "onHits" | "program">,
): Promise<{ hits: TextSearchHit[]; truncated: boolean; cancelled: boolean; error?: string }> {
  const hits: TextSearchHit[] = [];
  const outcome = await searchWorkspaceText({
    ...request,
    program,
    onHits: (batch) => hits.push(...batch),
  });
  return { hits, ...outcome };
}

test("parseRipgrepMatch maps rg JSON to workspace hits with character columns", () => {
  const line = JSON.stringify({
    type: "match",
    data: {
      path: { text: "./src/中文.ts" },
      lines: { text: "const 名字 = findHero();\n" },
      line_number: 7,
      submatches: [{ start: Buffer.byteLength("const 名字 = "), end: 0 }],
    },
  });
  const hit = parseRipgrepMatch(line, { root: "E:/Proj", relPrefix: "Engine" });
  assert.ok(hit);
  assert.equal(hit.rel, "Engine/src/中文.ts");
  assert.equal(hit.line, 7);
  assert.equal(hit.column, 12);
  assert.equal(hit.preview, "const 名字 = findHero();");
  assert.equal(parseRipgrepMatch(JSON.stringify({ type: "begin", data: {} }), { root: "x" }), null);
  assert.equal(parseRipgrepMatch("not json", { root: "x" }), null);
});

test("text search follows the shared scan rules outside git", needsRipgrep, async () => {
  const root = await tempRoot();
  try {
    await touch(root, "Game.uproject", "{}");
    await touch(root, "Source/Hero.cpp", "void AHero::Jump() {}\n// jump later\n");
    await touch(root, "Intermediate/Gen.cpp", "void AHero::Jump() {}\n");
    await touch(root, "node_modules/x/index.js", "Jump\n");
    await touch(root, "bin/a.txt", "Jump\n");
    await touch(root, ".cache/b.txt", "Jump\n");
    await touch(root, "Config/.env", "JUMP_KEY=1\n");

    const smart = await run({ roots: [{ root }], query: "Jump" });
    assert.equal(smart.error, undefined);
    assert.deepEqual(smart.hits.map((hit) => `${hit.rel}:${hit.line}:${hit.column}`), [
      "Source/Hero.cpp:1:13",
    ]);
    assert.equal(smart.hits[0]!.path, join(root, "Source", "Hero.cpp"));
    assert.equal(smart.hits[0]!.preview, "void AHero::Jump() {}");

    const insensitive = await run({ roots: [{ root }], query: "jump" });
    assert.deepEqual(
      insensitive.hits.map((hit) => `${hit.rel}:${hit.line}`).sort(),
      ["Config/.env:1", "Source/Hero.cpp:1", "Source/Hero.cpp:2"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("text search honours .gitignore inside git work trees", needsRipgrep, async () => {
  const root = await tempRoot();
  try {
    await execGit(root, ["init", "--quiet"]);
    await touch(root, ".gitignore", "gen/\n");
    await touch(root, "src/app.ts", "export const needle = 1;\n");
    await touch(root, "gen/out.ts", "export const needle = 2;\n");
    await touch(root, "bin/tool.ts", "export const needle = 3;\n");
    await touch(root, ".github/ci.yml", "needle: yes\n");
    const result = await run({ roots: [{ root }], query: "needle" });
    assert.deepEqual(result.hits.map((hit) => hit.rel).sort(), [
      ".github/ci.yml",
      "bin/tool.ts",
      "src/app.ts",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("caps, per-file limits, scoped paths, prefixes and top-level skips", needsRipgrep, async () => {
  const root = await tempRoot();
  try {
    await touch(root, "Source/a.h", Array.from({ length: 9 }, () => "token").join("\n"));
    await touch(root, "Source/b.h", "token\n");
    await touch(root, "Plugins/c.h", "token\n");
    await touch(root, "Docs/d.md", "token\n");
    await touch(root, "Engine/Source/e.h", "token\n");

    const perFile = await run({ roots: [{ root }], query: "token", maxPerFile: 2 });
    assert.equal(perFile.hits.filter((hit) => hit.rel === "Source/a.h").length, 2);

    const capped = await run({ roots: [{ root }], query: "token", maxResults: 3 });
    assert.equal(capped.hits.length, 3);
    assert.equal(capped.truncated, true);

    const scoped = await run({
      roots: [{ root, relPrefix: "Engine", paths: ["Plugins", "Docs"] }],
      query: "token",
    });
    assert.deepEqual(scoped.hits.map((hit) => hit.rel).sort(), [
      "Engine/Docs/d.md",
      "Engine/Plugins/c.h",
    ]);

    const skipped = await run({
      roots: [{ root, skipTopDirs: new Set(["engine"]) }],
      query: "token",
    });
    assert.ok(!skipped.hits.some((hit) => hit.rel.startsWith("Engine/")));
    assert.ok(skipped.hits.some((hit) => hit.rel === "Source/b.h"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an aborted search reports cancellation", needsRipgrep, async () => {
  const root = await tempRoot();
  try {
    await touch(root, "a.txt", "needle\n");
    const controller = new AbortController();
    controller.abort();
    const result = await run({ roots: [{ root }], query: "needle", signal: controller.signal });
    assert.equal(result.cancelled, true);
    assert.deepEqual(result.hits, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ripgrepCandidates prefers bundled binaries and falls back to PATH", () => {
  const seen = new Set([join("R", "ripgrep", "rg.exe"), join("D", "resources", "ripgrep", "win32-x64", "rg.exe")]);
  assert.deepEqual(
    ripgrepCandidates({
      resourcesPath: "R",
      devRoots: ["D", "Missing"],
      platform: "win32",
      arch: "x64",
      exists: (path) => seen.has(path),
    }),
    [join("R", "ripgrep", "rg.exe"), join("D", "resources", "ripgrep", "win32-x64", "rg.exe"), "rg"],
  );
  assert.deepEqual(
    ripgrepCandidates({ platform: "darwin", arch: "arm64", exists: () => false }),
    ["rg"],
  );
});
