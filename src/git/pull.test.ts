/**
 * pullLatest / abortMerge against real temporary git repositories: clone →
 * diverge → pull (fast-forward, already-up-to-date, clean merge commit,
 * conflict), merge-in-progress re-entry, abort, and the no-upstream /
 * non-repo failure paths. The credential-dialog retry loop is not covered
 * here — it needs the renderer vcsAuth dialog.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execGit } from "./execGit.js";
import { abortMerge, backgroundFetch, pullLatest } from "./pull.js";
import { getWorkingTreeStats } from "./workingTree.js";

const dirs: string[] = [];

async function configure(repo: string): Promise<void> {
  await execGit(repo, ["config", "user.email", "test@example.com"]);
  await execGit(repo, ["config", "user.name", "JellyBot Test"]);
  await execGit(repo, ["config", "commit.gpgsign", "false"]);
}

/** seed repo → bare origin → working clone with upstream tracking. */
async function fixture(): Promise<{
  seed: string;
  origin: string;
  work: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "jb-pull-"));
  dirs.push(dir);
  const seed = join(dir, "seed");
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  await execGit(dir, ["init", "--quiet", "--initial-branch=main", "seed"]);
  await configure(seed);
  writeFileSync(join(seed, "a.txt"), "line1\nline2\nline3\n");
  await execGit(seed, ["add", "-A"]);
  await execGit(seed, ["commit", "--quiet", "-m", "seed"]);
  await execGit(dir, ["clone", "--quiet", "--bare", seed, "origin.git"]);
  await execGit(dir, ["clone", "--quiet", origin, "work"]);
  await configure(work);
  return { seed, origin, work };
}

/** Advance seed by one commit and publish it to the bare origin. */
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

async function headSubject(repo: string): Promise<string> {
  const { stdout } = await execGit(repo, ["log", "-1", "--pretty=%s"]);
  return stdout.trim();
}

after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // temp cleanup is best effort
    }
  }
});

describe("pullLatest", () => {
  it("fast-forwards to the published commit", async () => {
    const { seed, origin, work } = await fixture();
    await publish(seed, origin, "b.txt", "new\n", "remote-add");
    const res = await pullLatest(work);
    assert.equal(res.ok, true);
    assert.equal((res as { updated: boolean }).updated, true);
    assert.equal(await headSubject(work), "remote-add");
  });

  it("reports already up to date without changes", async () => {
    const { work } = await fixture();
    const first = await pullLatest(work);
    assert.equal(first.ok, true);
    const second = await pullLatest(work);
    assert.equal(second.ok, true);
    assert.equal((second as { updated: boolean }).updated, false);
  });

  it("creates a merge commit without opening an editor (--no-edit)", async () => {
    const { seed, origin, work } = await fixture();
    writeFileSync(join(work, "local.txt"), "local\n");
    await execGit(work, ["add", "-A"]);
    await execGit(work, ["commit", "--quiet", "-m", "local-add"]);
    await publish(seed, origin, "remote.txt", "remote\n", "remote-note");
    const res = await pullLatest(work);
    assert.equal(res.ok, true);
    const { stdout } = await execGit(work, ["log", "-1", "--pretty=%P"]);
    assert.match(
      stdout.trim(),
      /^\S+\s+\S+$/,
      "divergent pull produced a two-parent merge commit",
    );
  });

  it("returns conflict paths and leaves the merge state on disk", async () => {
    const { seed, origin, work } = await fixture();
    writeFileSync(join(work, "a.txt"), "local1\nline2\nline3\n");
    await execGit(work, ["add", "-A"]);
    await execGit(work, ["commit", "--quiet", "-m", "local-edit"]);
    await publish(seed, origin, "a.txt", "remote1\nline2\nline3\n", "remote-edit");
    const res = await pullLatest(work);
    assert.equal(res.ok, false);
    assert.deepEqual((res as { conflicts?: string[] }).conflicts, ["a.txt"]);
    // The merge stays in progress — the resolution session or the user finishes it.
    await execGit(work, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  });

  it("re-enters the conflict state instead of erroring on a pending merge", async () => {
    const { seed, origin, work } = await fixture();
    writeFileSync(join(work, "a.txt"), "local1\nline2\nline3\n");
    await execGit(work, ["add", "-A"]);
    await execGit(work, ["commit", "--quiet", "-m", "local-edit"]);
    await publish(seed, origin, "a.txt", "remote1\nline2\nline3\n", "remote-edit");
    await pullLatest(work);
    const again = await pullLatest(work);
    assert.equal(again.ok, false);
    assert.deepEqual((again as { conflicts?: string[] }).conflicts, ["a.txt"]);
    assert.match((again as { message: string }).message, /already in progress/);
    assert.equal(
      await headSubject(work),
      "local-edit",
      "re-entry must not create a new commit",
    );
  });

  it("counts behind commits for the stats bar after a fetch", async () => {
    const { seed, origin, work } = await fixture();
    await publish(seed, origin, "c.txt", "c\n", "remote-c");
    // Before fetch: the local origin/main ref still matches HEAD — this is
    // the documented staleness behindCount carries until Pull runs.
    assert.equal((await getWorkingTreeStats(work)).behindCount, 0);
    // Fetch by remote NAME — `git fetch <path>` only writes FETCH_HEAD and
    // never advances origin/main.
    await execGit(work, ["fetch", "--quiet", "origin"]);
    assert.equal((await getWorkingTreeStats(work)).behindCount, 1);
  });

  it("fails cleanly on a branch without upstream", async () => {
    const { work } = await fixture();
    await execGit(work, ["checkout", "--quiet", "-b", "feature"]);
    const res = await pullLatest(work);
    assert.equal(res.ok, false);
    assert.equal("conflicts" in res, false);
    assert.match((res as { message: string }).message, /no tracking information/i);
  });

  it("fails cleanly outside a repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jb-pull-empty-"));
    dirs.push(dir);
    const res = await pullLatest(dir);
    assert.equal(res.ok, false);
    assert.match((res as { message: string }).message, /not a git repository/i);
  });
});

describe("abortMerge", () => {
  it("rolls back to the pre-merge state and refuses a second abort", async () => {
    const { seed, origin, work } = await fixture();
    writeFileSync(join(work, "a.txt"), "local1\nline2\nline3\n");
    await execGit(work, ["add", "-A"]);
    await execGit(work, ["commit", "--quiet", "-m", "local-edit"]);
    await publish(seed, origin, "a.txt", "remote1\nline2\nline3\n", "remote-edit");
    const res = await pullLatest(work);
    assert.equal(res.ok, false);

    assert.deepEqual(await abortMerge(work), { ok: true });
    const { stdout: status } = await execGit(work, ["status", "--porcelain"]);
    assert.equal(status.trim(), "", "working tree back to clean");
    assert.equal(await headSubject(work), "local-edit");

    const second = await abortMerge(work);
    assert.equal(second.ok, false);
    assert.match((second as { message: string }).message, /No merge is in progress/);
  });
});

describe("backgroundFetch", () => {
  it("silently fetches the upstream by remote name so behindCount advances", async () => {
    const { seed, origin, work } = await fixture();
    await publish(seed, origin, "d.txt", "d\n", "remote-d");
    assert.equal(
      (await getWorkingTreeStats(work)).behindCount,
      0,
      "no local fetch yet — the staleness the background poll resolves",
    );
    assert.equal(await backgroundFetch(work), true);
    assert.equal((await getWorkingTreeStats(work)).behindCount, 1);
  });

  it("fails quietly outside a repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jb-pull-bg-"));
    dirs.push(dir);
    assert.equal(await backgroundFetch(dir), false);
  });
});
