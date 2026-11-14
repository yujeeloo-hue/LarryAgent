import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { runShellRiskAssessor } from "../builtin/runShell.js";

// Resolved so the workspace is an absolute native path on every platform.
const WS = resolve("/Users/tester/Developer/JellyBot");

function assess(command: string, full = false) {
  return runShellRiskAssessor({
    arguments: { command },
    fullPermissionsEnabled: full,
    workspacePath: WS,
  });
}

describe("runShellRiskAssessor — v2 acceptance mapping", () => {
  it("inside-workspace literal rm → allow + rewrite", () => {
    const a = assess("rm src/main.ts");
    assert.equal(a.action, "allow");
    assert.ok(a.action === "allow" && a.rewrite?.type === "trash");
    assert.deepEqual(
      a.action === "allow" && a.rewrite ? a.rewrite.targets : [],
      [join(WS, "src/main.ts")],
    );
  });

  it("outside rm → confirm (non-fatal) carrying rewrite; Bypass → allow + rewrite", () => {
    const safe = assess("rm /tmp/scratch.txt");
    assert.equal(safe.action, "confirm");
    assert.ok(
      safe.action === "confirm" && safe.fatal === false && safe.rewrite,
    );
    const bypass = assess("rm /tmp/scratch.txt", true);
    assert.equal(bypass.action, "allow");
    assert.ok(bypass.action === "allow" && bypass.rewrite);
  });

  it(".git rm → fatal confirm carrying rewrite (approved run is the Trash move)", () => {
    const a = assess("rm -rf .git");
    assert.equal(a.action, "confirm");
    assert.ok(a.action === "confirm" && a.fatal === true && a.rewrite);
  });

  it("unrewritable rm shapes block outright in both modes", () => {
    for (const cmd of [
      'rm "unclosed',
      "rm $(cat list.txt)",
      "rm `ls`",
      "rm a && npm test",
      "rm -rf build; echo done",
      "rm $TARGET",
    ]) {
      assert.deepEqual(assess(cmd), assess(cmd)); // sanity
      const a = assess(cmd);
      assert.equal(a.action, "block", cmd);
      if (a.action === "block") {
        assert.ok(a.reason.length > 0, cmd);
      }
      const b = assess(cmd, true);
      assert.equal(b.action, "block", `${cmd} (Bypass)`);
    }
  });

  it("non-rm commands keep their v1 verdicts", () => {
    assert.equal(assess("ls -la").action, "allow");
    assert.equal(assess("sudo reboot").action, "confirm");
    assert.equal(assess("git push --force origin main").action, "confirm");
    assert.equal(assess("find . -name '*.log' -delete").action, "confirm");
  });
});

describe("runShellRiskAssessor — supervised high-risk review", () => {
  const supervised = (command: string) => runShellRiskAssessor({
    arguments: { command },
    fullPermissionsEnabled: true,
    reviewHighRisk: true,
    workspacePath: WS,
  });

  it("Class B still confirms under Bypass, keeping the Trash rewrite", () => {
    const push = supervised("git push --force origin main");
    assert.ok(push.action === "confirm" && push.fatal === false);
    assert.equal(assess("git push --force origin main", true).action, "allow", "unsupervised Bypass is unchanged");
    const rm = supervised("rm /tmp/scratch.txt");
    assert.ok(rm.action === "confirm" && rm.fatal === false && rm.rewrite?.type === "trash");
  });

  it("normal commands stay allowed and fatal stays fatal", () => {
    assert.equal(supervised("ls -la").action, "allow");
    const fatal = supervised("sudo reboot");
    assert.ok(fatal.action === "confirm" && fatal.fatal === true);
  });
});
