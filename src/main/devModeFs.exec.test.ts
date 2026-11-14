/**
 * devmode executable detection + launch planning (pure parts).
 *
 * listDevModeDir's exec-bit flag and planExecutableLaunch's platform rules
 * are what the renderer trusts — they must not drift from the OS semantics
 * (win: naming convention, posix: exec bit, mac .command → Terminal).
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listDevModeDir, planExecutableLaunch } from "./devModeFs.js";

describe("listDevModeDir executable flag", () => {
  it("marks the exec bit on posix listings", async () => {
    if (process.platform === "win32") return; // no exec bit to observe
    const root = await mkdtemp(join(tmpdir(), "jb-dmexec-"));
    try {
      const tool = join(root, "tool");
      const script = join(root, "deploy.command");
      const plain = join(root, "notes.txt");
      const image = join(root, "JellyBot.dmg");
      await writeFile(tool, "#!/bin/sh\n");
      await writeFile(script, "#!/bin/sh\n");
      await writeFile(plain, "x");
      await writeFile(image, "x");
      await chmod(tool, 0o755);
      await chmod(script, 0o755); // .command needs the bit for Terminal too
      await chmod(image, 0o644); // images never carry the bit — name-based
      const res = await listDevModeDir(root);
      assert.equal(res.ok, true);
      if (!res.ok) return;
      const byName = new Map(res.entries.map((e) => [e.name, e]));
      assert.equal(byName.get("tool")?.executable, true);
      assert.equal(byName.get("deploy.command")?.executable, true);
      assert.equal(byName.get("JellyBot.dmg")?.executable, true);
      assert.equal(byName.get("notes.txt")?.executable, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("planExecutableLaunch", () => {
  it("windows routes whitelisted extensions to the shell open verb", () => {
    for (const ext of ["exe", "bat", "cmd", "com", "lnk", "msi", "EXE", "Cmd"]) {
      assert.deepEqual(
        planExecutableLaunch({ platform: "win32", ext, executableBit: false }),
        { kind: "open-path" },
        ext,
      );
    }
  });

  it("windows rejects everything else regardless of bits", () => {
    assert.equal(
      planExecutableLaunch({ platform: "win32", ext: "txt", executableBit: true })
        .kind,
      "reject",
    );
  });

  it("posix spawns binaries carrying the exec bit", () => {
    assert.deepEqual(
      planExecutableLaunch({ platform: "darwin", ext: "", executableBit: true }),
      { kind: "spawn" },
    );
    assert.deepEqual(
      planExecutableLaunch({ platform: "linux", ext: "sh", executableBit: true }),
      { kind: "spawn" },
    );
  });

  it("posix routes .command/.terminal through the open verb (Terminal)", () => {
    for (const ext of ["command", "terminal", "COMMAND"]) {
      assert.deepEqual(
        planExecutableLaunch({ platform: "darwin", ext, executableBit: true }),
        { kind: "open-path" },
        ext,
      );
    }
  });

  it("macOS mounts .dmg/.pkg via the open verb without an exec bit", () => {
    for (const ext of ["dmg", "pkg", "DMG"]) {
      assert.deepEqual(
        planExecutableLaunch({ platform: "darwin", ext, executableBit: false }),
        { kind: "open-path" },
        ext,
      );
    }
  });

  it("linux does not treat installer images as launchable", () => {
    assert.equal(
      planExecutableLaunch({ platform: "linux", ext: "dmg", executableBit: false })
        .kind,
      "reject",
    );
  });

  it("posix rejects files without the exec bit, with a chmod hint", () => {
    const plan = planExecutableLaunch({
      platform: "darwin",
      ext: "sh",
      executableBit: false,
    });
    assert.equal(plan.kind, "reject");
    if (plan.kind === "reject") assert.match(plan.reason, /chmod/);
  });
});
