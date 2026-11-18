import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CocoEngine, type CocoPorts } from "./engine.js";
import { CocoRepository } from "./repository.js";
import { defaultSettings } from "./validation.js";

test("first visit is durable, leaves CoCo off, and never dispatches queued model work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "coco-activation-")), path = join(directory, "state.sqlite");
  let db = new DatabaseSync(path), calls = 0;
  const ports: CocoPorts = { context: () => ({ workspaces: [], sessions: [] }), model: async () => { calls++; return { markdown: "A report" }; }, execute: async () => { throw new Error("No execution expected"); } };
  let repository = new CocoRepository(db), engine = new CocoEngine(repository, ports);
  try {
    assert.equal(defaultSettings().enabled, false);
    assert.equal(engine.snapshot().activationSeen, false);
    repository.put("job", { id: "queued-report", kind: "report", status: "queued", at: Date.now(), priority: 1 });
    engine.start(); await engine.tick();
    assert.equal(engine.snapshot().settings.enabled, false); assert.equal(calls, 0);
    assert.throws(() => engine.command({ type: "chat", text: "Should not run" }), /Enable CoCo/);
    const visited = engine.command({ type: "activation", action: "visit" });
    assert.equal(visited.activationSeen, true); assert.equal(visited.settings.enabled, false);
    await engine.tick(); assert.equal(calls, 0);
    engine.stop(); await engine.settled(); db.close();
    db = new DatabaseSync(path); repository = new CocoRepository(db); engine = new CocoEngine(repository, ports);
    assert.equal(engine.snapshot().activationSeen, true); assert.equal(engine.snapshot().settings.enabled, false);
    engine.start(); await engine.tick(); assert.equal(calls, 0);
    const enabled = engine.command({ type: "activation", action: "enable" });
    assert.equal(enabled.settings.enabled, true); assert.equal(enabled.activationSeen, true);
    await engine.settled(); assert.equal(calls, 1);
    engine.command({ type: "settings", settings: { ...engine.settings(), enabled: false } });
    assert.equal(engine.snapshot().activationSeen, true); assert.equal(repository.list("job").length, 1);
    assert.equal(repository.list("report").length, 1, "turning CoCo off retains its history");
  } finally { engine.stop(); await engine.settled(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("activation preserves configured limits and projects, including an existing enabled choice", async () => {
  const db = new DatabaseSync(":memory:"), repository = new CocoRepository(db);
  const engine = new CocoEngine(repository, { context: () => ({ workspaces: [], sessions: [] }), model: async () => ({}), execute: async () => { throw new Error("Unexpected execution"); } });
  try {
    const settings = { ...defaultSettings(), enabled: true, hourlyTokens: 1234, excludedWorkspaceIds: ["private-project"] };
    repository.setMeta("settings", settings); engine.start();
    assert.equal(engine.snapshot().settings.enabled, true);
    engine.command({ type: "activation", action: "visit" });
    assert.deepEqual(engine.settings(), settings);
    engine.command({ type: "settings", settings: { ...settings, enabled: false } });
    engine.command({ type: "activation", action: "enable" });
    assert.deepEqual(engine.settings(), settings);
  } finally { engine.stop(); await engine.settled(); db.close(); }
});
