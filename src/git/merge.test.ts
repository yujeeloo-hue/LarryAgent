import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execGit } from "./execGit.js";
import {
  finishMerge,
  getBranchInfo,
  getPullPreview,
  parseNameStatus,
  parseNumstat,
  resolveMergeConflict,
} from "./merge.js";
import { pullLatest } from "./pull.js";

const dirs: string[] = [];

async function configure(repo: string): Promise<void> {
  await execGit(repo, ["config", "user.email", "test@example.com"]);
  await execGit(repo, ["config", "user.name", "JellyBot Test"]);
  await execGit(repo, ["config", "commit.gpgsign", "false"]);
}

async function fixture(): Promise<{ seed: string; origin: string; work: string }> {
  const dir = mkdtempSync(join(tmpdir(), "jb-merge-"));
  dirs.push(dir);
  const seed = join(dir, "seed");
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  await execGit(dir, ["init", "--quiet", "--initial-branch=main", "seed"]);
  await configure(seed);
  writeFileSync(join(seed, "a.txt"), "line1\nline2\nline3\n");
  writeFileSync(join(seed, "keep.txt"), "keep\n");
  await execGit(seed, ["add", "-A"]);
  await execGit(seed, ["commit", "--quiet", "-m", "seed"]);
  await execGit(dir, ["clone", "--quiet", "--bare", seed, "origin.git"]);
  await execGit(dir, ["clone", "--quiet", origin, "work"]);
  await configure(work);
  return { seed, origin, work };
}

async function publish(
  seed: string,
  origin: string,
  file: string,
  content: string,
  message: string,
): Promise<void> {
  writeFileSync(join(seed, file), content);
  await execGit(seed, ["add", "-A"]);
  await execGit(seed, ["commit", "--quiet", "-m", message]);
  await execGit(seed, ["push", "--quiet", origin, "HEAD:main"]);
}

async function commitLocal(work: string, file: string, content: string): Promise<void> {
  writeFileSync(join(work, file), content);
  await execGit(work, ["add", "-A"]);
  await execGit(work, ["commit", "--quiet", "-m", `local ${file}`]);
}

async function conflictFixture(): Promise<{ seed: string; origin: string; work: string }> {
  const parts = await fixture();
  await commitLocal(parts.work, "a.txt", "local1\nline2\nline3\n");
  await publish(parts.seed, parts.origin, "a.txt", "remote1\nline2\nline3\n", "remote-edit");
  await publish(parts.seed, parts.origin, "b.txt", "brand new\n", "remote-add");
  const res = await pullLatest(parts.work);
  assert.deepEqual((res as { conflicts?: string[] }).conflicts, ["a.txt"]);
  return parts;
}

after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("parseNameStatus", () => {
  it("maps status letters and picks the new path for renames", () => {
    const rows = parseNameStatus("M\tsrc/a.ts\nA\tsrc/b.ts\nD\told.ts\nR100\told.ts\tnew.ts\n");
    assert.deepEqual(rows, [
      { path: "src/a.ts", status: "modified" },
      { path: "src/b.ts", status: "added" },
      { path: "old.ts", status: "deleted" },
      { path: "new.ts", status: "renamed" },
    ]);
  });

  it("ignores unparsable lines", () => {
    assert.deepEqual(parseNameStatus("\nnot-a-row\n"), []);
  });
});

describe("parseNumstat", () => {
  it("reads line counts and flags binary rows", () => {
    const map = parseNumstat("12\t3\tsrc/a.ts\n-\t-\tlogo.png\n");
    assert.deepEqual(map.get("src/a.ts"), { insertions: 12, deletions: 3, binary: false });
    assert.deepEqual(map.get("logo.png"), { insertions: 0, deletions: 0, binary: true });
  });
});

describe("getBranchInfo", () => {
  it("reports branch, upstream and divergence", async () => {
    const { seed, origin, work } = await fixture();
    await publish(seed, origin, "b.txt", "new\n", "remote-add");
    await execGit(work, ["fetch", "--quiet"]);
    const info = await getBranchInfo(work);
    assert.equal(info.isRepo, true);
    assert.equal(info.branch, "main");
    assert.equal(info.upstream, "origin/main");
    assert.equal(info.behind, 1);
    assert.equal(info.ahead, 0);
  });

  it("reports an empty branch outside a repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jb-merge-none-"));
    dirs.push(dir);
    const info = await getBranchInfo(dir);
    assert.equal(info.isRepo, false);
    assert.equal(info.branch, "");
  });
});

describe("getPullPreview", () => {
  it("lists the incoming files with per-file stats", async () => {
    const { seed, origin, work } = await fixture();
    await publish(seed, origin, "b.txt", "one\ntwo\n", "remote-add");
    await execGit(work, ["fetch", "--quiet"]);
    const preview = await getPullPreview(work);
    assert.equal(preview.merging, false);
    assert.equal(preview.behind, 1);
    const file = preview.incoming.find(entry => entry.path === "b.txt");
    assert.equal(file?.status, "added");
    assert.equal(file?.insertions, 2);
  });

  it("surfaces the conflict list while a merge is paused", async () => {
    const { work } = await conflictFixture();
    const preview = await getPullPreview(work);
    assert.equal(preview.merging, true);
    assert.deepEqual(preview.conflicts, ["a.txt"]);
    assert.ok(preview.incoming.some(entry => entry.path === "b.txt"));
  });
});

describe("resolveMergeConflict", () => {
  it("keeps the local side and clears the conflict", async () => {
    const { work } = await conflictFixture();
    const res = await resolveMergeConflict(work, "a.txt", "mine");
    assert.equal(res.ok, true);
    assert.deepEqual((res as { remaining: string[] }).remaining, []);
    assert.equal(
      readFileSync(join(work, "a.txt"), "utf8").replace(/\r\n/g, "\n"),
      "local1\nline2\nline3\n",
    );
  });

  it("keeps the incoming side", async () => {
    const { work } = await conflictFixture();
    const res = await resolveMergeConflict(work, "a.txt", "theirs");
    assert.equal(res.ok, true);
    assert.equal(
      readFileSync(join(work, "a.txt"), "utf8").replace(/\r\n/g, "\n"),
      "remote1\nline2\nline3\n",
    );
  });

  it("keeps both sides by union-merging the file", async () => {
    const { work } = await conflictFixture();
    const res = await resolveMergeConflict(work, "a.txt", "both");
    assert.equal(res.ok, true);
    const merged = readFileSync(join(work, "a.txt"), "utf8");
    assert.match(merged, /local1/);
    assert.match(merged, /remote1/);
    assert.doesNotMatch(merged, /^<{7}|^={7}|^>{7}/m);
  });

  it("records the deletion when the chosen side removed the file", async () => {
    const { seed, origin, work } = await fixture();
    await execGit(work, ["rm", "--quiet", "keep.txt"]);
    await execGit(work, ["commit", "--quiet", "-m", "local delete"]);
    writeFileSync(join(seed, "keep.txt"), "keep changed\n");
    await execGit(seed, ["add", "-A"]);
    await execGit(seed, ["commit", "--quiet", "-m", "remote edit"]);
    await execGit(seed, ["push", "--quiet", origin, "HEAD:main"]);
    const pulled = await pullLatest(work);
    assert.deepEqual((pulled as { conflicts?: string[] }).conflicts, ["keep.txt"]);

    const res = await resolveMergeConflict(work, "keep.txt", "mine");
    assert.equal(res.ok, true);
    assert.deepEqual((res as { remaining: string[] }).remaining, []);
    const { stdout } = await execGit(work, ["ls-files", "keep.txt"]);
    assert.equal(stdout.trim(), "");
  });

  it("refuses to touch a path when no merge is paused", async () => {
    const { work } = await fixture();
    const res = await resolveMergeConflict(work, "a.txt", "mine");
    assert.deepEqual(res, { ok: false, message: "No merge is in progress." });
  });
});

describe("finishMerge", () => {
  it("commits the merge once every conflict has a side", async () => {
    const { work } = await conflictFixture();
    const blocked = await finishMerge(work);
    assert.deepEqual(blocked, { ok: false, message: "1 file still conflicted." });

    await resolveMergeConflict(work, "a.txt", "mine");
    const done = await finishMerge(work);
    assert.equal(done.ok, true);
    const { shortHash } = done as { shortHash: string };
    assert.match(shortHash, /^[0-9a-f]{7,}$/);
    const { stdout } = await execGit(work, ["log", "-1", "--pretty=%P"]);
    assert.match(stdout.trim(), /^\S+\s+\S+$/, "merge produced a two-parent commit");
  });

  it("refuses outside a merge", async () => {
    const { work } = await fixture();
    const res = await finishMerge(work);
    assert.deepEqual(res, { ok: false, message: "No merge is in progress." });
  });
});
