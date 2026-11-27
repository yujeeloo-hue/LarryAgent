import assert from "node:assert/strict";
import test from "node:test";
import {
  MAINTENANCE_CHECK_TTL_MS,
  MaintenanceReleaseChecker,
  canFillMaintenanceRelease,
  type MaintenanceCheckTarget,
  type MaintenanceRelease,
} from "../src/maintenanceAutoCheck.js";

const target: MaintenanceCheckTarget = {
  deviceId: "linux-node", platform: "linux arm64", version: "1.5.7", manifestUrl: "https://dl.test/downloads.json",
};
const release: MaintenanceRelease = {
  version: "1.5.8", url: "https://dl.test/jellybot-agentd-1.5.8-linux-arm64.tar.gz", sha256: "a".repeat(64),
};

test("automatic reads are cached for five minutes; manual Fetch latest bypasses the TTL", async () => {
  let now = 1000;
  let calls = 0;
  const checker = new MaintenanceReleaseChecker(async () => { calls++; return release; }, () => now);
  assert.equal(checker.state(target), null);
  const result = await checker.check(target);
  assert.equal(result?.entry?.version, "1.5.8");
  assert.equal(result?.checkedAt, 1000);
  assert.equal(checker.check(target), null);
  now += MAINTENANCE_CHECK_TTL_MS - 1;
  assert.equal(checker.check(target), null);
  await checker.check(target, true);
  assert.equal(calls, 2);
  now += MAINTENANCE_CHECK_TTL_MS;
  await checker.check(target);
  assert.equal(calls, 3);
});

test("progress pushes and repeated clicks cannot duplicate an in-flight request", async () => {
  let resolve!: (value: MaintenanceRelease) => void;
  let calls = 0;
  const checker = new MaintenanceReleaseChecker(() => { calls++; return new Promise(done => { resolve = done; }); });
  const pending = checker.check(target);
  assert.equal(checker.state(target)?.checking, true);
  assert.equal(checker.check(target), null);
  assert.equal(checker.check(target, true), null);
  await Promise.resolve();
  resolve(release);
  await pending;
  assert.equal(calls, 1);
  assert.equal(checker.state(target)?.checking, false);
});

test("device, platform, installed version and manifest URL have independent caches", async () => {
  let calls = 0;
  const checker = new MaintenanceReleaseChecker(async () => { calls++; return release; });
  await checker.check(target);
  for (const patch of [{ deviceId: "another-node" }, { platform: "linux x64" }, { version: "1.5.8" }, { manifestUrl: "https://dl.test/other.json" }]) {
    await checker.check({ ...target, ...patch });
  }
  assert.equal(calls, 5);
  assert.equal(checker.check({ ...target, manifestUrl: ` ${target.manifestUrl} ` }), null);
});

test("network errors stay in state and back off instead of retrying on every render", async () => {
  let now = 1000;
  let fail = true;
  const checker = new MaintenanceReleaseChecker(async () => {
    if (fail) throw new Error("device disconnected");
    return release;
  }, () => now);
  const result = await checker.check(target);
  assert.equal(result?.error, "device disconnected");
  assert.equal(result?.checking, false);
  assert.equal(checker.check(target), null);
  now += 59_999;
  assert.equal(checker.check(target), null);
  fail = false;
  now++;
  assert.equal((await checker.check(target))?.error, null);
});

test("manual retry remains available during the failure backoff", async () => {
  let fail = true;
  const checker = new MaintenanceReleaseChecker(async () => { if (fail) throw new Error("offline"); return release; });
  await checker.check(target);
  fail = false;
  assert.equal((await checker.check(target, true))?.entry?.version, "1.5.8");
});

test("a missing entry or another platform's package never becomes a selected release", async () => {
  const missing = new MaintenanceReleaseChecker(async () => null);
  assert.match((await missing.check(target))?.error ?? "", /no agentd release/);
  const wrong = new MaintenanceReleaseChecker(async () => ({ ...release, url: "https://dl.test/Larry-Agent-1.5.8-win-x64-setup.exe" }));
  const result = await wrong.check(target);
  assert.match(result?.error ?? "", /another platform/);
  assert.equal(result?.entry, null);
});

test("automatic fills preserve custom sources, edited hashes and changes made while fetching", () => {
  const empty = { source: "", sha256: "" };
  const fetched = { source: release.url, sha256: release.sha256!, version: release.version };
  const custom = { source: "/tmp/custom.tar.gz", sha256: "" };
  assert.equal(canFillMaintenanceRelease(empty, empty, false, false), true);
  assert.equal(canFillMaintenanceRelease(fetched, fetched, false, false), true);
  assert.equal(canFillMaintenanceRelease(custom, custom, false, false), false);
  assert.equal(canFillMaintenanceRelease(fetched, fetched, false, true), false);
  assert.equal(canFillMaintenanceRelease(fetched, { ...fetched, sha256: "edited" }, true, false), false);
  assert.equal(canFillMaintenanceRelease(empty, custom, false, false), false);
  assert.equal(canFillMaintenanceRelease(custom, custom, true, true), true);
});
