import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, mock, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { ToolReturnCode } from "../../session/returnCodes.js";
import { fileLockToken, releaseStreamingReservation, reserveStreamingWrite, resetFileLocksForTests } from "../fileLock.js";
import { resolveToolPath } from "../pathUtil.js";
import { assessFileWriteRisk, patchFileRiskAssessor } from "../policy/fileToolRisk.js";
import type { ToolExecuteContext } from "../types.js";
import { runGrep } from "./grep.js";
import { listDirHandler } from "./listDir.js";
import { patchHandler } from "./patch.js";
import { readFileHandler } from "./readFile.js";
import { writeFileHandler } from "./writeFile.js";
import { writePlanDocHandler } from "./writePlanDoc.js";

const roots: string[] = [];
afterEach(() => {
  resetFileLocksForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jb-workspace-symlinks-"));
  roots.push(root);
  const workspacePath = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(workspacePath);
  mkdirSync(outside);
  writeFileSync(join(outside, "file.txt"), "outside-original");
  const link = join(workspacePath, "external");
  directoryLink(outside, link);
  const context: ToolExecuteContext = { workspacePath, fullPermissionsEnabled: false };
  return { root, workspacePath, outside, link, context };
}

function directoryLink(target: string, path: string) {
  // Junctions work on Windows without the privilege required for file symlinks.
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

function fileLink(t: TestContext, target: string, path: string): boolean {
  try {
    symlinkSync(target, path, "file");
    return true;
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    t.skip("Windows file symlink privilege is unavailable; junction cases still run");
    return false;
  }
}

describe("workspace symlink confinement", () => {
  it("rejects existing targets and missing descendants through an external directory link", () => {
    const f = fixture();
    for (const name of ["file.txt", "new.txt", "new/nested/file.txt"]) {
      for (const path of [join(f.link, name), pathToFileURL(join(f.link, name)).href]) {
        const result = resolveToolPath(path, {
          workspacePath: f.workspacePath, allowOutsideWorkspace: false,
        });
        assert.equal(result.ok, false, path);
        if (!result.ok) assert.equal(result.returnCode, ToolReturnCode.PermissionDenied);
      }
    }
  });

  it("rejects escaping file links and dangling links", (t) => {
    const f = fixture();
    for (const name of ["file.txt", "missing.txt"]) {
      const path = join(f.workspacePath, name);
      if (!fileLink(t, join(f.outside, name), path)) return;
      const result = resolveToolPath(path, { workspacePath: f.workspacePath, allowOutsideWorkspace: false });
      assert.equal(result.ok, false, name);
    }
  });

  it("fails closed for link loops", () => {
    const f = fixture();
    const path = join(f.workspacePath, "loop");
    directoryLink(path, path);
    assert.equal(resolveToolPath(join(path, "file"), {
      workspacePath: f.workspacePath, allowOutsideWorkspace: false,
    }).ok, false);
  });

  it("fails closed on resolution errors while preserving Bypass filesystem semantics", () => {
    const f = fixture();
    const failing = mock.method(realpathSync, "native", () => {
      throw Object.assign(new Error("simulated filesystem error"), { code: "EACCES" });
    });
    try {
      const path = join(f.workspacePath, "file.txt");
      assert.equal(resolveToolPath(path, { workspacePath: f.workspacePath, allowOutsideWorkspace: false }).ok, false);
      assert.equal(resolveToolPath(path, { workspacePath: f.workspacePath, allowOutsideWorkspace: true }).ok, true);
    } finally {
      failing.mock.restore();
    }
  });

  it("accepts internal links, a symlinked workspace root, and names beginning with two dots", async () => {
    const f = fixture();
    const actual = join(f.workspacePath, "..valid");
    mkdirSync(actual);
    const internal = join(f.workspacePath, "internal");
    directoryLink(actual, internal);
    const alias = join(f.root, "workspace-alias");
    directoryLink(f.workspacePath, alias);
    for (const path of [join(actual, "new/file.txt"), join(internal, "new/file.txt"), join(alias, "internal/new/file.txt")]) {
      const context = { ...f.context, workspacePath: path.startsWith(alias) ? alias : f.workspacePath };
      const result = await writeFileHandler({ path, content: "inside" }, context);
      assert.equal(result.returnCode, ToolReturnCode.Success);
      assert.equal(readFileSync(path, "utf8"), "inside");
    }
  });

  it("does not fast-approve symlink escapes in file and multi-file patch assessments", () => {
    const f = fixture();
    assert.equal(assessFileWriteRisk({
      ...f.context, arguments: { path: join(f.link, "new.txt") },
    }).action, "defer");
    assert.equal(patchFileRiskAssessor({
      ...f.context, arguments: { patch: "*** Begin Patch\n*** Add File: external/new.txt\n+unsafe\n*** End Patch" },
    }).action, "defer");
  });

  it("blocks read, write, list, and replace tools without touching external data", async () => {
    const f = fixture();
    const path = join(f.link, "file.txt");
    const results = [
      await readFileHandler({ path }, f.context),
      await writeFileHandler({ path, content: "changed" }, f.context),
      await listDirHandler({ path: f.link }, f.context),
      await patchHandler({ path, old_string: "outside-original", new_string: "changed" }, f.context),
    ];
    for (const result of results) assert.equal(result.returnCode, ToolReturnCode.PermissionDenied);
    assert.equal(readFileSync(join(f.outside, "file.txt"), "utf8"), "outside-original");
  });

  it("rejects V4A add, update, delete, and move escapes before applying any operation", async () => {
    const f = fixture();
    const source = join(f.workspacePath, "source.txt");
    writeFileSync(source, "source");
    const operations = [
      "*** Add File: external/new/nested.txt\n+new",
      "*** Update File: external/file.txt\n@@\n-outside-original\n+changed",
      "*** Delete File: external/file.txt",
      "*** Move File: source.txt -> external/moved.txt",
    ];
    for (const operation of operations) {
      const result = await patchHandler({ patch: `*** Begin Patch\n${operation}\n*** End Patch` }, f.context);
      assert.equal(result.returnCode, ToolReturnCode.PermissionDenied, operation);
    }
    assert.equal(readFileSync(join(f.outside, "file.txt"), "utf8"), "outside-original");
    assert.equal(readFileSync(source, "utf8"), "source");
    assert.deepEqual(readdirSync(f.outside), ["file.txt"]);
  });

  it("keeps Bypass access to external links and new descendants", async () => {
    const f = fixture();
    const context = { ...f.context, fullPermissionsEnabled: true };
    const path = join(f.link, "new/nested.txt");
    assert.equal((await writeFileHandler({ path, content: "bypass" }, context)).returnCode, 0);
    assert.equal((await patchHandler({ path, old_string: "bypass", new_string: "updated" }, context)).returnCode, 0);
    assert.equal((await readFileHandler({ path }, context)).returnCode, 0);
    assert.equal(readFileSync(join(f.outside, "new/nested.txt"), "utf8"), "updated");
  });

  it("does not leak an external file symlink through recursive grep", async (t) => {
    const f = fixture();
    if (!fileLink(t, join(f.outside, "file.txt"), join(f.workspacePath, "leak.txt"))) return;
    const restricted = await runGrep({ pattern: "outside-original", context: f.context });
    assert.equal(restricted.returnCode, 0);
    assert.doesNotMatch(restricted.text, /leak\.txt:/);
    const bypass = await runGrep({ pattern: "outside-original", context: { ...f.context, fullPermissionsEnabled: true } });
    assert.match(bypass.text, /leak\.txt:1:outside-original/);
  });

  it("checks plan-document parents before creating files", async () => {
    const f = fixture();
    directoryLink(f.outside, join(f.workspacePath, "docs"));
    const result = await writePlanDocHandler({ title: "Test", content: "# Plan", summary: "Test" }, f.context);
    assert.equal(result.returnCode, ToolReturnCode.PermissionDenied);
    assert.deepEqual(readdirSync(f.outside), ["file.txt"]);
    const bypass = await writePlanDocHandler({ title: "Test", content: "# Plan", summary: "Test" }, { ...f.context, fullPermissionsEnabled: true });
    assert.equal(bypass.returnCode, 0);
  });

  it("preserves unlink semantics for internal file symlinks", async (t) => {
    const f = fixture();
    const target = join(f.workspacePath, "target.txt");
    const link = join(f.workspacePath, "alias.txt");
    writeFileSync(target, "keep target");
    if (!fileLink(t, target, link)) return;
    const result = await patchHandler({ patch: "*** Begin Patch\n*** Delete File: alias.txt\n*** End Patch" }, f.context);
    assert.equal(result.returnCode, 0);
    assert.equal(existsSync(link), false);
    assert.equal(readFileSync(target, "utf8"), "keep target");
  });

  for (const tool of ["read", "write", "patch"] as const) {
    it(`rechecks ${tool} after waiting for a file lock`, async () => {
      const f = fixture();
      const dir = join(f.workspacePath, "queued");
      mkdirSync(dir);
      const path = join(dir, "file.txt");
      writeFileSync(path, "inside");
      const token = fileLockToken("holder", "streaming");
      reserveStreamingWrite(path, token);
      const pending = tool === "read"
        ? readFileHandler({ path }, f.context)
        : tool === "write"
          ? writeFileHandler({ path, content: "changed" }, f.context)
          : patchHandler({ path, old_string: "inside", new_string: "changed" }, f.context);
      renameSync(dir, join(f.workspacePath, "original-queued"));
      directoryLink(f.outside, dir);
      releaseStreamingReservation(path, token);
      assert.equal((await pending).returnCode, ToolReturnCode.PermissionDenied);
      assert.equal(readFileSync(join(f.outside, "file.txt"), "utf8"), "outside-original");
    });
  }
});
