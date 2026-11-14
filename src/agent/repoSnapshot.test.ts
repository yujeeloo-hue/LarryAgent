import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  REPO_SNAPSHOT_HEADER,
  buildRepoSnapshot,
  editorFilesInside,
  renderLayout,
} from "./repoSnapshot.js";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("renderLayout", () => {
  it("lists top dirs by size with child dirs and top-level files", () => {
    const lines = renderLayout(
      [
        "src/a/1.ts",
        "src/a/2.ts",
        "src/b/3.ts",
        "docs/x.md",
        "package.json",
        "README.md",
      ],
      false,
    );
    assert.deepEqual(lines, [
      "  src/ (3)",
      "    a/ (2) · b/ (1)",
      "  docs/ (1)",
      "  package.json · README.md",
    ]);
  });

  it("marks counts as lower bounds when the file list was capped", () => {
    assert.equal(renderLayout(["src/a.ts"], true)[0], "  src/ (1+)");
  });
});

describe("editorFilesInside", () => {
  it("keeps workspace files only, active first, without duplicates", () => {
    const root = join(tmpdir(), "ws");
    const result = editorFilesInside(root, {
      activeFile: join(root, "src", "a.ts"),
      openFiles: [join(root, "src", "a.ts"), join(root, "b.ts"), join(tmpdir(), "other", "c.ts"), "relative.ts"],
    });
    assert.deepEqual(result, { active: "src/a.ts", open: ["b.ts"] });
  });

  it("tolerates malformed renderer input", () => {
    const root = join(tmpdir(), "ws");
    const result = editorFilesInside(root, {
      activeFile: 42 as unknown as string,
      openFiles: "nope" as unknown as string[],
    });
    assert.deepEqual(result, { active: null, open: [] });
  });
});

describe("buildRepoSnapshot", () => {
  let ROOT = "";

  before(() => {
    ROOT = mkdtempSync(join(tmpdir(), "jb-snapshot-"));
    mkdirSync(join(ROOT, "src", "tools"), { recursive: true });
    mkdirSync(join(ROOT, "build"), { recursive: true });
    writeFileSync(join(ROOT, "src", "tools", "grep.ts"), "export {};\n");
    writeFileSync(join(ROOT, "src", "index.ts"), "export {};\n");
    writeFileSync(join(ROOT, "build", "out.js"), "ignored\n");
    writeFileSync(join(ROOT, ".gitignore"), "build/\n");
    writeFileSync(join(ROOT, "package.json"), "{}\n");
  });

  after(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  it("returns null for a missing workspace", async () => {
    assert.equal(await buildRepoSnapshot({ workspacePath: join(ROOT, "missing") }), null);
  });

  it("summarizes a non-git folder with recent files and editor tabs", async () => {
    const text = await buildRepoSnapshot({
      workspacePath: join(ROOT, "src"),
      editor: { activeFile: join(ROOT, "src", "index.ts"), openFiles: [] },
    });
    assert.ok(text);
    assert.ok(text.startsWith(REPO_SNAPSHOT_HEADER));
    assert.match(text, /\(not a git repo\)/);
    assert.match(text, /tools\/ \(1\)/);
    assert.match(text, /Recently modified:/);
    assert.match(text, /\* index\.ts \(active\)/);
  });

  it("uses git for layout, branch and status when available", { skip: !hasGit() }, async () => {
    const run = (...args: string[]) =>
      execFileSync("git", args, { cwd: ROOT, stdio: "ignore" });
    run("init", "-q", "-b", "main");
    run("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
    run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "initial import");
    writeFileSync(join(ROOT, "src", "index.ts"), "export const x = 1;\n");

    const text = await buildRepoSnapshot({ workspacePath: ROOT, timeoutMs: 10_000 });
    assert.ok(text);
    assert.match(text, /\(git, branch main\)/);
    assert.doesNotMatch(text, /build\//);
    assert.match(text, /Git status \(1 changed\):\n {3}M src\/index\.ts/);
    assert.match(text, /initial import/);
    assert.match(text, /src\/index\.ts \(\d+s ago\)/);
  });
});
