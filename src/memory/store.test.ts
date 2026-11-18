import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  configureUserMemoryRoot,
  loadUserMemory,
  setUserMemoryProfile,
  writeUserMemoryProfile,
} from "./store.js";
import { USER_MEMORY_PROFILE_MAX_CHARS } from "./types.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jb-usermem-"));
  roots.push(root);
  configureUserMemoryRoot(root);
  return root;
}

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("user memory profile (no hard truncation)", () => {
  it("setUserMemoryProfile stores over-target profiles intact", async () => {
    makeRoot();
    const profile = `# Profile\n\n${"p".repeat(USER_MEMORY_PROFILE_MAX_CHARS + 1_000)}`;
    const snap = await setUserMemoryProfile(profile);
    assert.equal(snap.profile, profile);
    const raw = JSON.parse(
      await readFile(join(roots[0]!, "user-memory.json"), "utf8"),
    ) as { profile: string };
    assert.equal(raw.profile, profile);
  });

  it("writeUserMemoryProfile merge keeps the full merged profile", async () => {
    makeRoot();
    await setUserMemoryProfile("# Base\n\nfirst");
    const add = "q".repeat(USER_MEMORY_PROFILE_MAX_CHARS);
    const snap = await writeUserMemoryProfile(add, "merge");
    assert.ok(snap.profile.includes("first"));
    assert.ok(snap.profile.includes(add));
    assert.ok(snap.profile.length > USER_MEMORY_PROFILE_MAX_CHARS);
    const reloaded = await loadUserMemory();
    assert.equal(reloaded.profile, snap.profile);
  });
});
