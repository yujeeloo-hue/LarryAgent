import assert from "node:assert/strict";
import { test } from "node:test";
import { LspProgressTracker } from "./progressTracker.js";
import type { LanguageServerProgressEvent } from "./progressTypes.js";

const ROOT = "/ws/Content/Script";

function tracker(settleMs = 1_500): { events: LanguageServerProgressEvent[]; progress: LspProgressTracker } {
  const events: LanguageServerProgressEvent[] = [];
  return { events, progress: new LspProgressTracker("lua", ROOT, event => events.push(event), settleMs) };
}

const phases = (events: LanguageServerProgressEvent[]) => events.map(event => event.phase);

test("the emmylua_ls workspace load becomes loading messages, then idle", () => {
  const { events, progress } = tracker();
  progress.starting();
  progress.handle({ token: 0, value: { kind: "begin", title: "Load workspace", message: "Load workspace" } });
  progress.handle({ token: 0, value: { kind: "report", message: "Collecting files" } });
  progress.handle({ token: 0, value: { kind: "report", message: "Indexing 3000 files" } });
  progress.handle({ token: 0, value: { kind: "end", message: "Indexing complete" } });
  assert.deepEqual(events, [
    { server: "lua", rootPath: ROOT, phase: "starting" },
    { server: "lua", rootPath: ROOT, phase: "loading" },
    { server: "lua", rootPath: ROOT, phase: "loading", message: "Collecting files" },
    { server: "lua", rootPath: ROOT, phase: "loading", message: "Indexing 3000 files" },
    { server: "lua", rootPath: ROOT, phase: "idle" },
  ]);
});

test("workspace diagnosis reports its percentage, deduplicated and kept across bare reports", () => {
  const { events, progress } = tracker();
  progress.handle({ token: 1, value: { kind: "begin", title: "Diagnose workspace", message: "Diagnose workspace" } });
  progress.handle({ token: 1, value: { kind: "report", message: "diagnostic 1%", percentage: 1 } });
  progress.handle({ token: 1, value: { kind: "report", message: "diagnostic 1%", percentage: 1 } });
  progress.handle({ token: 1, value: { kind: "report", message: "still going" } });
  progress.handle({ token: 1, value: { kind: "report", percentage: 57.6 } });
  progress.handle({ token: 1, value: { kind: "end" } });
  assert.deepEqual(events, [
    { server: "lua", rootPath: ROOT, phase: "diagnosing" },
    { server: "lua", rootPath: ROOT, phase: "diagnosing", percent: 1 },
    { server: "lua", rootPath: ROOT, phase: "diagnosing", percent: 58 },
    { server: "lua", rootPath: ROOT, phase: "idle" },
  ]);
});

test("overlapping tokens fall back to the one still running; unknown tokens are ignored", () => {
  const { events, progress } = tracker();
  progress.handle({ token: "x", value: { kind: "report", message: "orphan" } });
  progress.handle({ token: 0, value: { kind: "begin", title: "Load workspace" } });
  progress.handle({ token: 1, value: { kind: "begin", title: "Diagnose workspace", percentage: 10 } });
  progress.handle({ token: 1, value: { kind: "end" } });
  assert.deepEqual(events.at(-1), { server: "lua", rootPath: ROOT, phase: "loading" });
  progress.handle({ token: 0, value: { kind: "end" } });
  assert.deepEqual(events.at(-1), { server: "lua", rootPath: ROOT, phase: "idle" });
  assert.equal(events.length, 4);
});

test("failure and shutdown clear any running progress", () => {
  const { events, progress } = tracker();
  progress.starting();
  progress.failed("spawn ENOENT");
  progress.starting();
  progress.handle({ token: 0, value: { kind: "begin", title: "Load workspace" } });
  progress.idle();
  progress.handle({ token: 0, value: { kind: "report", message: "late" } });
  assert.deepEqual(phases(events), ["starting", "failed", "starting", "loading", "idle"]);
});

test("a server that reports no progress settles to idle after initialize", async () => {
  const { events, progress } = tracker(5);
  progress.starting();
  progress.initialized();
  assert.deepEqual(phases(events), ["starting"]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(phases(events), ["starting", "idle"]);
});

test("progress that begins right after initialize cancels the settle", async () => {
  const { events, progress } = tracker(5);
  progress.starting();
  progress.initialized();
  progress.handle({ token: 0, value: { kind: "begin", title: "Load workspace" } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(phases(events), ["starting", "loading"]);
  progress.idle();
});
