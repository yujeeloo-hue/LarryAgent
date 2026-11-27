import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CocoRepository } from "../coco/repository.js";
import { CocoToolRuntime } from "../coco/toolRuntime.js";
import { defaultSettings } from "../coco/validation.js";
import type { CocoEngine } from "../coco/engine.js";
import type { CocoWork } from "../coco/types.js";
import type { SessionStore } from "./sessionRuntime.js";
import type { CocoServiceDeps } from "./cocoServiceDeps.js";
import { createCocoExecution } from "./cocoExecution.js";

test("aborting an execution whose turn never ends stops waiting instead of spinning", { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "coco-execution-abort-"));
  const db = new DatabaseSync(":memory:");
  const repository = new CocoRepository(db);
  const settings = { ...defaultSettings(), enabled: true, providerId: "local" };
  const workspaceId = "workspace";
  const abort = new AbortController();
  const cancels: string[] = [];
  const store = {
    listWorkspaces: () => [{ id: workspaceId, name: "Project", path: root }],
    listSessions: () => [],
    isTurnActive: () => true,
    isCocoTurnActive: () => true,
    hasCocoPrompts: () => false,
    onTurnActivity: () => () => {},
    pauseTurn: () => ({ ok: false }),
    cancelTurn: () => { cancels.push("cancel"); return { ok: true }; },
    clearCocoPrompts: () => {},
    getTurnLifecycle: () => undefined,
    getSessionTail: () => undefined,
    superviseCocoSession: () => () => {},
    startTurn: async () => { abort.abort(); return { sessionId: "stuck-session" }; },
  } as unknown as SessionStore;
  const engine = {
    budget: { cooling: () => false, on: () => () => {} },
    canContinueWork: () => true,
    ownsExecution: () => true,
    settings: () => settings,
    ask: async () => null,
    awaitWorkAnswer: async () => null,
  } as unknown as CocoEngine;
  const work = {
    id: "stuck-work", goalId: "goal", title: "Stuck turn", objective: "Do one thing", workspaceId,
    status: "draft", priority: 0, dependsOn: [], steps: [], acceptance: [], deliverables: [], ruleIds: [],
    revision: 1, repairs: 0, fullPermissions: true, providerId: "", createdAt: Date.now(), updatedAt: Date.now(),
    summary: "", timeline: [],
  } satisfies CocoWork;
  repository.put("work", work);
  const { execute } = createCocoExecution({
    root, store, repository, tools: new CocoToolRuntime(), alive: () => true,
    engine: () => engine, context: () => ({ workspaces: [], sessions: [] }),
  } as unknown as CocoServiceDeps);
  try {
    const startedAt = Date.now();
    await assert.rejects(execute(work, settings, abort.signal, () => {}, () => {}));
    assert.ok(Date.now() - startedAt < 12000, "the aborted execution returned instead of waiting on a stuck turn");
    assert.ok(cancels.length > 0, "the stuck turn was told to stop");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
