import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bundledRsyncPath, rsyncCandidatesForResources, rsyncRuntimeEnv } from "./bundledRsync.js";

describe("rsyncCandidatesForResources", () => {
  it("puts every existing bundled executable before the PATH fallback", () => {
    const roots = ["/app/resources", "/repo/resources"];
    const expected = bundledRsyncPath(roots[1]!);
    assert.deepEqual(
      rsyncCandidatesForResources(roots, "win32", (path) => path === expected),
      [expected, "rsync"],
    );
  });

  it("returns only PATH when no bundled executable exists", () => {
    assert.deepEqual(rsyncCandidatesForResources(["/app/resources"], "win32", () => false), ["rsync"]);
  });

  it("never probes Windows resources on other platforms", () => {
    assert.deepEqual(
      rsyncCandidatesForResources(["/app/resources"], "darwin", () => { throw new Error("must not probe"); }),
      ["rsync"],
    );
  });
});

describe("rsyncRuntimeEnv", () => {
  it("prefers bundled ssh and the Windows user's SSH configuration", () => {
    const program = "C:\\Program Files\\Larry Agent\\resources\\rsync\\bin\\rsync.exe";
    assert.deepEqual(rsyncRuntimeEnv(program, "win32", {
      PATH: "C:\\Windows\\System32",
      USERPROFILE: "C:\\Users\\me",
    }), {
      PATH: "C:\\Program Files\\Larry Agent\\resources\\rsync\\bin;C:\\Windows\\System32",
      HOME: "C:\\Users\\me",
    });
  });

  it("leaves PATH rsync and non-Windows processes unchanged", () => {
    assert.equal(rsyncRuntimeEnv("rsync", "win32", {}), undefined);
    assert.equal(rsyncRuntimeEnv("/usr/bin/rsync", "darwin", {}), undefined);
  });
});
