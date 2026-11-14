import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  parseNetstatListeningEntries,
  parseNetstatListeningPids,
  terminateLaunchedProcess,
  uniquePids,
} from "./killProcessTree.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

describe("parseNetstatListeningPids", () => {
  it("reads the PID for an exact loopback listen port", () => {
    const dump = [
      "Active Connections",
      "",
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    127.0.0.1:513590       0.0.0.0:0              LISTENING       9",
      "  TCP    127.0.0.1:51359        0.0.0.0:0              LISTENING       44520",
      "  TCP    [::1]:51359            [::]:0                 LISTENING       44520",
    ].join("\r\n");
    assert.deepEqual(parseNetstatListeningPids(dump, 51359), [44520]);
    assert.deepEqual(
      [...new Set(parseNetstatListeningEntries(dump).map((row) => row.port))],
      [51359],
    );
  });
});

describe("uniquePids", () => {
  it("drops the current process and duplicates", () => {
    assert.deepEqual(uniquePids([process.pid, 12, 12, 0, undefined, 12]), [12]);
  });
});

describe("terminateLaunchedProcess", () => {
  it("terminates a process launched by the debug session", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    assert.ok(child.pid);
    try {
      await terminateLaunchedProcess(child);
      assert.ok(
        child.exitCode !== null || child.signalCode !== null,
        "child must have exited by code or signal",
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });

  it("kills grandchildren of electron-vite-style wrappers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jb-kill-"));
    const kidPath = join(dir, "kid.pid");
    const nested = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `const kid = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore', windowsHide: true });`,
      `fs.writeFileSync(${JSON.stringify(kidPath)}, String(kid.pid));`,
      "setInterval(() => undefined, 1000);",
    ].join("");
    const child = spawn(process.execPath, ["-e", nested], {
      stdio: "ignore",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    assert.ok(child.pid);
    try {
      const ready = await waitFor(async () => {
        try {
          const raw = (await readFile(kidPath, "utf8")).trim();
          return /^\d+$/.test(raw) && isAlive(Number(raw));
        } catch {
          return false;
        }
      }, 5_000);
      assert.equal(ready, true, "grandchild pid file");
      const kidPid = Number((await readFile(kidPath, "utf8")).trim());
      await terminateLaunchedProcess(child);
      const parentGone = await waitFor(
        () => !isAlive(child.pid!),
        5_000,
      );
      const kidGone = await waitFor(() => !isAlive(kidPid), 5_000);
      assert.equal(parentGone, true, "wrapper process must exit");
      assert.equal(kidGone, true, "grandchild must not stay orphaned");
    } finally {
      try {
        if (child.pid && isAlive(child.pid)) {
          if (process.platform === "win32") {
            spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true,
            });
          } else {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        }
      } catch {
        /* ignore */
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves an absent pre-existing process handle alone", async () => {
    await terminateLaunchedProcess(undefined);
  });
});
