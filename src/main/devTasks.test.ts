import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WebContents } from "electron";
import { PRE_BUILD_TASK_ID } from "../shared/devTaskIds.js";
import { DEV_TASKS_FILE_REL } from "./devTaskConfig.js";
import { awaitDevTaskRun, getDevTaskState, runDevTask } from "./devTasks.js";

test("standalone Lint uses preBuild and keeps the exit result separate from Build", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "larry-lint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".larry"));
  await mkdir(join(root, "build-dir"));

  const tasks = {
    build: { command: "echo build ran", cwd: "build-dir", env: { LARRY_LINT_TEST_VALUE: "lint output" } },
    lint: { command: "echo custom lint ran" },
  };
  const configPath = join(root, DEV_TASKS_FILE_REL);
  await writeFile(configPath, JSON.stringify({ tasks }));
  assert.deepEqual(await runDevTask(null, root, PRE_BUILD_TASK_ID), {
    ok: false, message: "Configure preBuild in .larry/tasks.json",
  });

  const preBuild = `"${process.execPath}" -e "console.log(process.cwd());console.log(process.env.LARRY_LINT_TEST_VALUE);console.error('check failed');process.exitCode=7"`;
  await writeFile(configPath, JSON.stringify({ preBuild, tasks }));
  const events: Array<{ channel: string; payload: unknown }> = [];
  const sender = {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => events.push({ channel, payload }),
  } as unknown as WebContents;
  const lint = await runDevTask(sender, root, PRE_BUILD_TASK_ID);
  assert.ok(lint.ok);
  assert.equal(lint.command, preBuild);
  assert.deepEqual(events[0], { channel: "devtask:output", payload: {
    runId: lint.runId, task: PRE_BUILD_TASK_ID, workspacePath: root, command: preBuild, stream: "stdout", text: "",
  } });
  const result = await awaitDevTaskRun(lint.runId);
  assert.equal(result?.status, "failed");
  assert.equal(result?.exitCode, 7, result?.buffer);
  assert.match(result?.buffer ?? "", /[\\/]larry-lint-[^\\/\r\n]+[\\/]build-dir/);
  assert.match(result?.buffer ?? "", /lint output/);
  assert.match(result?.buffer ?? "", /check failed/);
  assert.doesNotMatch(result?.buffer ?? "", /build ran|custom lint ran/);
  const state = getDevTaskState(root);
  assert.equal(state.last[PRE_BUILD_TASK_ID]?.runId, lint.runId);
  assert.equal(state.last.build, undefined);

  const build = await runDevTask(null, root, "build");
  assert.ok(build.ok);
  const built = await awaitDevTaskRun(build.runId);
  assert.equal(built?.status, "done", built?.buffer ?? "Build result missing");
  assert.match(built?.buffer ?? "", /lint output/);
  assert.match(built?.buffer ?? "", /pre-build step failed - continuing with the build/);
  assert.match(built?.buffer ?? "", /build ran/);

  await writeFile(configPath, JSON.stringify({ preBuild: "echo preBuild-only workspace" }));
  const lintWithoutBuild = await runDevTask(null, root, PRE_BUILD_TASK_ID);
  assert.ok(lintWithoutBuild.ok);
  const standalone = await awaitDevTaskRun(lintWithoutBuild.runId);
  assert.equal(standalone?.status, "done");
  assert.match(standalone?.buffer ?? "", /preBuild-only workspace/);
});
