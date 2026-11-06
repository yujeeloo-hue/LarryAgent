import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { COCO_MEMORY_SOFT_CAP, formatCocoMemory, emptyCocoMemory, parseCocoMemory } from "../coco/memory.js";
import { CocoRepository } from "../coco/repository.js";
import { openSessionDb } from "../session/db/openDb.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import { COCO_HOME_WORKSPACE_ID, getWorkspace, loadAllWorkspaces } from "../workspace/index.js";
import { createCocoMemory, ensureCocoHome, readCocoPersona, resetCocoAutonomousPrompt, type CocoMemoryArchiveRecord } from "./cocoHome.js";
import { createHash } from "node:crypto";

let root = "";
before(() => { configurePromptDefaults(join(process.cwd(), "resources", "prompts")); root = mkdtempSync(join(tmpdir(), "coco-home-")); });
after(() => rmSync(root, { recursive: true, force: true }));

test("home seeds persona files once and stays out of the project list", () => {
  const db = openSessionDb(root);
  const home = ensureCocoHome(root, db);
  assert.equal(getWorkspace(db, COCO_HOME_WORKSPACE_ID)?.path, home);
  assert.equal(loadAllWorkspaces(db).some(w => w.id === COCO_HOME_WORKSPACE_ID), false);
  writeFileSync(join(home, "SOUL.md"), "Custom soul\n");
  ensureCocoHome(root, db);
  const persona = readCocoPersona(home);
  assert.equal(persona.soul, "Custom soul");
  assert.match(persona.agent, /You are CoCo/);
  assert.equal(persona.memory.label, "COCO_MEMORY");
  assert.match(persona.memory.body, /## Open items/);
  db.close();
});

test("untouched persona copies follow the shipped default; edited copies are kept", () => {
  const base = join(root, "upgrade"), db = openSessionDb(base);
  const home = ensureCocoHome(base, db);
  const agentPath = join(home, "AGENT.md"), autoPath = join(home, "COCO_AUTONOMOUS_EXEC_PROMPT.md");
  const shipped = readFileSync(agentPath, "utf8");
  const record = JSON.parse(readFileSync(join(home, ".seeded.json"), "utf8")) as Record<string, string>;
  // Simulate an older default that was seeded and never edited.
  writeFileSync(agentPath, "# Old default\n");
  writeFileSync(join(home, ".seeded.json"), JSON.stringify({ ...record, "AGENT.md": createHash("sha256").update("# Old default\n").digest("hex") }));
  writeFileSync(autoPath, "My own wake policy\n");
  ensureCocoHome(base, db);
  assert.equal(readFileSync(agentPath, "utf8"), shipped);
  assert.equal(readFileSync(autoPath, "utf8"), "My own wake policy\n");
  resetCocoAutonomousPrompt(home);
  assert.match(readFileSync(autoPath, "utf8"), /^# Autonomous execution/);
  db.close();
});

const bigLog = (): string => Array.from({ length: 80 }, (_, i) => `- 2026-10-${String(i % 28 + 1).padStart(2, "0")} 10:00 · entry ${i} ${"y".repeat(150)}`).join("\n");

test("over the cap, a malformed LLM rewrite falls back to oldest-first trimming and archives what left", async () => {
  const db = openSessionDb(join(root, "trim")), repository = new CocoRepository(db), home = join(root, "trim", "coco");
  const memory = createCocoMemory({ home, repository, timezone: () => "UTC" });
  const outcome = await memory.update({ section: "work_log", content: bigLog(), mode: "merge" }, async () => "not a memory file");
  const body = readFileSync(memory.path, "utf8");
  assert.equal(outcome.compacted, "trim");
  assert.ok(body.length <= COCO_MEMORY_SOFT_CAP);
  const archived = memory.searchArchive("entry 0", 50);
  assert.ok(archived.some(e => e.text.includes("entry 0 ")));
  assert.equal(archived.every(e => e.reason === "trim"), true);
  assert.equal(parseCocoMemory(body).work_log.length + repository.list<CocoMemoryArchiveRecord>("memoryArchive").length, 80);
  db.close();
});

test("an accepted LLM rewrite is written and every dropped bullet is archived verbatim", async () => {
  const db = openSessionDb(join(root, "llm")), repository = new CocoRepository(db), home = join(root, "llm", "coco");
  const memory = createCocoMemory({ home, repository, timezone: () => "UTC" });
  await memory.update({ section: "open_items", content: "- [open] o1: decide release date", mode: "merge" });
  const distilled = formatCocoMemory({ ...emptyCocoMemory(), focus: ["- Release prep (distilled)"], open_items: ["- [open] o1: decide release date"] });
  const outcome = await memory.update({ section: "work_log", content: bigLog(), mode: "merge" }, async () => distilled);
  assert.equal(outcome.compacted, "consolidate");
  assert.equal(readFileSync(memory.path, "utf8"), distilled);
  assert.equal(repository.list<CocoMemoryArchiveRecord>("memoryArchive").length, 80);
  assert.equal(memory.searchArchive("ENTRY 79", 5).length, 1);
  db.close();
});
