import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  appendProjectDocEntries,
  ensureProjectDocsSkeleton,
  loadProjectDoc,
  projectDocHeader,
  replaceProjectDocBody,
} from "./docsStore.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jb-projdocs-"));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("docs store", () => {
  it("skeleton creates all five files without overwriting", async () => {
    const root = makeRoot();
    await ensureProjectDocsSkeleton(root);
    for (const doc of ["worklog", "pitfalls", "handoff", "style", "deploy"] as const) {
      const body = await readFile(join(root, "docs", `${doc.toUpperCase()}.md`), "utf8");
      assert.ok(body.startsWith(`# `), `${doc}: title missing`);
      assert.ok(body.includes("> "));
    }
    // Second call is a no-op (content preserved).
    await replaceProjectDocBody(root, "handoff", "- only unfinished items");
    await ensureProjectDocsSkeleton(root);
    const handoff = await loadProjectDoc(root, "handoff");
    assert.ok(handoff.includes("- only unfinished items"));
  });

  it("prepends entries newest-first and enforces the worklog cap", async () => {
    const root = makeRoot();
    // One entry per call: later calls land on top.
    await appendProjectDocEntries(root, "worklog", ["- first"]);
    await appendProjectDocEntries(root, "worklog", ["- second"]);
    await appendProjectDocEntries(root, "worklog", ["- third"]);
    // Batch call: array order is newest-first within the batch.
    await appendProjectDocEntries(root, "worklog", ["- batch-new", "- batch-old"]);
    const body = await loadProjectDoc(root, "worklog");
    const lines = body.split("\n");
    const order = ["- batch-new", "- batch-old", "- third", "- second", "- first"];
    let prev = -1;
    for (const entry of order) {
      const at = lines.indexOf(entry);
      assert.ok(at > prev, `${entry} must sit above the previous entry`);
      prev = at;
    }
    // Header block stays above the entries.
    assert.ok(body.startsWith(projectDocHeader("worklog").trimEnd().split("\n")[0]!));

    // Cap: 100 entries max — oldest (file-order tail) dropped.
    const burst = Array.from({ length: 120 }, (_, i) => `- bulk ${i}`);
    await appendProjectDocEntries(root, "worklog", burst);
    const capped = await loadProjectDoc(root, "worklog");
    const entries = capped.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(entries.length, 100);
    assert.equal(entries[0], "- bulk 0");
    assert.ok(!capped.includes("- bulk 119"), "oldest overflow must be dropped");
    assert.ok(!capped.includes("- first\n"), "pre-burst entries must be dropped");
  });

  it("replaceProjectDocBody asserts the canonical title", async () => {
    const root = makeRoot();
    await replaceProjectDocBody(root, "deploy", "## Servers\n\n- relay-a");
    const body = await loadProjectDoc(root, "deploy");
    assert.ok(body.startsWith("# DEPLOY — Deployment & Release"));
    assert.ok(body.includes("- relay-a"));
  });
});
