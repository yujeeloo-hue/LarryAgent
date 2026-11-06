/**
 * Scoped commits run against a real throwaway repo: the Dev Mode tree commits
 * one file at a time, so everything outside the pathspec — including anything
 * the user already staged — must stay out of the commit.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { commitPaths } from "./commit.js";
import { execGit } from "./execGit.js";

let repo = "";

async function porcelain(): Promise<string[]> {
  const { stdout } = await execGit(repo, ["status", "--porcelain"]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

before(async () => {
  repo = await mkdtemp(join(tmpdir(), "jellybot-commit-scope-"));
  await execGit(repo, ["init", "--quiet"]);
  await execGit(repo, ["config", "user.email", "test@example.com"]);
  await execGit(repo, ["config", "user.name", "JellyBot Test"]);
  await execGit(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(repo, "seed.txt"), "seed\n", "utf8");
  await execGit(repo, ["add", "-A"]);
  await execGit(repo, ["commit", "-m", "seed"]);
});

after(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

describe("commitPaths", () => {
  it("commits only the pathspec and leaves other changes dirty", async () => {
    await writeFile(join(repo, "a.txt"), "alpha\n", "utf8");
    await writeFile(join(repo, "b.txt"), "bravo\n", "utf8");

    const created = await commitPaths(repo, "Add a.txt", ["a.txt"]);
    assert.equal(created.subject, "Add a.txt");
    assert.ok(created.shortHash.length > 0);

    assert.deepEqual(await porcelain(), ["?? b.txt"]);
  });

  it("does not sweep up changes staged outside the pathspec", async () => {
    await writeFile(join(repo, "b.txt"), "bravo\n", "utf8");
    await writeFile(join(repo, "c.txt"), "charlie\n", "utf8");
    await execGit(repo, ["add", "--", "b.txt"]);

    await commitPaths(repo, "Add c.txt", ["c.txt"]);

    const status = await porcelain();
    assert.ok(
      status.some((line) => line.endsWith("b.txt")),
      `b.txt should still be uncommitted: ${status.join(", ")}`,
    );
    const { stdout } = await execGit(repo, [
      "show",
      "--name-only",
      "--pretty=format:",
      "HEAD",
    ]);
    assert.deepEqual(
      stdout.split("\n").map((l) => l.trim()).filter(Boolean),
      ["c.txt"],
    );
  });

  it("rejects an empty message and an empty pathspec", async () => {
    await assert.rejects(() => commitPaths(repo, "   ", ["a.txt"]), /empty/i);
    await assert.rejects(() => commitPaths(repo, "msg", []), /No paths/i);
  });
});
