/**
 * Atomic JSON write: the temp file must live next to the target and must never
 * survive. Regression guard for the Windows `dirname` bug — the hand-rolled
 * `lastIndexOf("/")` variant resolved every `join()`ed (backslash) path to ".",
 * which dropped the temp file into the process cwd (the repo root under the
 * test runner) and left it there because rename never happened.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { after, describe, it } from "node:test";
import { writeJsonAtomic } from "./atomicJson.js";

const base = mkdtempSync(join(tmpdir(), "jb-atomic-"));
const cwdBefore = readdirSync(process.cwd()).filter((n) => /^\.[0-9a-f]{8}\.json$/.test(n)).length;

after(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("writeJsonAtomic", () => {
  it("creates missing parents and writes the value under its own directory", async () => {
    const target = join(base, "nested", "deeper", "current.json");
    await writeJsonAtomic(target, { phase: "queued", ts: 1 });
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { phase: "queued", ts: 1 });
    assert.deepEqual(readdirSync(dirname(target)), ["current.json"]);
  });

  it("leaves no temp file behind on the happy path", async () => {
    const target = join(base, "clean", "current.json");
    await writeJsonAtomic(target, { phase: "done" });
    await writeJsonAtomic(target, { phase: "done", ts: 2 });
    const names = readdirSync(dirname(target));
    assert.deepEqual(names, ["current.json"], `unexpected leftovers: ${names.join(", ")}`);
  });

  it("overwrites an existing file", async () => {
    const target = join(base, "overwrite", "current.json");
    await writeJsonAtomic(target, { phase: "running" });
    await writeJsonAtomic(target, { phase: "failed" });
    assert.equal(JSON.parse(readFileSync(target, "utf8")).phase, "failed");
  });

  it("drops the temp file even when the rename fallback fails", async () => {
    // A directory at the target path makes both rename and the direct write fail.
    const target = join(base, "blocked", "current.json");
    mkdirSync(target, { recursive: true });
    await assert.rejects(() => writeJsonAtomic(target, { phase: "queued" }));
    const names = readdirSync(dirname(target));
    assert.deepEqual(names, ["current.json"], `temp survived a failing write: ${names.join(", ")}`);
  });

  it("does not leak temp files into the process cwd", () => {
    const leaked = readdirSync(process.cwd()).filter((n) => /^\.[0-9a-f]{8}\.json$/.test(n)).length;
    assert.equal(leaked, cwdBefore, "a temp file escaped into the cwd");
  });

  it("resolves backslash paths to their real parent (Windows regression)", () => {
    // Mirrors what `join()` produces on win32; dirname() must not fall back to ".".
    assert.equal(win32.dirname("C:\\data\\update-status\\current.json"), "C:\\data\\update-status");
    assert.equal(existsSync(join(base, "nested")), true);
  });
});
