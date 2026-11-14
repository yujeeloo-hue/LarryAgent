import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ToolReturnCode } from "../../session/returnCodes.js";
import { patchFileRiskAssessor } from "../policy/fileToolRisk.js";
import type { ToolExecuteContext } from "../types.js";
import { patchHandler } from "./patch.js";

let TMP = "";

before(() => {
  TMP = mkdtempSync(join(tmpdir(), "jb-patchtool-"));
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function ctx(overrides?: Partial<ToolExecuteContext>): ToolExecuteContext {
  return {
    workspacePath: TMP,
    fullPermissionsEnabled: true,
    sessionId: "patch-test",
    toolCallId: "call_patch_1",
    ...overrides,
  };
}

function reportText(result: Awaited<ReturnType<typeof patchHandler>>): string {
  const parts = result.content.filter((p) => p.type === "text" && p.id !== "file_diff");
  return parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
}

describe("patch replace mode", () => {
  it("replaces a unique string", async () => {
    const p = join(TMP, "hello.txt");
    writeFileSync(p, "one\ntwo\nthree\n");
    const result = await patchHandler(
      { path: p, old_string: "two", new_string: "TWO" },
      ctx(),
    );
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.match(reportText(result), /^PATCH APPLIED — replaced unique match/);
    assert.equal(readFileSync(p, "utf8"), "one\nTWO\nthree\n");
  });

  it("resolves a workspace-relative path", async () => {
    const p = join(TMP, "rel.txt");
    writeFileSync(p, "alpha\n");
    const result = await patchHandler(
      { path: "rel.txt", old_string: "alpha", new_string: "beta" },
      ctx(),
    );
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.equal(readFileSync(p, "utf8"), "beta\n");
  });

  it("matches through indentation drift", async () => {
    const p = join(TMP, "indent.ts");
    writeFileSync(p, "function f() {\n    return 1;\n}\n");
    const result = await patchHandler(
      {
        path: p,
        old_string: "function f() {\n  return 1;\n}",
        new_string: "function f() {\n  return 2;\n}",
      },
      ctx(),
    );
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.match(readFileSync(p, "utf8"), /return 2/);
  });

  it("already-applied edit is a success no-op", async () => {
    const p = join(TMP, "already.txt");
    writeFileSync(p, "hello world and more\n");
    const result = await patchHandler(
      { path: p, old_string: "hello there and more", new_string: "hello world and more" },
      ctx(),
    );
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.match(reportText(result), /PATCH APPLIED \(no-op\)/);
    assert.equal(readFileSync(p, "utf8"), "hello world and more\n");
  });

  it("not-found returns an excerpt", async () => {
    const p = join(TMP, "miss.txt");
    writeFileSync(p, "alpha\nzebra\ncharlie\n");
    const result = await patchHandler(
      { path: p, old_string: "bravo and friends", new_string: "BRAVO and friends" },
      ctx(),
    );
    assert.equal(result.returnCode, ToolReturnCode.NotFound);
    assert.match(reportText(result), /^PATCH FAILED/);
    assert.match(reportText(result), /Did you mean|not found|Could not find/i);
  });

  it("ambiguous match asks for more context", async () => {
    const p = join(TMP, "ambig.txt");
    writeFileSync(p, "foo\nbar\nfoo\n");
    const result = await patchHandler(
      { path: p, old_string: "foo", new_string: "baz" },
      ctx(),
    );
    assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
    assert.match(reportText(result), /Found 2 matches/);
  });

  it("replace_all replaces every occurrence", async () => {
    const p = join(TMP, "all.txt");
    writeFileSync(p, "foo\nbar\nfoo\n");
    const result = await patchHandler(
      { path: p, old_string: "foo", new_string: "baz", replace_all: true },
      ctx(),
    );
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.equal(readFileSync(p, "utf8"), "baz\nbar\nbaz\n");
  });

  it("rejects missing replace args", async () => {
    const result = await patchHandler({ path: join(TMP, "x.txt") }, ctx());
    assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
    assert.match(reportText(result), /old_string/);
  });

  it("outside-workspace path needs Bypass permissions", async () => {
    const outsideTmp = mkdtempSync(join(tmpdir(), "jb-patchout-"));
    try {
      const target = join(outsideTmp, "x.txt");
      writeFileSync(target, "a\n");
      const denied = await patchHandler(
        { path: target, old_string: "a", new_string: "b" },
        ctx({ fullPermissionsEnabled: false }),
      );
      assert.equal(denied.returnCode, ToolReturnCode.PermissionDenied);
    } finally {
      rmSync(outsideTmp, { recursive: true, force: true });
    }
  });
});

describe("patch V4A mode", () => {
  it("applies an Update File hunk", async () => {
    const p = join(TMP, "v4a.txt");
    writeFileSync(p, "one\ntwo\nthree\n");
    const patch = [
      "*** Begin Patch",
      `*** Update File: ${p}`,
      " one",
      "-two",
      "+TWO",
      " three",
      "*** End Patch",
    ].join("\n");
    const result = await patchHandler({ mode: "patch", patch }, ctx());
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.match(reportText(result), /PATCH APPLIED — 1 file\(s\) patched/);
    assert.equal(readFileSync(p, "utf8"), "one\nTWO\nthree\n");
  });

  it("treats unprefixed hunk lines as context", async () => {
    const p = join(TMP, "noprefix.txt");
    writeFileSync(p, "keep\nold\nkeep\n");
    const patch = [
      "*** Begin Patch",
      `*** Update File: ${p}`,
      "keep",
      "-old",
      "+new",
      "keep",
      "*** End Patch",
    ].join("\n");
    const result = await patchHandler({ mode: "patch", patch }, ctx());
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.equal(readFileSync(p, "utf8"), "keep\nnew\nkeep\n");
  });

  it("creates a file with Add File", async () => {
    mkdirSync(join(TMP, "made"), { recursive: true });
    const p = join(TMP, "made", "new.txt");
    const patch = [
      "*** Begin Patch",
      `*** Add File: ${p}`,
      "+alpha",
      "+beta",
      "*** End Patch",
    ].join("\n");
    const result = await patchHandler({ mode: "patch", patch }, ctx());
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.match(reportText(result), /Creating file /);
    assert.equal(readFileSync(p, "utf8"), "alpha\nbeta");
  });

  it("fails atomically when a hunk does not match", async () => {
    const p = join(TMP, "atomic.txt");
    writeFileSync(p, "alpha\nzebra\n");
    const patch = [
      "*** Begin Patch",
      `*** Update File: ${p}`,
      " alpha",
      "-bravo",
      "+BRAVO",
      "*** End Patch",
    ].join("\n");
    const result = await patchHandler({ mode: "patch", patch }, ctx());
    assert.equal(result.returnCode, ToolReturnCode.GenericFailure);
    assert.match(reportText(result), /^PATCH FAILED/);
    assert.equal(readFileSync(p, "utf8"), "alpha\nzebra\n");
  });

  it("infers V4A when patch is set without mode or old_string", async () => {
    const p = join(TMP, "infer.txt");
    writeFileSync(p, "a\n");
    const patch = `*** Update File: ${p}\n-a\n+b\n`;
    const result = await patchHandler({ patch }, ctx());
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.equal(readFileSync(p, "utf8"), "b\n");
  });

  it("tags every file_diff part with its path (delete+patch must not shift pairing)", async () => {
    const gone = join(TMP, "gone.txt");
    const kept = join(TMP, "kept.txt");
    writeFileSync(gone, "bye\n");
    writeFileSync(kept, "one\ntwo\nthree\n");
    const patch = [
      "*** Begin Patch",
      `*** Delete File: ${gone}`,
      `*** Update File: ${kept}`,
      "-two",
      "+TWO",
      "*** End Patch",
    ].join("\n");
    const result = await patchHandler({ mode: "patch", patch }, ctx());
    assert.equal(result.returnCode, ToolReturnCode.Success);
    const diffs = result.content.filter(
      (p): p is Extract<(typeof result.content)[number], { type: "text" }> =>
        p.type === "text" && p.id === "file_diff",
    );
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0]!.path, kept.split(sep).join("/"));
  });

  it("tags replace-mode diff parts with the target path", async () => {
    const p = join(TMP, "tagged.txt");
    writeFileSync(p, "one\ntwo\nthree\n");
    const result = await patchHandler(
      { path: p, old_string: "two", new_string: "TWO" },
      ctx(),
    );
    assert.equal(result.returnCode, ToolReturnCode.Success);
    const diff = result.content.find(
      (part): part is Extract<(typeof result.content)[number], { type: "text" }> =>
        part.type === "text" && part.id === "file_diff",
    );
    assert.ok(diff);
    assert.equal(diff.path, p.split(sep).join("/"));
  });

  it("rejects GNU unified diffs via patch_text", async () => {
    const result = await patchHandler(
      {
        patch_text: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n",
      },
      ctx(),
    );
    assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
    assert.match(reportText(result), /no longer accepts GNU unified diffs/);
  });
});

describe("patchFileRiskAssessor", () => {
  it("allows a replace inside the workspace", () => {
    const verdict = patchFileRiskAssessor({
      arguments: { path: join(TMP, "risk.txt"), old_string: "a", new_string: "b" },
      fullPermissionsEnabled: false,
      workspacePath: TMP,
    });
    assert.equal(verdict.action, "allow");
  });

  it("defers an outside-workspace replace", () => {
    const verdict = patchFileRiskAssessor({
      arguments: { path: "/etc/passwd", old_string: "a", new_string: "b" },
      fullPermissionsEnabled: false,
      workspacePath: TMP,
    });
    assert.equal(verdict.action, "defer");
  });

  it("allows a V4A patch whose headers stay in the workspace", () => {
    const verdict = patchFileRiskAssessor({
      arguments: {
        mode: "patch",
        patch: `*** Update File: ${join(TMP, "in.txt")}\n-a\n+b\n`,
      },
      fullPermissionsEnabled: false,
      workspacePath: TMP,
    });
    assert.equal(verdict.action, "allow");
  });
});
