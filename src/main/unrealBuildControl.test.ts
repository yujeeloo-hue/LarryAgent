import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { followExternalBuild, pidAlive } from "./unrealBuildControl.js";

test("followExternalBuild streams appended log lines and the final result", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "larry-ubt-follow-"));
  const log = join(dir, "Log.txt");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  t.after(async () => {
    if (child.pid && pidAlive(child.pid)) child.kill();
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(log, "[1/4] Compile [x64] A.cpp\n");
  assert.ok(child.pid);
  const chunks: string[] = [];
  const done = followExternalBuild({
    pid: child.pid,
    logPath: log,
    signal: new AbortController().signal,
    timeoutAt: null,
    onLog: (text) => chunks.push(text),
  });
  await appendFile(log, "[2/4] Compile [x64] B.cpp\nResult: Succeeded\n");
  child.kill();
  assert.equal(await done, "succeeded");
  assert.match(chunks.join(""), /\[2\/4\] Compile \[x64\] B\.cpp/);
});
