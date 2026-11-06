/**
 * dev_tasks tool — get/set round-trips on real temp workspaces.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { devTasksDefinition, devTasksHandler } from "./devTasks.js";
import type { ToolExecuteContext } from "../types.js";

function ctx(workspacePath: string): ToolExecuteContext {
  return { workspacePath, fullPermissionsEnabled: false };
}

function text(result: Awaited<ReturnType<typeof devTasksHandler>>): string {
  const first = result.content[0];
  return first && first.type === "text" ? (first.text ?? "") : "";
}

describe("dev_tasks", () => {
  it("get on an unconfigured workspace reports no tasks + format example", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jb-devtasks-get-"));
    try {
      const res = await devTasksHandler({ action: "get" }, ctx(dir));
      assert.ok(text(res).includes("no tasks yet"));
      assert.ok(text(res).includes('"build"'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("set writes a valid file and get reads it back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jb-devtasks-set-"));
    try {
      const res = await devTasksHandler(
        {
          action: "set",
          config: {
            version: 1,
            tasks: { build: { command: "dotnet build", cwd: "src" } },
          },
        },
        ctx(dir),
      );
      assert.ok(text(res).includes("Wrote"));
      const onDisk = JSON.parse(
        await readFile(join(dir, ".larry/tasks.json"), "utf8"),
      );
      assert.equal(onDisk.tasks.build.command, "dotnet build");
      assert.equal(onDisk.tasks.build.cwd, "src");
      const got = await devTasksHandler({ action: "get" }, ctx(dir));
      assert.ok(text(got).includes("build: dotnet build"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("set rejects invalid configs without touching the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jb-devtasks-bad-"));
    try {
      const res = await devTasksHandler(
        { action: "set", config: { tasks: { build: { command: "" } } } },
        ctx(dir),
      );
      assert.ok(text(res).includes("Invalid task config"));
      await assert.rejects(readFile(join(dir, ".larry/tasks.json"), "utf8"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("round-trips timeoutMs and env; workspace cwd is omitted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jb-devtasks-rt-"));
    try {
      await devTasksHandler(
        {
          action: "set",
          config: {
            tasks: {
              run: { command: "make", timeoutMs: "30000", env: { CI: "1" } },
            },
          },
        },
        ctx(dir),
      );
      const onDisk = JSON.parse(
        await readFile(join(dir, ".larry/tasks.json"), "utf8"),
      );
      assert.equal(onDisk.tasks.run.timeoutMs, 30000);
      assert.deepEqual(onDisk.tasks.run.env, { CI: "1" });
      assert.equal(onDisk.tasks.run.cwd, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown actions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jb-devtasks-act-"));
    try {
      const res = await devTasksHandler({ action: "nope" }, ctx(dir));
      assert.ok(text(res).includes('action must be "get" or "set"'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("definition: name, level-1 default, action enum", () => {
    assert.equal(devTasksDefinition.name, "dev_tasks");
    assert.equal(devTasksDefinition.defaultPermissionLevel, 1);
    const props = (devTasksDefinition.parameters.properties ?? {}) as unknown as Record<
      string,
      { enum?: string[] }
    >;
    assert.deepEqual(props.action?.enum, ["get", "set"]);
  });
});
