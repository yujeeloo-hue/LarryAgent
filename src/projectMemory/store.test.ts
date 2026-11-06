import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { PROJECT_MEMORY_MAX_CHARS } from "./types.js";
import {
  loadProjectMemory,
  setProjectMemoryBody,
  writeProjectMemory,
} from "./store.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jb-projmem-"));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("project memory store (no hard truncation)", () => {
  it("restores the canonical docs guide when a write leaves it empty", async () => {
    const root = makeRoot();
    await writeProjectMemory(root, "# Project\n\n## Basics\n\nx", "replace");
    const guided = await loadProjectMemory(root);
    assert.ok(guided.body.includes("docs/WORKLOG.md"), "canonical guide restored");
    // A customized guide passes through untouched (replace swaps it wholesale).
    await writeProjectMemory(root, "- custom pointer", "replace", "docs_guide");
    const custom = await loadProjectMemory(root);
    assert.ok(custom.body.includes("- custom pointer"));
    assert.ok(!custom.body.includes("- docs/DEPLOY.md — deployment"));
  });

  it("setProjectMemoryBody stores over-target bodies intact", async () => {
    const root = makeRoot();
    const longRun = "x".repeat(3_000);
    const body = `# Project\n\n## Overview\n\n${longRun}`;
    const snap = await setProjectMemoryBody(root, body);
    assert.equal(snap.body.trim(), body);
    const onDisk = await readFile(join(root, "PROJECT.md"), "utf8");
    assert.ok(onDisk.includes(longRun), "long overview must survive on disk");
  });

  it("writeProjectMemory merge keeps the full merged body", async () => {
    const root = makeRoot();
    await setProjectMemoryBody(root, "# Project\n\n## Basics\n\nBase.");
    const add = "y".repeat(3_200);
    const snap = await writeProjectMemory(root, add, "merge", "basics");
    assert.ok(snap.body.includes("Base."));
    assert.ok(snap.body.includes(add));
    assert.ok(
      snap.body.length > PROJECT_MEMORY_MAX_CHARS,
      "merged body should exceed the soft target",
    );
    const reloaded = await loadProjectMemory(root);
    assert.equal(reloaded.body.trim(), snap.body.trim());
  });

  it("writeProjectMemory whole-body merge keeps prior content", async () => {
    const root = makeRoot();
    await setProjectMemoryBody(root, "# Project\n\n## Basics\n\nBase.");
    const snap = await writeProjectMemory(root, "- extra note", "merge", null);
    assert.ok(snap.body.includes("Base."));
    assert.ok(snap.body.includes("- extra note"));
  });
});
