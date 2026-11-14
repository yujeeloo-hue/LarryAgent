/**
 * devTaskConfig — `.larry/tasks.json` parsing/validation (pure, no Electron).
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  DEV_TASK_DEFAULT_TIMEOUT_MS,
  DEV_TASKS_FILE_REL,
  parseDevTasksConfig,
  readDevTasksConfig,
} from "./devTaskConfig.js";

// Platform-neutral fake workspace: a POSIX-style root is not absolute on
// win32, where resolve("/tmp/ws", "src/App") yields "E:\tmp\ws\src\App".
const WS = process.platform === "win32" ? "C:/jb-test-ws" : "/tmp/ws";

describe("parseDevTasksConfig", () => {
  it("accepts an empty object and defaults everything", () => {
    const res = parseDevTasksConfig({}, WS);
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.tasks, {});
  });

  it("fills defaults: cwd = workspace, default timeout, no env", () => {
    const res = parseDevTasksConfig(
      { version: 1, tasks: { build: { command: "dotnet build" } } },
      WS,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const build = res.tasks.build!;
    assert.equal(build.command, "dotnet build");
    assert.equal(build.cwd, WS);
    assert.equal(build.timeoutMs, DEV_TASK_DEFAULT_TIMEOUT_MS);
    assert.deepEqual(build.env, {});
  });

  it("resolves relative cwd against the workspace and clamps timeout", () => {
    const res = parseDevTasksConfig(
      {
        tasks: {
          run: {
            command: "dotnet run",
            cwd: "src/App",
            timeoutMs: 99_999_999,
          },
        },
      },
      WS,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.tasks.run!.cwd, resolve(WS, "src/App"));
    assert.ok(res.tasks.run!.timeoutMs <= 28_800_000);
  });

  it("accepts numeric-string timeout and env vars", () => {
    const res = parseDevTasksConfig(
      {
        tasks: {
          build: { command: "make", timeoutMs: "30000", env: { CI: "1" } },
        },
      },
      WS,
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.tasks.build!.timeoutMs, 30_000);
      assert.deepEqual(res.tasks.build!.env, { CI: "1" });
    }
  });

  it("rejects non-object roots and bad versions", () => {
    assert.equal(parseDevTasksConfig([], WS).ok, false);
    assert.equal(parseDevTasksConfig("x", WS).ok, false);
    const badVersion = parseDevTasksConfig({ version: 2, tasks: {} }, WS);
    assert.equal(badVersion.ok, false);
    if (!badVersion.ok) assert.match(badVersion.message, /version/i);
  });

  it("rejects malformed task ids and definitions with pointing messages", () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ tasks: { "bad id!": { command: "x" } } }, /Invalid task id/],
      [{ tasks: { build: "dotnet build" } }, /must be an object/],
      [{ tasks: { build: { command: "" } } }, /non-empty/],
      [{ tasks: { build: { command: 7 } } }, /non-empty/],
      [{ tasks: { build: { command: "x", timeoutMs: -5 } } }, /timeoutMs/],
      [{ tasks: { build: { command: "x", env: { "not a name": "1" } } } }, /env name/],
      [{ tasks: { build: { command: "x", env: { K: 3 } } } }, /env "K"/],
    ];
    for (const [raw, re] of cases) {
      const res = parseDevTasksConfig(raw, WS);
      assert.equal(res.ok, false, JSON.stringify(raw));
      if (!res.ok) assert.match(res.message, re);
    }
  });

  it("merges the current platform override over the base fields", () => {
    const res = parseDevTasksConfig(
      {
        tasks: {
          build: {
            command: "npm run build",
            env: { CI: "1" },
            openAfter: "out",
            mac: {
              command: "npm run dist:mac",
              cwd: "packaging",
              env: { CI: "0", MAC_ONLY: "yes" },
            },
            win: { command: "npm run dist:win" },
          },
        },
      },
      WS,
      "darwin",
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const build = res.tasks.build!;
    assert.equal(build.command, "npm run dist:mac");
    assert.equal(build.cwd, resolve(WS, "packaging"));
    assert.deepEqual(build.env, { CI: "0", MAC_ONLY: "yes" });
    assert.equal(build.openAfter, resolve(WS, "out"));
  });

  it("keeps the base command when the platform block only overrides extras", () => {
    const res = parseDevTasksConfig(
      {
        tasks: {
          build: {
            command: "npm run build",
            win: { openAfter: "dist/win-unpacked", timeoutMs: 900000 },
          },
        },
      },
      WS,
      "win32",
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const build = res.tasks.build!;
    assert.equal(build.command, "npm run build");
    assert.equal(build.timeoutMs, 900_000);
    assert.equal(build.openAfter, resolve(WS, "dist/win-unpacked"));
  });

  it("ignores platform blocks on other platforms but still validates them", () => {
    // darwin ignores the win block's command — but a malformed block fails.
    const good = parseDevTasksConfig(
      { tasks: { build: { command: "x", win: { command: "y" } } } },
      WS,
      "darwin",
    );
    assert.equal(good.ok, true);
    if (good.ok) assert.equal(good.tasks.build!.command, "x");

    const bad = parseDevTasksConfig(
      { tasks: { build: { command: "x", win: { command: "" } } } },
      WS,
      "darwin",
    );
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.message, /win override[\s\S]*non-empty/);
  });

  it("resolves openAfter against the workspace and rejects bad values", () => {
    const res = parseDevTasksConfig(
      {
        tasks: {
          build: { command: "make", openAfter: "/abs/artifacts" },
          run: { command: "make run", openAfter: "logs" },
        },
      },
      WS,
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.tasks.build!.openAfter, "/abs/artifacts");
      assert.equal(res.tasks.run!.openAfter, resolve(WS, "logs"));
    }

    const bad = parseDevTasksConfig(
      { tasks: { build: { command: "make", openAfter: 42 } } },
      WS,
    );
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.message, /openAfter/);
   });
 });

describe("readDevTasksConfig", () => {
  it("treats a missing file as no tasks (ok, empty)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jb-devtask-missing-"));
    try {
      const res = await readDevTasksConfig(dir);
      assert.equal(res.ok, true);
      if (res.ok) assert.deepEqual(res.tasks, {});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads and validates a real file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jb-devtask-read-"));
    try {
      await mkdir(join(dir, ".larry"), { recursive: true });
      await writeFile(
        join(dir, DEV_TASKS_FILE_REL),
        JSON.stringify({
          version: 1,
          tasks: { build: { command: "echo hi" } },
        }),
        "utf8",
      );
      const res = await readDevTasksConfig(dir);
      assert.equal(res.ok, true);
      if (res.ok) assert.equal(res.tasks.build!.command, "echo hi");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports invalid JSON instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jb-devtask-bad-"));
    try {
      await mkdir(join(dir, ".larry"), { recursive: true });
      await writeFile(join(dir, DEV_TASKS_FILE_REL), "{ nope", "utf8");
      const res = await readDevTasksConfig(dir);
      assert.equal(res.ok, false);
      if (!res.ok) assert.match(res.message, /not valid JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
