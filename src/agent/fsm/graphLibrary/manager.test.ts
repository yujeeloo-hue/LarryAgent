import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  configureFsmGraphsRoot,
  createForkFromBuiltin,
  createNewGraphRecord,
  getFsmGraph,
  listFsmGraphs,
  resolveCustomFsmGraphForTurn,
  saveFsmGraph,
  setFsmGraphEnabled,
} from "./manager.js";
import { FSM_GRAPH_COLORS } from "./types.js";
import { createDefaultGraphConfig } from "./defaultGraph.js";
import type { FsmGraphLibraryRecord } from "./types.js";
import { FSMGraph } from "../FSMGraph.js";
import { createDefaultActionRegistry } from "../actions/createDefaultActionRegistry.js";
import { createFSMGraphConfig } from "../types.js";

describe("graphLibrary manager: origin/enabled lifecycle", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "jellybot-graphlib-"));
    configureFsmGraphsRoot(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeLegacyRecord(
    record: Omit<FsmGraphLibraryRecord, "origin" | "enabled">,
  ): Promise<void> {
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, `${record.id}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(root, "index.json"),
      `${JSON.stringify(
        {
          version: 1,
          graphs: [
            { id: record.id, name: record.name, updatedAt: record.updatedAt },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  function baseRecord(): Omit<FsmGraphLibraryRecord, "origin" | "enabled"> {
    return {
      id: "legacy-1",
      name: "Legacy graph",
      createdAt: 1,
      updatedAt: 1,
      config: createDefaultGraphConfig(),
    };
  }

  function v1Record() {
    return {
      ...createNewGraphRecord("Old counter"),
      config: { ...createFSMGraphConfig({
        entryNodeId: "review", nodes: [
          { id: "review", actions: [{ type: "NodeActionBumpReplanCount" }] }, { id: "end" },
        ], edges: [{ from: "review", to: "end", type: "EdgeAlways" }],
      }), version: 1 },
    };
  }

  it("loads old disk configs and persists only v2 when saved", async () => {
    const legacy = v1Record();
    await writeFile(join(root, `${legacy.id}.json`), JSON.stringify(legacy), "utf8");
    const loaded = await getFsmGraph(legacy.id);
    assert.ok(loaded);
    assert.equal(loaded.config.version, 2);
    assert.equal(loaded.config.nodes[0]!.actions![0]!.type, "NodeActionWriteBlackboard");
    const saved = await saveFsmGraph(legacy);
    const persisted = JSON.parse(await readFile(join(root, `${legacy.id}.json`), "utf8"));
    assert.deepEqual(persisted.config, saved.config);
    assert.equal(persisted.config.version, 2);
    assert.equal(legacy.config.version, 1);
    assert.deepEqual((await getFsmGraph(legacy.id))!.config, saved.config);
  });

  it("turn resolution returns the migrated config that was validated", async () => {
    const legacy = v1Record();
    const resolved = await resolveCustomFsmGraphForTurn(legacy.id, async () => legacy);
    assert.equal(resolved.config.version, 2);
    assert.equal(legacy.config.version, 1);
    const result = await FSMGraph.run(resolved.config, { replanCount: 2 }, {
      registries: createDefaultActionRegistry(),
    });
    assert.equal(result.reason, "end_node");
    assert.equal(result.turnContext.replanCount, 3);
  });

  it("normalizes legacy records/entries missing origin/enabled to user+enabled", async () => {
    await writeLegacyRecord(baseRecord());

    const record = await getFsmGraph("legacy-1");
    assert.ok(record);
    assert.equal(record.origin, "user");
    assert.equal(record.enabled, true);

    const entries = await listFsmGraphs();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.origin, "user");
    assert.equal(entries[0]?.enabled, true);
  });

  it("createNewGraphRecord: user origin is enabled, llm origin is disabled", () => {
    const user = createNewGraphRecord("Mine");
    assert.equal(user.origin, "user");
    assert.equal(user.enabled, true);

    const llm = createNewGraphRecord("Authored", { origin: "llm" });
    assert.equal(llm.origin, "llm");
    assert.equal(llm.enabled, false);
  });

  it("graph colors: new graphs default violet; forks inherit the source mode color", () => {
    assert.equal(createNewGraphRecord("Blank").color, FSM_GRAPH_COLORS.default);
    assert.equal(
      createForkFromBuiltin("ask").color,
      FSM_GRAPH_COLORS.ask,
    );
    assert.equal(
      createForkFromBuiltin("plan_execute").color,
      FSM_GRAPH_COLORS.planExecute,
    );
    // Auto/Subagent have no fixed identity color → default.
    assert.equal(
      createForkFromBuiltin("react").color,
      FSM_GRAPH_COLORS.default,
    );
    assert.equal(
      createForkFromBuiltin("subagent").color,
      FSM_GRAPH_COLORS.default,
    );
  });

  it("graph colors: save persists color on the record and the index entry", async () => {
    const saved = await saveFsmGraph({
      ...createNewGraphRecord("Colored"),
      color: "#00FF88",
    });
    assert.equal(saved.color, "#00ff88");

    const reread = await getFsmGraph(saved.id);
    assert.ok(reread);
    assert.equal(reread.color, "#00ff88");

    const entries = await listFsmGraphs();
    const entry = entries.find((e) => e.id === saved.id);
    assert.ok(entry);
    assert.equal(entry.color, "#00ff88");
  });

  it("graph colors: invalid colors are dropped on save and read", async () => {
    const saved = await saveFsmGraph({
      ...createNewGraphRecord("Bad color"),
      color: "not-a-hex",
    });
    assert.equal(saved.color, undefined);

    // Corrupt the stored file directly: read must strip the invalid value.
    await writeFile(
      join(root, `${saved.id}.json`),
      `${JSON.stringify({ ...saved, color: "#12345" }, null, 2)}\n`,
      "utf8",
    );
    const reread = await getFsmGraph(saved.id);
    assert.ok(reread);
    assert.equal(reread.color, undefined);
  });

  it("graph colors: legacy records without color read back undefined", async () => {
    await writeLegacyRecord(baseRecord());
    const record = await getFsmGraph("legacy-1");
    assert.ok(record);
    assert.equal(record.color, undefined);
  });

  it("saveFsmGraph: new llm record persists disabled", async () => {
    const record = createNewGraphRecord("Authored", { origin: "llm" });
    const saved = await saveFsmGraph(record);
    assert.equal(saved.origin, "llm");
    assert.equal(saved.enabled, false);

    const reread = await getFsmGraph(saved.id);
    assert.ok(reread);
    assert.equal(reread.enabled, false);
  });

  it("saveFsmGraph: updates preserve stored origin/enabled and ignore payload overrides", async () => {
    const record = createNewGraphRecord("Authored", { origin: "llm" });
    const saved = await saveFsmGraph(record);

    const updated = await saveFsmGraph({
      ...saved,
      name: "Renamed",
      origin: "user",
      enabled: true,
      config: createDefaultGraphConfig(),
    });
    assert.equal(updated.name, "Renamed");
    assert.equal(updated.origin, "llm");
    assert.equal(updated.enabled, false);
  });

  it("setFsmGraphEnabled: unknown id returns null; same-state is a no-op", async () => {
    assert.equal(await setFsmGraphEnabled("missing", true), null);

    const saved = await saveFsmGraph(
      createNewGraphRecord("G", { origin: "llm" }),
    );
    const unchanged = await setFsmGraphEnabled(saved.id, false);
    assert.ok(unchanged);
    assert.equal(unchanged.enabled, false);
  });

  it("setFsmGraphEnabled: enables a disabled llm graph, then disables again", async () => {
    const saved = await saveFsmGraph(
      createNewGraphRecord("G", { origin: "llm" }),
    );

    const enabled = await setFsmGraphEnabled(saved.id, true);
    assert.ok(enabled);
    assert.equal(enabled.enabled, true);

    const disabled = await setFsmGraphEnabled(saved.id, false);
    assert.ok(disabled);
    assert.equal(disabled.enabled, false);
  });

  it("setFsmGraphEnabled: enabling re-validates and rejects a corrupted stored config", async () => {
    const saved = await saveFsmGraph(
      createNewGraphRecord("G", { origin: "llm" }),
    );
    // Corrupt the stored file directly (bypasses save-time validation).
    await writeFile(
      join(root, `${saved.id}.json`),
      `${JSON.stringify(
        { ...saved, config: { ...saved.config, nodes: [] } },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await assert.rejects(
      () => setFsmGraphEnabled(saved.id, true),
      /nodes/i,
    );
  });

  it("resolveCustomFsmGraphForTurn: hard-gates disabled graphs with a named error", async () => {
    const saved = await saveFsmGraph(
      createNewGraphRecord("G", { origin: "llm" }),
    );

    await assert.rejects(
      () => resolveCustomFsmGraphForTurn(saved.id),
      new RegExp(
        `FSM graph "${saved.name}" is disabled — enable it in the Graphs editor`,
      ),
    );

    await setFsmGraphEnabled(saved.id, true);
    const resolved = await resolveCustomFsmGraphForTurn(saved.id);
    assert.equal(resolved.id, saved.id);
    assert.ok(resolved.config.nodes.length > 0);
  });
});
