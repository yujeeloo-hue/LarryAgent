import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { CocoEngine } from "../coco/engine.js";
import { CocoRepository } from "../coco/repository.js";
import { CocoToolRuntime } from "../coco/toolRuntime.js";
import { setProjectMemoryBody } from "../projectMemory/store.js";
import { openSessionDb } from "../session/db/openDb.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import { createCocoAwareness, fallbackDigest, projectMdHash, PROJECT_CHANGE_DEBOUNCE_MS, type CocoProjectDigest, type CocoProjectTask } from "./cocoAwareness.js";
import { createCocoMemory } from "./cocoHome.js";
import type { SessionStore } from "./sessionRuntime.js";

let root = "";
before(() => { configurePromptDefaults(join(process.cwd(), "resources", "prompts")); root = mkdtempSync(join(tmpdir(), "coco-awareness-")); });
after(() => rmSync(root, { recursive: true, force: true }));

const PROJECT_MD = "# Project\n\n## Basics\n\nA tiny CLI that renames photos by EXIF date.\n\n## Structure\n\n- src/ — code\n";

/** The model is unreachable in tests, so digests use the deterministic fallback. */
function fixture(name: string, projects: { id: string; name: string; path: string }[]) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const db = openSessionDb(dir), repository = new CocoRepository(db);
  const memory = createCocoMemory({ home: join(dir, "coco"), repository, timezone: () => "UTC" });
  const scope = { workspaces: [...projects] };
  const store = { listSessions: () => [], isTurnActive: () => false } as unknown as SessionStore;
  const engine = { settings: () => ({ enabled: true }), ownsExecution: () => true } as unknown as CocoEngine;
  const awareness = createCocoAwareness({
    root: dir, store, repository, tools: new CocoToolRuntime(), alive: () => true, engine: () => engine,
    context: () => ({ workspaces: scope.workspaces, sessions: [], changes: [] }), memory, home: join(dir, "coco"),
  });
  const providers = { main: "missing", fast: "missing" };
  return { db, repository, memory, awareness, scope, providers, close: () => { awareness.stop(); db.close(); } };
}
const project = (base: string, id: string, files: Record<string, string>) => {
  const path = join(root, base, id);
  mkdirSync(path, { recursive: true });
  for (const [file, body] of Object.entries(files)) writeFileSync(join(path, file), body);
  return { id, name: id.toUpperCase(), path };
};
const usage = (): void => {};

test("first sync onboards documented and empty projects and records them in memory", async () => {
  const documented = project("onboard", "alpha", { "PROJECT.md": PROJECT_MD });
  const empty = project("onboard", "empty", { ".gitkeep": "" });
  const f = fixture("onboard", [documented, empty]);
  await f.awareness.sync();
  assert.deepEqual(f.repository.list<CocoProjectTask>("projectTask").map(t => t.reason), ["onboard", "onboard"]);
  assert.ok(f.repository.meta<number>("projectsOnboardedAt", 0) > 0);
  assert.ok(f.awareness.pending(Date.now()));
  const outcome = await f.awareness.run(new AbortController().signal, usage, f.providers);
  assert.equal(outcome.notices.length, 1);
  assert.match(outcome.notices[0]!, /looked through your projects/);
  assert.match(outcome.notices[0]!, /ALPHA/);
  assert.equal(f.repository.get<CocoProjectDigest>("projectDigest", "alpha")?.state, "documented");
  assert.equal(f.repository.get<CocoProjectDigest>("projectDigest", "alpha")?.hash, projectMdHash(PROJECT_MD));
  assert.equal(f.repository.get<CocoProjectDigest>("projectDigest", "empty")?.state, "empty");
  assert.equal(f.repository.list("projectTask").length, 0);
  const body = await f.memory.read();
  assert.match(body, new RegExp(`- ALPHA — ${documented.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — A tiny CLI`));
  assert.match(body, /- EMPTY — .* — Empty project/);
  f.close();
});

test("a project added after onboarding is reported as new; removed projects leave memory", async () => {
  const alpha = project("added", "alpha", { "PROJECT.md": PROJECT_MD });
  const f = fixture("added", [alpha]);
  await f.awareness.sync();
  await f.awareness.run(new AbortController().signal, usage, f.providers);
  const beta = project("added", "beta", { "PROJECT.md": PROJECT_MD.replace("photos", "invoices") });
  f.scope.workspaces.push(beta);
  await f.awareness.sync();
  assert.equal(f.repository.get<CocoProjectTask>("projectTask", "beta")?.reason, "added");
  const outcome = await f.awareness.run(new AbortController().signal, usage, f.providers);
  assert.match(outcome.notices[0]!, /New project added/);
  f.scope.workspaces.splice(0, 1);
  await f.awareness.sync();
  assert.equal(f.repository.get("projectDigest", "alpha"), undefined);
  const body = await f.memory.read();
  assert.doesNotMatch(body, /ALPHA/);
  assert.match(body, /BETA/);
  f.close();
});

test("PROJECT.md writes queue a debounced change unless the content is unchanged", async () => {
  const alpha = project("changed", "alpha", { "PROJECT.md": PROJECT_MD });
  const f = fixture("changed", [alpha]);
  f.awareness.start();
  await f.awareness.sync();
  await f.awareness.run(new AbortController().signal, usage, f.providers);
  await setProjectMemoryBody(alpha.path, PROJECT_MD);
  assert.equal(f.repository.get("projectTask", "alpha"), undefined, "same hash is ignored");
  const before = Date.now();
  await setProjectMemoryBody(alpha.path, `${PROJECT_MD}\n## Recent\n\n- Added HEIC support\n`);
  const task = f.repository.get<CocoProjectTask>("projectTask", "alpha");
  assert.equal(task?.reason, "changed");
  assert.ok(task!.readyAt >= before + PROJECT_CHANGE_DEBOUNCE_MS);
  assert.equal(f.awareness.pending(Date.now()), false, "debounced");
  assert.equal(f.awareness.pending(task!.readyAt), true);
  f.close();
});

test("the deterministic digest reads the Basics section", () => {
  assert.equal(fallbackDigest(PROJECT_MD).line, "A tiny CLI that renames photos by EXIF date.");
  assert.equal(fallbackDigest("").line, "PROJECT.md present");
});
