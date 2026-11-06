/**
 * Root reboot oneshot: validate the request, delete it before reboot, and
 * record failure when systemctl reboot does not succeed.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runRebootWorker } from "./rebootWorker.js";
import { resolveAgentdUpdateQueueDir, resolveAgentdUpdateStatusDir } from "./config.js";

const base = mkdtempSync(join(tmpdir(), "jb-reboot-"));
const dataDir = join(base, "data");

after(() => {
  rmSync(base, { recursive: true, force: true });
});

function queue(body: unknown): void {
  const dir = resolveAgentdUpdateQueueDir(dataDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "reboot.json"), JSON.stringify(body), "utf8");
}

function status(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(resolveAgentdUpdateStatusDir(dataDir), "current.json"), "utf8"),
  ) as Record<string, unknown>;
}

describe("rebootWorker", () => {
  it("deletes the request and reports running when reboot is accepted", async () => {
    queue({ id: "r1" });
    const calls: string[][] = [];
    const code = await runRebootWorker({
      dataDir,
      out: () => {},
      spawnFn: ((cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        return { status: 0, stderr: "", stdout: "" };
      }) as never,
    });
    assert.equal(code, 0);
    assert.deepEqual(calls, [["systemctl", "reboot"]]);
    assert.equal(status().phase, "running");
    assert.equal(status().source, "reboot");
    let left = true;
    try {
      readFileSync(join(resolveAgentdUpdateQueueDir(dataDir), "reboot.json"));
    } catch {
      left = false;
    }
    assert.equal(left, false);
  });

  it("records failure and still drops the request when reboot is refused", async () => {
    queue({ id: "r2" });
    const code = await runRebootWorker({
      dataDir,
      out: () => {},
      spawnFn: (() => ({ status: 1, stderr: "access denied", stdout: "" })) as never,
    });
    assert.equal(code, 1);
    assert.equal(status().phase, "failed");
    assert.match(String(status().error), /access denied/);
    let left = true;
    try {
      readFileSync(join(resolveAgentdUpdateQueueDir(dataDir), "reboot.json"));
    } catch {
      left = false;
    }
    assert.equal(left, false);
  });

  it("drops a request that has no id", async () => {
    queue({ nope: true });
    const code = await runRebootWorker({ dataDir, out: () => {}, spawnFn: (() => ({ status: 0 })) as never });
    assert.equal(code, 0);
    assert.equal(status().phase, "failed");
    assert.match(String(status().error), /id/);
  });
});
