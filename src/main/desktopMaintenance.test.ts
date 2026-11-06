import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  compareVersions,
  createDesktopMaintenance,
  isDesktopChannel,
  isTranslocated,
  parseManifestEntry,
  resolveBundlePath,
  type DesktopMaintenanceDeps,
} from "./desktopMaintenance.js";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "desktop-maint-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length > 0) {
    await rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {});
  }
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Windows-flavoured harness: the installer path needs no macOS tooling. */
function harness(overrides: Partial<DesktopMaintenanceDeps> = {}) {
  const dataDir = scratch();
  const bundleDir = join(dataDir, "install");
  const spawned: Array<{ command: string; args: string[] }> = [];
  let exits = 0;
  let relaunches = 0;
  const deps: DesktopMaintenanceDeps = {
    dataDir,
    appVersion: () => "1.5.1",
    execPath: () => join(bundleDir, "Larry Agent.exe"),
    platform: "win32",
    arch: "x64",
    isBusy: () => 0,
    relaunch: () => {
      relaunches += 1;
    },
    exit: () => {
      exits += 1;
    },
    exitDelayMs: 0,
    ...overrides,
  };
  const maintenance = createDesktopMaintenance(deps);
  return {
    maintenance,
    deps,
    dataDir,
    bundleDir,
    spawned,
    get exits() {
      return exits;
    },
    get relaunches() {
      return relaunches;
    },
    spawnProbe: spawned,
  };
}

describe("desktopMaintenance helpers", () => {
  it("resolves the install target per platform", () => {
    assert.equal(
      resolveBundlePath("/Applications/Larry Agent.app/Contents/MacOS/Larry Agent", "darwin"),
      "/Applications/Larry Agent.app",
    );
    assert.equal(resolveBundlePath("/opt/larry", "darwin"), null);
    assert.equal(resolveBundlePath("C:\\Users\\me\\AppData\\Local\\Larry\\Larry.exe", "win32"), "C:\\Users\\me\\AppData\\Local\\Larry");
  });

  it("flags App Translocation (self-update can never work there)", () => {
    assert.equal(
      isTranslocated(
        "/private/var/folders/xy/T/AppTranslocation/57E2-1/d/Larry Agent.app/Contents/MacOS/Larry Agent",
      ),
      true,
    );
    assert.equal(isTranslocated("/Applications/Larry Agent.app/Contents/MacOS/Larry Agent"), false);
  });

  it("picks the zip (not the dmg) for macOS and pins its digest", () => {
    const manifest = {
      mac: {
        version: "1.6.0",
        file: "Larry-Agent-1.6.0-mac-arm64.dmg",
        zipFile: "Larry-Agent-1.6.0-mac-arm64.zip",
        sha256: "aa".repeat(32),
        dmgSha256: "bb".repeat(32),
      },
      win: { version: "1.6.0", file: "Larry-Agent-1.6.0-win-x64-setup.exe", sha256: "cc".repeat(32) },
    };
    assert.deepEqual(parseManifestEntry(manifest, "darwin"), {
      version: "1.6.0",
      file: "Larry-Agent-1.6.0-mac-arm64.zip",
      sha256: "aa".repeat(32),
    });
    assert.deepEqual(parseManifestEntry(manifest, "win32"), {
      version: "1.6.0",
      file: "Larry-Agent-1.6.0-win-x64-setup.exe",
      sha256: "cc".repeat(32),
    });
    assert.equal(parseManifestEntry({ agentd: { version: "1.6.0", file: "x.tgz" } }, "darwin"), null);
    assert.equal(parseManifestEntry(manifest, "linux"), null);
    assert.equal(isDesktopChannel("darwin") && isDesktopChannel("win32") && !isDesktopChannel("linux"), true);
  });

  it("refuses a macOS entry that only ships the dmg (no self-update channel)", () => {
    // `ditto -x -k` cannot unpack a dmg, so handing the console the dmg would
    // download 120 MB and fail at extract time — report "no entry" instead.
    const manifest = {
      mac: {
        version: "1.6.0",
        file: "Larry-Agent-1.6.0-mac-arm64.dmg",
        sha256: "aa".repeat(32),
        dmgSha256: "bb".repeat(32),
      },
    };
    assert.equal(parseManifestEntry(manifest, "darwin"), null);
    // A `.zip` in either field is a usable self-update package.
    assert.deepEqual(
      parseManifestEntry({ mac: { version: "1.6.0", file: "Larry-Agent-1.6.0-mac-arm64.zip", sha256: "aa".repeat(32) } }, "darwin"),
      { version: "1.6.0", file: "Larry-Agent-1.6.0-mac-arm64.zip", sha256: "aa".repeat(32) },
    );
  });

  it("compares dotted versions", () => {
    assert.equal(compareVersions("1.5.2", "1.5.1"), 1);
    assert.equal(compareVersions("1.5.1", "1.5.1"), 0);
    assert.equal(compareVersions("1.4.9", "1.5.0"), -1);
    // Numeric segments only — every release we ship is plain X.Y.Z.
    assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  });
});

describe("desktopMaintenance preflight", () => {
  it("refuses plain-http, unpinned https, relative local and untyped sources", async () => {
    const h = harness();
    await assert.rejects(
      h.maintenance.update({ source: "http://example.com/a.exe" }),
      /plain-http/,
    );
    await assert.rejects(
      h.maintenance.update({ source: "https://example.com/a.exe" }),
      /sha256 \(64 hex chars\) is required/,
    );
    await assert.rejects(h.maintenance.update({ source: "update.exe" }), /absolute device paths/);
  });

  it("refuses while a turn is in flight", async () => {
    const h = harness({ isBusy: () => 2 });
    await assert.rejects(
      h.maintenance.update({ source: "/tmp/whatever.exe" }),
      /turn is in flight in 2 sessions/,
    );
    assert.throws(() => h.maintenance.restart(), /turn is in flight/);
  });

  it("refuses an install location the user cannot write (machine-wide install)", async () => {
    const h = harness({ writableProbe: () => false });
    await assert.rejects(
      h.maintenance.update({ source: "/tmp/whatever.exe" }),
      /install location is not writable/,
    );
  });

  it("refuses a translocated macOS bundle", async () => {
    const h = harness({
      platform: "darwin",
      execPath: () => "/private/var/folders/x/T/AppTranslocation/1/d/Larry Agent.app/Contents/MacOS/Larry Agent",
      bundlePath: "/private/var/folders/x/T/AppTranslocation/1/d/Larry Agent.app",
      writableProbe: () => true,
    });
    await assert.rejects(h.maintenance.update({ source: "/tmp/a.zip" }), /read-only DMG/);
  });

  it("never offers a host reboot", () => {
    const h = harness();
    assert.throws(() => h.maintenance.reboot(), /not supported on desktop devices/);
  });

  it("reports desktop capabilities in deviceStatus", () => {
    const h = harness({ writableProbe: () => true });
    const status = h.maintenance.status() as Record<string, unknown>;
    assert.equal(status.agent, "desktop");
    assert.equal(status.supervised, "electron");
    assert.equal(status.channel, "win-nsis");
    assert.equal(h.maintenance.execSupported, false);
  });
});

describe("desktopMaintenance pipeline", () => {
  it("copies, verifies and hands off to the installer", async () => {
    const dataDir = scratch();
    const bundleDir = join(dataDir, "install");
    await mkdir(bundleDir, { recursive: true });
    const source = join(dataDir, "Larry-Agent-1.6.0-win-x64-setup.exe");
    writeFileSync(source, "installer-bytes");
    const spawned: Array<{ command: string; args: string[] }> = [];
    let exits = 0;
    const maintenance = createDesktopMaintenance({
      dataDir,
      appVersion: () => "1.5.1",
      execPath: () => join(bundleDir, "Larry Agent.exe"),
      platform: "win32",
      arch: "x64",
      isBusy: () => 0,
      relaunch: () => {},
      exit: () => {
        exits += 1;
      },
      exitDelayMs: 0,
      writableProbe: () => true,
      spawnDetached: (command, args) => spawned.push({ command, args }),
    });

    const ack = await maintenance.update({
      source,
      sha256: sha256("installer-bytes"),
      version: "1.6.0",
    });
    assert.equal(ack.queued, true);

    // The pipeline runs in the background — wait for the handoff.
    for (let i = 0; i < 100 && spawned.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0]!.args, ["/S", "--updated", "--force-run"]);
    assert.match(spawned[0]!.command, /release\.exe$/);
    assert.equal(readFileSync(spawned[0]!.command, "utf8"), "installer-bytes");
    assert.equal(exits, 1, "the app exits so the installer can replace the exe");
  });

  it("fails the update when the digest does not match", async () => {
    const dataDir = scratch();
    const bundleDir = join(dataDir, "install");
    await mkdir(bundleDir, { recursive: true });
    const source = join(dataDir, "Larry-Agent-1.6.0-win-x64-setup.exe");
    writeFileSync(source, "installer-bytes");
    const spawned: unknown[] = [];
    const maintenance = createDesktopMaintenance({
      dataDir,
      appVersion: () => "1.5.1",
      execPath: () => join(bundleDir, "Larry Agent.exe"),
      platform: "win32",
      arch: "x64",
      isBusy: () => 0,
      relaunch: () => {},
      exit: () => {},
      writableProbe: () => true,
      spawnDetached: (command, args) => spawned.push({ command, args }),
    });

    await maintenance.update({ source, sha256: "f".repeat(64) });
    for (let i = 0; i < 100 && maintenance.currentState()?.phase !== "failed"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const state = maintenance.currentState();
    assert.equal(state?.phase, "failed");
    assert.match(String(state?.error), /sha256 mismatch/);
    assert.equal(spawned.length, 0, "nothing is executed on a digest mismatch");
  });
});

describe("desktopMaintenance reconcile", () => {
  it("reports done when the relaunched process runs the new version", async () => {
    const dataDir = scratch();
    const stateDir = join(dataDir, "desktop-maintenance");
    await mkdir(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "pending.json"),
      JSON.stringify({
        id: "u1",
        fromVersion: "1.5.1",
        toVersion: "1.6.0",
        source: "https://larryagent.online/download/a.zip",
        phase: "pending",
        ts: Date.now(),
        log: join(stateDir, "helper.log"),
      }),
    );
    const maintenance = createDesktopMaintenance({
      dataDir,
      appVersion: () => "1.6.0",
      execPath: () => "/Applications/Larry Agent.app/Contents/MacOS/Larry Agent",
      platform: "darwin",
      arch: "arm64",
      isBusy: () => 0,
      relaunch: () => {},
      exit: () => {},
      writableProbe: () => true,
    });
    await maintenance.reconcile();
    assert.equal(maintenance.currentState()?.phase, "done");
    const pending = JSON.parse(readFileSync(join(stateDir, "pending.json"), "utf8"));
    assert.equal(pending.phase, "done");
  });

  it("reports failed when the version never moved past the stale window", async () => {
    const dataDir = scratch();
    const stateDir = join(dataDir, "desktop-maintenance");
    await mkdir(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "pending.json"),
      JSON.stringify({
        id: "u2",
        fromVersion: "1.5.1",
        toVersion: "1.6.0",
        source: "https://larryagent.online/download/a.zip",
        phase: "pending",
        ts: Date.now() - 60 * 60_000,
        log: join(stateDir, "helper.log"),
      }),
    );
    const maintenance = createDesktopMaintenance({
      dataDir,
      appVersion: () => "1.5.1",
      execPath: () => "/Applications/Larry Agent.app/Contents/MacOS/Larry Agent",
      platform: "darwin",
      arch: "arm64",
      isBusy: () => 0,
      relaunch: () => {},
      exit: () => {},
      writableProbe: () => true,
    });
    await maintenance.reconcile();
    const state = maintenance.currentState();
    assert.equal(state?.phase, "failed");
    assert.match(String(state?.error), /did not install/);
  });
});
