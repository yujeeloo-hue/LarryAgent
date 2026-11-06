import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  builtinGraphId,
  configureFsmGraphsRoot,
  createNewGraphRecord,
  deleteFsmGraph,
  getFsmGraph,
  listComposerGraphs,
  listFsmGraphs,
  resolveCustomFsmGraphForTurn,
  saveFsmGraph,
  setFsmGraphEnabled,
} from "./manager.js";
import { graphConfigForMode } from "../FsmGraphWorkflow.js";

describe("graphLibrary built-in composer graphs (Auto V2)", () => {
  let root: string;
  const AUTO_V2 = builtinGraphId("react_v2");

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "jellybot-builtin-graphs-"));
    configureFsmGraphsRoot(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists Auto V2 first in the composer picker, ahead of enabled library graphs only", async () => {
    const enabled = await saveFsmGraph(createNewGraphRecord("Mine"));
    const disabled = await saveFsmGraph(createNewGraphRecord("Off"));
    await setFsmGraphEnabled(disabled.id, false);

    const entries = await listComposerGraphs();
    assert.deepEqual(
      entries.map((e) => e.id),
      [AUTO_V2, enabled.id],
    );
    assert.equal(entries[0]!.name, "Auto V2");
    // The Graphs library screen stays user-only.
    assert.ok(!(await listFsmGraphs()).some((e) => e.id === AUTO_V2));
  });

  it("resolves from the current code template for turns (no fork, nothing on disk)", async () => {
    const record = await getFsmGraph(AUTO_V2);
    assert.ok(record);
    assert.deepEqual(record.config, graphConfigForMode("react_v2"));
    const resolved = await resolveCustomFsmGraphForTurn(AUTO_V2);
    assert.equal(resolved.id, AUTO_V2);
    assert.ok(resolved.config.nodes.some((n) => n.id === "agent_reuse"));
    assert.deepEqual(await readdir(root), []);
  });

  it("is read-only: save / enable / delete are rejected", async () => {
    const record = (await getFsmGraph(AUTO_V2))!;
    await assert.rejects(() => saveFsmGraph({ ...record, name: "Renamed" }), /read-only/);
    await assert.rejects(() => setFsmGraphEnabled(AUTO_V2, false), /read-only/);
    await assert.rejects(() => deleteFsmGraph(AUTO_V2), /read-only/);
  });

  it("unknown built-in ids resolve to nothing", async () => {
    assert.equal(await getFsmGraph("builtin:nope"), null);
    await assert.rejects(() => resolveCustomFsmGraphForTurn("builtin:nope"), /not found/);
  });
});
