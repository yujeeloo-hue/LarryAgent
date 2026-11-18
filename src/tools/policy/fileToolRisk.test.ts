import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileWriteRiskAssessor, patchFileRiskAssessor } from "./fileToolRisk.js";

const WS = resolve("/Users/tester/Developer/JellyBot");
const SSH = join(homedir(), ".ssh", "config");

function write(path: string, opts: { full?: boolean; review?: boolean } = {}) {
  return fileWriteRiskAssessor({
    arguments: { path, content: "x" },
    fullPermissionsEnabled: opts.full === true,
    ...(opts.review ? { reviewHighRisk: true } : {}),
    workspacePath: WS,
  });
}

describe("file write risk — supervised sensitive writes", () => {
  it("workspace writes are allowed in every mode", () => {
    assert.equal(write(join(WS, "src/a.ts")).action, "allow");
    assert.equal(write(join(WS, "src/a.ts"), { full: true, review: true }).action, "allow");
  });

  it("sensitive writes defer normally and confirm only when supervised under Bypass", () => {
    assert.equal(write(SSH).action, "defer");
    assert.equal(write(SSH, { full: true }).action, "defer");
    const reviewed = write(SSH, { full: true, review: true });
    assert.ok(reviewed.action === "confirm" && reviewed.fatal === false);
    assert.match(reviewed.action === "confirm" ? reviewed.reason : "", /sensitive/);
  });

  it("ordinary outside writes and temp-dir scratch files are not escalated", () => {
    assert.equal(write("/tmp/out.txt", { full: true, review: true }).action, "defer");
    assert.equal(write(join(tmpdir(), "coco-scratch", "result.md"), { full: true, review: true }).action, "defer");
    assert.equal(write(join(realpathSync(tmpdir()), "coco-scratch", "result.md"), { full: true, review: true }).action, "defer");
  });

  it("V4A patches touching a sensitive path confirm when supervised", () => {
    const patch = `*** Begin Patch\n*** Update File: ${SSH}\n@@\n-a\n+b\n*** End Patch`;
    const a = patchFileRiskAssessor({ arguments: { mode: "patch", patch }, fullPermissionsEnabled: true, reviewHighRisk: true, workspacePath: WS });
    assert.equal(a.action, "confirm");
    const b = patchFileRiskAssessor({ arguments: { mode: "patch", patch }, fullPermissionsEnabled: true, workspacePath: WS });
    assert.equal(b.action, "defer");
  });
});
