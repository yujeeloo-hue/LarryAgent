import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { configureFsmGraphsRoot, createForkFromBuiltin, createNewGraphRecord, getFsmGraph, listComposerGraphs, saveFsmGraph, setFsmGraphEnabled } from "../graphLibrary/manager.js";
import { graphConfigForMode } from "../FsmGraphWorkflow.js";
import { createDefaultActionRegistry } from "../actions/createDefaultActionRegistry.js";
import { executeGraphAuthoring, getGraphDraft, listGraphDrafts, saveGraphDraftFromEditor } from "./contexts.js";
import { analyzeGraph } from "./diagnostics.js";
import { ACTION_CONTRACTS } from "./contracts.js";
import type { FsmGraphAuthoringResult, FsmGraphToolFamily } from "../../../tools/fsmGraphAuthoring.js";
import type { FsmGraphLibraryRecord } from "../graphLibrary/types.js";
const owner = {
  workspacePath: "/workspace/project",
  sessionId: "session-a"
};
describe("incremental FSM authoring", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fsm-authoring-"));
    configureFsmGraphsRoot(root);
  });
  afterEach(async () => {
    await rm(root, {
      recursive: true,
      force: true
    });
  });
  async function edit(template?: string) {
    let current = await executeGraphAuthoring("context", {
      operation: "create",
      name: "Example",
      ...(template ? {
        template
      } : {})
    }, owner);
    assert.equal(current.ok, true, current.error ?? "create failed");
    const id = current.contextId as string;
    const call = async (family: FsmGraphToolFamily, input: Record<string, unknown>): Promise<FsmGraphAuthoringResult> => {
      const r = await executeGraphAuthoring(family, {
        contextId: id,
        expectedRevision: current.revision,
        ...input
      }, owner);
      if (r.ok && typeof r.revision === "number") current = r;
      return r;
    };
    return {
      id,
      call,
      state: () => current
    };
  }
  it("builds an initially invalid skeleton step by step, persists it, and gates enabling", async () => {
    const ctx = await edit();
    assert.equal(ctx.state().readyToCommit, false);
    const node = await ctx.call("node", {
      operation: "add",
      nodeId: "work"
    });
    assert.equal(node.ok, true);
    assert.equal(node.readyToCommit, false);
    assert.equal((await listGraphDrafts()).length, 1);
    assert.ok((await getGraphDraft(ctx.id)).config.nodes.some(n => n.id === "work"));
    assert.equal((await ctx.call("context", {
      operation: "commit"
    })).code, "GRAPH_INVALID");
    for (const [from, to] of [["start", "work"], ["work", "end"]]) assert.equal((await ctx.call("connection", {
      operation: "connect",
      from,
      to
    })).ok, true);
    for (const [nodeId, type] of [["start", "NodeActionStartTurn"], ["work", "NodeActionPrepareRole"], ["work", "NodeActionPrepareTools"], ["work", "NodeActionBuildModelWindow"], ["work", "NodeActionCallModel"], ["end", "NodeActionFinishIdle"]]) {
      const r = await ctx.call("action", {
        operation: "add",
        nodeId,
        type,
        params: type === "NodeActionPrepareRole" ? {
          roleKind: "worker",
          promptPreset: "agent"
        } : {}
      });
      assert.equal(r.ok, true, r.error ?? "edit failed");
    }
    assert.equal(ctx.state().readyToCommit, true);
    const saved = await ctx.call("context", {
      operation: "commit"
    });
    assert.equal(saved.ok, true, saved.error ?? "commit failed");
    const graph = saved.graph as FsmGraphLibraryRecord;
    assert.equal(graph.enabled, false);
    assert.ok(!(await listComposerGraphs()).some(g => g.id === graph.id));
    await setFsmGraphEnabled(graph.id, true);
    assert.ok((await listComposerGraphs()).some(g => g.id === graph.id));
    assert.equal(graph.config.nodes[1]!.actions!.some(a => "id" in a), false, "editing handles do not leak into executable actions");
  });
  it("rejects malformed params atomically while storing semantic dependencies as diagnostics", async () => {
    const ctx = await edit();
    const rev = ctx.state().revision;
    const bad = await ctx.call("action", {
      operation: "add",
      nodeId: "start",
      type: "NodeActionPrepareRole",
      params: {}
    });
    assert.equal(bad.ok, false);
    assert.equal((await ctx.call("context", {
      operation: "inspect"
    })).revision, rev);
    const good = await ctx.call("action", {
      operation: "add",
      nodeId: "start",
      type: "NodeActionCallModel"
    });
    assert.equal(good.ok, true);
    assert.equal(good.readyToCommit, false);
    const validation = (await ctx.call("context", {
      operation: "validate"
    })).validation as ReturnType<typeof analyzeGraph>;
    assert.ok(validation.issues.some(i => i.code === "ACTION_PREREQUISITE_MISSING" && !!i.actionId));
  });
  it("keeps stable action handles across insert, update, move and undo", async () => {
    const ctx = await edit();
    await ctx.call("action", {
      operation: "add",
      nodeId: "start",
      type: "NodeActionStartTurn",
      actionId: "first"
    });
    await ctx.call("action", {
      operation: "add",
      nodeId: "start",
      type: "NodeActionCompare",
      actionId: "check",
      params: {
        source: "planPresent",
        asKey: "plan.exists"
      }
    });
    await ctx.call("action", {
      operation: "move",
      nodeId: "start",
      actionId: "check",
      beforeActionId: "first"
    });
    let draft = await getGraphDraft(ctx.id);
    assert.equal((draft.config.nodes[0]!.actions![0] as {
      id?: string;
    }).id, "check");
    await ctx.call("action", {
      operation: "update",
      nodeId: "start",
      actionId: "check",
      params: {
        source: "planDocPresent",
        asKey: "doc.exists"
      }
    });
    await ctx.call("context", {
      operation: "undo"
    });
    draft = await getGraphDraft(ctx.id);
    assert.equal(draft.config.nodes[0]!.actions![0]!.params!.asKey, "plan.exists");
    const readOnly = await executeGraphAuthoring("node", {
      operation: "inspect",
      contextId: ctx.id,
      nodeId: "start"
    }, owner);
    assert.equal(readOnly.ok, true);
  });
  it("checks revisions under concurrent edits and isolates workspaces", async () => {
    const ctx = await edit();
    const same = {
      contextId: ctx.id,
      expectedRevision: 0,
      operation: "add"
    };
    const results = await Promise.all([executeGraphAuthoring("node", {
      ...same,
      nodeId: "one"
    }, owner), executeGraphAuthoring("node", {
      ...same,
      nodeId: "two"
    }, owner)]);
    assert.equal(results.filter(r => r.ok).length, 1);
    assert.equal(results.filter(r => r.code === "CONTEXT_CONFLICT").length, 1);
    const foreign = await executeGraphAuthoring("context", {
      operation: "inspect",
      contextId: ctx.id
    }, {
      workspacePath: "/other"
    });
    assert.equal(foreign.code, "CONTEXT_WORKSPACE_MISMATCH");
    configureFsmGraphsRoot(root);
    assert.equal((await getGraphDraft(ctx.id)).draftRevision, 1);
  });
  it("connects pins without overwriting an existing branch and describes actual node context", async () => {
    const ctx = await edit();
    await ctx.call("connection", {
      operation: "connect",
      from: "start",
      pin: "done",
      to: "end"
    });
    const rev = ctx.state().revision;
    const conflict = await ctx.call("connection", {
      operation: "connect",
      from: "start",
      pin: "done",
      to: "start"
    });
    assert.equal(conflict.code, "CONNECTION_CONFLICT");
    assert.equal((await getGraphDraft(ctx.id)).draftRevision, rev);
    const desc = await ctx.call("action", {
      operation: "describe",
      nodeId: "start",
      type: "NodeActionRouteTo"
    });
    assert.deepEqual((desc.context as {
      pins: string[];
    }).pins, ["done"]);
    assert.ok(desc.contract);
  });
  it("preserves the active saved graph while editing and detects concurrent saved changes", async () => {
    const saved = await saveFsmGraph(createNewGraphRecord("Active"));
    const opened = await executeGraphAuthoring("context", {
      operation: "open",
      graphId: saved.id
    }, owner);
    await executeGraphAuthoring("node", {
      operation: "add",
      contextId: opened.contextId,
      expectedRevision: 0,
      nodeId: "unfinished"
    }, owner);
    assert.equal((await getFsmGraph(saved.id))!.enabled, true);
    assert.ok(!(await getFsmGraph(saved.id))!.config.nodes.some(n => n.id === "unfinished"));
    const another = await executeGraphAuthoring("context", {
      operation: "open",
      graphId: saved.id
    }, owner);
    await saveFsmGraph({
      ...saved,
      name: "Changed elsewhere"
    });
    const conflict = await executeGraphAuthoring("context", {
      operation: "commit",
      contextId: another.contextId,
      expectedRevision: 0
    }, owner);
    assert.equal(conflict.code, "GRAPH_CONFLICT");
  });
  it("allows invalid saved graphs to remain editable and removes them from Composer", async () => {
    const saved = await saveFsmGraph(createNewGraphRecord("Editable"));
    saved.config.nodes.push({
      id: "unfinished",
      actions: []
    });
    const invalid = await saveFsmGraph(saved);
    assert.equal(invalid.enabled, false);
    assert.equal(invalid.validation!.valid, false);
    assert.ok(await getFsmGraph(saved.id));
    await assert.rejects(() => setFsmGraphEnabled(saved.id, true));
    assert.ok(!(await listComposerGraphs()).some(g => g.id === saved.id));
    const raw = JSON.parse(await readFile(join(root, `${saved.id}.json`), "utf8"));
    raw.enabled = true;
    await writeFile(join(root, `${saved.id}.json`), JSON.stringify(raw));
    assert.equal((await getFsmGraph(saved.id))!.enabled, false, "stale disk enabled flags cannot bypass live validation");
    await assert.rejects(() => setFsmGraphEnabled(saved.id, true), /no exit/);
  });
  it("lets the editor save incomplete drafts and commit only valid revisions", async () => {
    const ctx = await edit("ask");
    let record = await getGraphDraft(ctx.id);
    record.config.nodes.push({
      id: "unfinished",
      actions: []
    });
    record = await saveGraphDraftFromEditor(record);
    assert.equal(record.validation!.valid, false);
    await assert.rejects(() => saveGraphDraftFromEditor(record, true));
    const refreshed = await getGraphDraft(ctx.id);
    refreshed.config.nodes = refreshed.config.nodes.filter(n => n.id !== "unfinished");
    const done = await saveGraphDraftFromEditor(refreshed, true);
    assert.equal(done.validation!.valid, true);
    assert.ok(await getFsmGraph(ctx.state().graphId as string));
  });
  it("accepts all current built-in graph patterns including implicit stay loops and composites", () => {
    for (const mode of ["react", "react_v2", "ask", "plan_execute", "subagent"] as const) {
      const validation = analyzeGraph(graphConfigForMode(mode));
      assert.equal(validation.valid, true, `${mode}: ${JSON.stringify(validation.issues.filter(i => i.severity === "error"))}`);
    }
  });
  it("keeps documented minimum action examples valid against the actual registry", () => {
    const registry = createDefaultActionRegistry();
    for (const [type, contract] of Object.entries(ACTION_CONTRACTS)) assert.doesNotThrow(() => registry.prepareAction(type, contract.example, type), type);
  });
  it("blocks pin connections without a route producer and empty RouteTo mappings", () => {
    const config = createNewGraphRecord("Routing").config;
    const node = config.nodes.find(n => n.id === "agent")!;
    node.actions = [];
    assert.ok(analyzeGraph(config).issues.some(issue => issue.code === "MISSING_ROUTE_PRODUCER"));
    node.actions = [{
      type: "NodeActionRouteTo",
      params: {}
    }];
    assert.ok(analyzeGraph(config).issues.some(issue => issue.code === "EMPTY_ROUTE_MAPPING"));
    node.actions = [{
      type: "NodeActionRouteTo",
      params: {
        routes: [{
          event: "stay",
          to: "agent"
        }, {
          event: "leave",
          to: "skill_reflect_gate"
        }]
      }
    }];
    assert.equal(analyzeGraph(config).valid, true);
  });
});
