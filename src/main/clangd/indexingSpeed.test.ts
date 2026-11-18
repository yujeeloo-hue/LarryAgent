import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { ClangdService, __testing } from "./service.js";
import { LspConnection } from "./lsp.js";
import type { ClangdIndexProgressEvent } from "./types.js";

async function harness(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "jb-index-speed-"));
  const source = join(root, "Game.cpp");
  await writeFile(source, "int Saved;\n");
  await writeFile(join(root, "compile_commands.json"), JSON.stringify([
    { directory: root, file: source, arguments: ["clang++", "-c", source] },
  ]));
  const oldPath = process.env.JB_CLANGD_PATH;
  const oldJobs = process.env.JB_CLANGD_JOBS;
  process.env.JB_CLANGD_PATH = process.execPath;
  delete process.env.JB_CLANGD_JOBS;
  const progress: ClangdIndexProgressEvent[] = [];
  const service = new ClangdService(event => progress.push(event));
  const control = { wait: null as Promise<void> | null, fail: false };
  const starts: { args: string[]; notices: { method: string; params: unknown }[]; disposed: boolean }[] = [];
  t.mock.method(LspConnection, "start", async (_command: string, args: string[], init: { onExit?: () => void }) => {
    const start = { args, notices: [] as { method: string; params: unknown }[], disposed: false };
    starts.push(start);
    if (control.wait) await control.wait;
    if (control.fail) { control.fail = false; throw new Error("Startup failed"); }
    return {
      notify: (method: string, params: unknown) => start.notices.push({ method, params }),
      dispose: () => { start.disposed = true; init.onExit?.(); },
      request: async () => [],
    } as unknown as LspConnection;
  });
  // These tests exercise startup/restart and buffer replay, without warmup polling.
  service["startIndexWarmup"] = () => {};
  service["startUhtWatcher"] = () => null;
  t.after(async () => {
    service.stop();
    if (oldPath === undefined) delete process.env.JB_CLANGD_PATH; else process.env.JB_CLANGD_PATH = oldPath;
    if (oldJobs === undefined) delete process.env.JB_CLANGD_JOBS; else process.env.JB_CLANGD_JOBS = oldJobs;
    await rm(root, { recursive: true, force: true });
  });
  assert.equal((await service.ensureStarted(root)).ok, true);
  return { root, source, service, starts, control, progress };
}

test("full speed raises the CPU budget while retaining a free-memory ceiling and explicit job overrides", () => {
  const jobs = __testing.clangdJobsForWorkspace;
  const gib = 1024 ** 3;
  assert.equal(jobs(true, 16, 64 * gib, "", "full"), 16);
  assert.equal(jobs(true, 16, 16 * gib, "", "full"), 4);
  assert.equal(jobs(true, 16, 1 * gib, "", "full"), 1);
  assert.equal(jobs(false, 16, 32 * gib, "", "full"), 16);
  assert.equal(jobs(true, 16, 64 * gib, "3", "full"), 3);
});

test("switching speed applies real startup flags, replays unsaved editor buffers and can return to normal", async t => {
  const h = await harness(t);
  h.service.docChanged(h.root, h.source, "int Unsaved;\n");
  assert.deepEqual(await h.service.setIndexingSpeed(h.root, "full"), { ok: true, speed: "full" });
  assert.equal(h.starts[0]!.disposed, true);
  assert.ok(h.starts[1]!.args.includes("--background-index-priority=normal"));
  const opened = h.starts[1]!.notices.find(n => n.method === "textDocument/didOpen")!.params as { textDocument: { text: string } };
  assert.equal(opened.textDocument.text, "int Unsaved;\n");
  const status = await h.service.status(h.root);
  assert.equal(status.ok && status.indexingSpeed, "full");
  assert.deepEqual(await h.service.setIndexingSpeed(h.root, "normal"), { ok: true, speed: "normal" });
  assert.ok(h.starts[2]!.args.includes("--background-index-priority=low"));
  const count = h.starts.length;
  await h.service.setIndexingSpeed(h.root, "normal");
  assert.equal(h.starts.length, count, "same speed does not restart clangd");
});

test("edits and closes during a speed change survive startup; duplicate changes are rejected", async t => {
  const h = await harness(t);
  const other = join(h.root, "Other.cpp");
  h.service.docChanged(h.root, h.source, "int Before;\n");
  h.service.docChanged(h.root, other, "int Closed;\n");
  let release!: () => void;
  h.control.wait = new Promise<void>(resolve => { release = resolve; });
  const changing = h.service.setIndexingSpeed(h.root, "full");
  while (h.starts.length < 2) await setImmediate();
  h.service.docChanged(h.root, h.source, "int LatestUnsaved;\n");
  h.service.docClosed(h.root, other);
  assert.equal((await h.service.setIndexingSpeed(h.root, "normal")).ok, false);
  release();
  assert.equal((await changing).ok, true);
  const opens = h.starts[1]!.notices.filter(n => n.method === "textDocument/didOpen");
  assert.equal(opens.length, 1);
  assert.equal((opens[0]!.params as { textDocument: { text: string } }).textDocument.text, "int LatestUnsaved;\n");
});

test("a failed speed change rolls back the speed choice and keeps editor buffers for recovery", async t => {
  const h = await harness(t);
  h.service.docChanged(h.root, h.source, "int KeepMe;\n");
  h.control.fail = true;
  assert.equal((await h.service.setIndexingSpeed(h.root, "full")).ok, false);
  assert.equal((await h.service.ensureStarted(h.root)).ok, true);
  assert.ok(h.starts[2]!.args.includes("--background-index-priority=low"));
  assert.equal(h.service["session"]!.docs.get(__testing.toUri(h.source))!.text, "int KeepMe;\n");
});

test("leaving Dev Mode while compile commands are prepared does not start clangd", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jb-clangd-cancel-"));
  const oldPath = process.env.JB_CLANGD_PATH;
  process.env.JB_CLANGD_PATH = process.execPath;
  const service = new ClangdService(() => {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  t.mock.method(LspConnection, "start", async () => {
    started = true;
    throw new Error("clangd should not start");
  });
  service["prepareCompileDatabase"] = async () => {
    await gate;
    return { ok: true as const, outputFile: join(root, "compile_commands.json"), skipped: true };
  };
  t.after(async () => {
    service.stop();
    if (oldPath === undefined) delete process.env.JB_CLANGD_PATH;
    else process.env.JB_CLANGD_PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  });
  const pending = service.ensureStarted(root);
  await setImmediate();
  service.stopIfRoot(root);
  release();
  const status = await pending;
  assert.equal(status.ok, false);
  assert.equal(started, false);
  assert.equal(service["session"], null);
});

test("closing the workspace during a restart prevents the indexer from returning", async t => {
  const h = await harness(t);
  let release!: () => void;
  h.control.wait = new Promise<void>(resolve => { release = resolve; });
  const changing = h.service.setIndexingSpeed(h.root, "full");
  while (h.starts.length < 2) await setImmediate();
  h.service.stopIfRoot(h.root);
  release();
  assert.equal((await changing).ok, false);
  assert.equal(h.service["session"], null);
  assert.equal(h.starts[1]!.disposed, true);
});
