/**
 * Footer sync targets: SVN at the workspace gets Update; Git at the
 * workspace or (only then) at the associated engine gets Pull.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { execGit } from "../git/execGit.js";
import {
  gitToplevel,
  resolveFooterVcsTargets,
  selectFooterGitRoot,
} from "./footerTargets.js";

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // temp cleanup is best effort
    }
  }
});

describe("selectFooterGitRoot", () => {
  it("prefers the workspace repo over the engine", () => {
    assert.equal(
      selectFooterGitRoot({
        workspaceGitRoot: "/game",
        engineGitRoot: "/UnrealEngine",
      }),
      "/game",
    );
  });

  it("uses the engine when the workspace is not Git", () => {
    assert.equal(
      selectFooterGitRoot({
        workspaceGitRoot: null,
        engineGitRoot: "/UnrealEngine",
      }),
      "/UnrealEngine",
    );
  });

  it("returns null when neither side is Git", () => {
    assert.equal(
      selectFooterGitRoot({ workspaceGitRoot: null, engineGitRoot: null }),
      null,
    );
  });
});

describe("resolveFooterVcsTargets", () => {
  it("reports a real Git workspace and does not ask for an engine", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jb-footer-git-"));
    dirs.push(dir);
    await execGit(dir, ["init", "--quiet", "--initial-branch=main"]);
    let engineLookups = 0;
    const targets = await resolveFooterVcsTargets(dir, {
      resolveEngine: async () => {
        engineLookups += 1;
        return "/should-not-run";
      },
    });
    assert.equal(targets.svn, false);
    assert.equal(engineLookups, 0);
    const top = await gitToplevel(dir);
    assert.ok(top);
    assert.equal(targets.gitRoot, top);
  });

  it("pairs an SVN workspace with its engine Git toplevel", async () => {
    const targets = await resolveFooterVcsTargets("/game", {
      isSvnWorkingCopy: async () => true,
      gitToplevel: async (cwd) => (cwd === "/UnrealEngine/Engine" ? "/UnrealEngine" : null),
      resolveEngine: async () => "/UnrealEngine/Engine",
    });
    assert.deepEqual(targets, { svn: true, gitRoot: "/UnrealEngine" });
  });

  it("offers only Update when the engine is not a Git repo", async () => {
    const targets = await resolveFooterVcsTargets("/game", {
      isSvnWorkingCopy: async () => true,
      gitToplevel: async () => null,
      resolveEngine: async () => "/launcher/UE_5.4/Engine",
    });
    assert.deepEqual(targets, { svn: true, gitRoot: null });
  });

  it("offers neither action for a plain folder", async () => {
    const targets = await resolveFooterVcsTargets("/notes", {
      isSvnWorkingCopy: async () => false,
      gitToplevel: async () => null,
      resolveEngine: async () => {
        throw new Error("engine lookup should be skipped");
      },
    });
    assert.deepEqual(targets, { svn: false, gitRoot: null });
  });

  it("offers both when the workspace is SVN and Git", async () => {
    const targets = await resolveFooterVcsTargets("/mixed", {
      isSvnWorkingCopy: async () => true,
      gitToplevel: async () => "/mixed",
      resolveEngine: async () => {
        throw new Error("engine lookup should be skipped");
      },
    });
    assert.deepEqual(targets, { svn: true, gitRoot: "/mixed" });
  });
});
