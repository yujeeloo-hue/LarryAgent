/**
 * deviceMaintenance — the agentd-side maintenance surface behind the
 * remoteBridge actions: queue-mode update requests, status-file watching,
 * restart supervision gate, reboot sudo probe, manifest check.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createDeviceMaintenance } from "./deviceMaintenance.js";
import { resolveAgentdUpdateQueueDir, resolveAgentdUpdateStatusDir } from "./config.js";

const HEX64 = "a".repeat(64);

let base: string;
let dataDir: string;
let installDir: string;
const prevInstallDir = process.env.JELLYBOT_AGENTD_INSTALL_DIR;

before(() => {
  base = mkdtempSync(join(tmpdir(), "jb-maint-"));
  dataDir = join(base, "data");
  installDir = join(base, "opt");
  mkdirSync(dataDir, { recursive: true });
  process.env.JELLYBOT_AGENTD_INSTALL_DIR = installDir;
});

after(() => {
  if (prevInstallDir === undefined) delete process.env.JELLYBOT_AGENTD_INSTALL_DIR;
  else process.env.JELLYBOT_AGENTD_INSTALL_DIR = prevInstallDir;
  rmSync(base, { recursive: true, force: true });
});

function makeMaintenance(overrides: Record<string, unknown> = {}) {
  const states: Array<Record<string, unknown>> = [];
  const restarts: string[] = [];
  const maintenance = createDeviceMaintenance({
    dataDir,
    version: "1.3.1-test",
    requestRestart: () => restarts.push("restart"),
    onStateChange: (state) => states.push({ ...state }),
    pollIntervalMs: 20,
    updaterReady: () => true,
    rebootReady: () => false,
    updateBusy: () => false,
    rebootBusy: () => false,
    ...overrides,
  });
  return { maintenance, states, restarts };
}

describe("deviceMaintenance", () => {
  it("update queues a request + state file and reports it (production path)", async () => {
    const { maintenance, states } = makeMaintenance();
    try {
      const result = await maintenance.update({ source: "https://dl.test/x.tar.gz", sha256: HEX64, force: true });
      assert.equal(result.mode, "updater");
      assert.equal(result.queued, true);

      const request = JSON.parse(
        readFileSync(join(resolveAgentdUpdateQueueDir(dataDir), "request.json"), "utf8"),
      ) as { id: string; source: string; sha256: string; force: boolean };
      assert.equal(request.source, "https://dl.test/x.tar.gz");
      assert.equal(request.sha256, HEX64);
      assert.equal(request.force, true);
      assert.equal(request.id, result.id);

      const state = JSON.parse(
        readFileSync(join(resolveAgentdUpdateStatusDir(dataDir), "current.json"), "utf8"),
      ) as { phase: string; id: string };
      assert.equal(state.phase, "queued");
      assert.equal(state.id, result.id);
      assert.ok(states.some((s) => s.phase === "queued"));
    } finally {
      maintenance.stop();
    }
  });

  it("rejects URL sources without a pinned sha256 and relative local paths", async () => {
    const { maintenance } = makeMaintenance();
    try {
      await assert.rejects(maintenance.update({ source: "https://dl.test/x.tar.gz" }), /sha256/);
      await assert.rejects(maintenance.update({ source: "relative.tar.gz" }), /absolute/);
    } finally {
      maintenance.stop();
    }
  });

  it("watches update-status/current.json and surfaces phase changes", async () => {
    const { maintenance, states } = makeMaintenance({ pollIntervalMs: 15 });
    try {
      const statusDir = resolveAgentdUpdateStatusDir(dataDir);
      mkdirSync(statusDir, { recursive: true });
      const statusFile = join(statusDir, "current.json");
      writeFileSync(statusFile, JSON.stringify({ phase: "running", id: "u", ts: Date.now() }), "utf8");
      await new Promise((r) => setTimeout(r, 120));
      assert.ok(states.some((s) => s.phase === "running"), `poller saw running (got ${JSON.stringify(states)})`);
      assert.equal(maintenance.currentState()?.phase, "running");

      // Bootstrap read: a fresh instance must surface the persisted phase
      // immediately (e.g. "done" written by the updater before our restart).
      const bootStates: Array<Record<string, unknown>> = [];
      const second = createDeviceMaintenance({
        dataDir,
        version: "1.3.1-test",
        requestRestart: () => {},
        onStateChange: (state) => bootStates.push({ ...state }),
        pollIntervalMs: 5_000,
      });
      try {
        assert.equal(second.currentState()?.phase, "running");
        assert.ok(bootStates.some((s) => s.phase === "running"));
      } finally {
        second.stop();
      }
    } finally {
      maintenance.stop();
    }
  });

  it("restart refuses without systemd supervision and acks + schedules with it", async () => {
    const { maintenance, restarts } = makeMaintenance();
    try {
      assert.throws(() => maintenance.restart(), /systemd supervision/);

      process.env.INVOCATION_ID = "test-invocation";
      try {
        const ack = maintenance.restart() as { restarting: boolean; supervisor: string };
        assert.equal(ack.restarting, true);
        assert.equal(ack.supervisor, "systemd");
        await new Promise((r) => setTimeout(r, 550));
        assert.equal(restarts.length, 1, "requestRestart fires after the flush window");
      } finally {
        delete process.env.INVOCATION_ID;
      }
    } finally {
      maintenance.stop();
    }
  });

  it("reboot queues a root request when the channel is up, and refuses when it is not", async () => {
    const denied = makeMaintenance();
    try {
      await assert.rejects(denied.maintenance.reboot(), /install-updater/);
    } finally {
      denied.maintenance.stop();
    }

    const rebootData = join(base, "reboot-data");
    mkdirSync(rebootData, { recursive: true });
    const states: Array<Record<string, unknown>> = [];
    const maintenance = createDeviceMaintenance({
      dataDir: rebootData,
      version: "1.3.1-test",
      requestRestart: () => {},
      onStateChange: (state) => states.push({ ...state }),
      rebootReady: () => true,
      pollIntervalMs: 60_000,
    });
    try {
      assert.deepEqual(await maintenance.reboot(), { rebooting: true });
      const request = JSON.parse(
        readFileSync(join(resolveAgentdUpdateQueueDir(rebootData), "reboot.json"), "utf8"),
      ) as { id: string };
      assert.ok(request.id);
      assert.ok(states.some((s) => s.phase === "queued" && s.source === "reboot"));
    } finally {
      maintenance.stop();
    }
  });

  it("checkUpdate resolves the agentd manifest entry against the manifest URL", async () => {
    const { maintenance } = makeMaintenance({
      fetchFn: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          agentd: { version: "1.3.1", file: "jellybot-agentd-1.3.1-linux-arm64.tar.gz", sha256: HEX64 },
        }),
      })) as never,
    });
    try {
      const entry = await maintenance.checkUpdate("https://dl.test/download/downloads.json");
      assert.deepEqual(entry, {
        version: "1.3.1",
        url: "https://dl.test/download/jellybot-agentd-1.3.1-linux-arm64.tar.gz",
        sha256: HEX64,
      });
    } finally {
      maintenance.stop();
    }
  });

  it("status reports install layout and maintenance snapshot", async () => {
    mkdirSync(join(installDir, "1.3.0"), { recursive: true });
    mkdirSync(join(installDir, "1.3.1"), { recursive: true });
    const { maintenance } = makeMaintenance();
    try {
      const status = maintenance.status() as Record<string, unknown>;
      assert.equal(status.version, "1.3.1-test");
      assert.equal(status.installDir, installDir);
      assert.deepEqual(status.releases, ["1.3.0", "1.3.1"]);
      assert.equal(status.supervised, false);
      assert.ok(typeof status.pid === "number");
      assert.ok(String(status.platform).includes(process.platform));
    } finally {
      maintenance.stop();
      rmSync(join(installDir, "1.3.0"), { recursive: true, force: true });
      rmSync(join(installDir, "1.3.1"), { recursive: true, force: true });
    }
  });

  it("refuses http, a down updater, and a second update while one is fresh", async () => {
    const downData = join(base, "down-data");
    mkdirSync(downData, { recursive: true });
    const down = createDeviceMaintenance({
      dataDir: downData,
      version: "1.3.1-test",
      requestRestart: () => {},
      updaterReady: () => false,
      pollIntervalMs: 60_000,
    });
    try {
      await assert.rejects(
        down.update({ source: "https://dl.test/x.tar.gz", sha256: HEX64 }),
        /updater is not active/,
      );
      assert.equal(existsSync(join(resolveAgentdUpdateQueueDir(downData), "request.json")), false);
    } finally {
      down.stop();
    }

    const liveData = join(base, "live-data");
    mkdirSync(liveData, { recursive: true });
    const maintenance = createDeviceMaintenance({
      dataDir: liveData,
      version: "1.3.1-test",
      requestRestart: () => {},
      updaterReady: () => true,
      updateBusy: () => false,
      pollIntervalMs: 60_000,
    });
    try {
      await assert.rejects(
        maintenance.update({ source: "http://dl.test/x.tar.gz", sha256: HEX64 }),
        /https only/,
      );
      const first = await maintenance.update({ source: "https://dl.test/x.tar.gz", sha256: HEX64 });
      assert.equal(first.mode, "updater");
      await assert.rejects(
        maintenance.update({ source: "https://dl.test/y.tar.gz", sha256: HEX64 }),
        /already in flight/,
      );
    } finally {
      maintenance.stop();
    }
  });

  it("rewrites a stale running phase to failed when the updater oneshot is idle", () => {
    const staleData = join(base, "stale-data");
    mkdirSync(staleData, { recursive: true });
    const statusDir = resolveAgentdUpdateStatusDir(staleData);
    mkdirSync(statusDir, { recursive: true });
    const clock = 10_000_000;
    writeFileSync(
      join(statusDir, "current.json"),
      JSON.stringify({
        phase: "running",
        id: "old",
        source: "https://dl.test/x.tar.gz",
        ts: clock - 120_000,
      }),
    );
    const maintenance = createDeviceMaintenance({
      dataDir: staleData,
      version: "1.3.1-test",
      requestRestart: () => {},
      now: () => clock,
      pollIntervalMs: 60_000,
      updaterReady: () => true,
      updateBusy: () => false,
    });
    try {
      assert.equal(maintenance.currentState()?.phase, "failed");
      assert.match(String(maintenance.currentState()?.error ?? ""), /stopped reporting/);
    } finally {
      maintenance.stop();
    }
  });

  it("settles a pre-boot reboot record as done (a real reboot cannot report success)", async () => {
    const bootData = join(base, "boot-data");
    const statusDir = resolveAgentdUpdateStatusDir(bootData);
    mkdirSync(statusDir, { recursive: true });
    const clock = 10_000_000;
    writeFileSync(
      join(statusDir, "current.json"),
      JSON.stringify({
        phase: "running",
        id: "rb-1",
        source: "reboot",
        logTail: "rebooting the host",
        ts: clock - 120_000, // stamped two minutes ago — before this boot
      }),
    );
    const maintenance = createDeviceMaintenance({
      dataDir: bootData,
      version: "1.3.3-test",
      requestRestart: () => {},
      now: () => clock,
      uptimeFn: () => 60, // booted 60s ago → boot stamp = clock − 60_000
      pollIntervalMs: 60_000,
      rebootBusy: () => false,
    });
    try {
      const state = maintenance.currentState();
      assert.equal(state?.phase, "done");
      assert.equal(state?.id, "rb-1");
      assert.equal(state?.error, undefined);
      assert.match(String(state?.logTail ?? ""), /host rebooted/);
      // Persisted, so a console reload reads done too.
      await new Promise((r) => setTimeout(r, 50));
      const onDisk = JSON.parse(readFileSync(join(statusDir, "current.json"), "utf8")) as {
        phase: string;
      };
      assert.equal(onDisk.phase, "done");
    } finally {
      maintenance.stop();
    }
  });

  it("a stale reboot record from THIS boot still fails via the watchdog", () => {
    const sameBootData = join(base, "same-boot-data");
    const statusDir = resolveAgentdUpdateStatusDir(sameBootData);
    mkdirSync(statusDir, { recursive: true });
    const clock = 10_000_000;
    writeFileSync(
      join(statusDir, "current.json"),
      JSON.stringify({
        phase: "running",
        id: "rb-2",
        source: "reboot",
        logTail: "rebooting the host",
        ts: clock - 120_000, // stale, but stamped AFTER this boot
      }),
    );
    const maintenance = createDeviceMaintenance({
      dataDir: sameBootData,
      version: "1.3.3-test",
      requestRestart: () => {},
      now: () => clock,
      uptimeFn: () => 3600, // booted an hour ago → the ts is post-boot
      pollIntervalMs: 60_000,
      rebootBusy: () => false,
    });
    try {
      assert.equal(maintenance.currentState()?.phase, "failed");
      assert.match(String(maintenance.currentState()?.error ?? ""), /did not start/);
    } finally {
      maintenance.stop();
    }
  });

  it("a fresh queued reboot record is left untouched", () => {
    const freshData = join(base, "fresh-reboot-data");
    const statusDir = resolveAgentdUpdateStatusDir(freshData);
    mkdirSync(statusDir, { recursive: true });
    const clock = 10_000_000;
    writeFileSync(
      join(statusDir, "current.json"),
      JSON.stringify({ phase: "queued", id: "rb-3", source: "reboot", ts: clock - 1000 }),
    );
    const maintenance = createDeviceMaintenance({
      dataDir: freshData,
      version: "1.3.3-test",
      requestRestart: () => {},
      now: () => clock,
      uptimeFn: () => 3600,
      pollIntervalMs: 60_000,
      rebootBusy: () => false,
    });
    try {
      assert.equal(maintenance.currentState()?.phase, "queued");
    } finally {
      maintenance.stop();
    }
  });

  it("falls back to in-process updates when the queue channel is broken", async () => {
    // Break the queue: a FILE at the queue dir path makes every mkdir fail.
    const blockedData = join(base, "blocked-data");
    mkdirSync(blockedData, { recursive: true });
    writeFileSync(join(blockedData, "update-queue"), "not a directory", "utf8");

    const tarball = await buildTinyTarball(join(base, "src-tarball"));
    const states: Array<Record<string, unknown>> = [];
    const restarts: string[] = [];
    const maintenance = createDeviceMaintenance({
      dataDir: blockedData,
      version: "1.3.1-test",
      requestRestart: () => restarts.push("restart"),
      onStateChange: (state) => states.push({ ...state }),
      pollIntervalMs: 20,
    });
    try {
      const result = await maintenance.update({ source: tarball.path, force: true });
      assert.equal(result.mode, "in-process");
      // Wait for the background run to settle (done/failed either way).
      await new Promise((r) => setTimeout(r, 800));
      const phases = states.map((s) => s.phase);
      assert.ok(phases.includes("running"), `saw running (got ${phases.join(",")})`);
      const final = maintenance.currentState();
      assert.ok(final, "final state recorded");
      if (final?.phase === "done") {
        assert.equal(final.version, "9.9.9");
        assert.ok(existsSync(join(installDir, "current")));
      }
    } finally {
      maintenance.stop();
    }
  });
});

/** Minimal agentd-shaped tarball: package.json + a fake vendored node/entry. */
async function buildTinyTarball(workDir: string): Promise<{ path: string; sha256: string }> {
  const { createHash } = await import("node:crypto");
  const { spawnSync } = await import("node:child_process");
  const rootName = "jellybot-agentd-9.9.9";
  const root = join(workDir, rootName);
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "lib", "node", "bin"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "jellybot-agentd", version: "9.9.9" }), "utf8");
  writeFileSync(join(root, "lib", "agentd.mjs"), "// stub entry\n", "utf8");
  writeFileSync(
    join(root, "lib", "node", "bin", "node"),
    "#!/bin/sh\nprintf 'jellybot-agentd 9.9.9\\n'\n",
    { mode: 0o755 },
  );
  writeFileSync(join(root, "bin", "agentd"), "#!/bin/sh\n:", { mode: 0o755 });
  const tarball = join(workDir, "release.tar.gz");
  const tar = spawnSync("tar", ["-czf", tarball, "-C", workDir, rootName], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  assert.equal(tar.status, 0, `tar failed: ${String(tar.stderr)}`);
  return {
    path: tarball,
    sha256: createHash("sha256").update(readFileSync(tarball)).digest("hex"),
  };
}
