/**
 * Regression tests for the commander-only `coco_workspace` tool: folder
 * creation, idempotent registration, the non-empty/non-git accident guard,
 * origin provenance (and its IPC-level default), plus the legacy DB
 * migration that backfills `origin` as "user". Also covers the read-only
 * `coco_balance` tool on the same commander fixture.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionStore } from "./sessionRuntime.js";
import { createCocoService } from "./cocoService.js";
import { configureCredentialsRoot, configureLegacyKeyBridgeForTests } from "../llm/credentials.js";
import { configureUserMemoryRoot } from "../memory/store.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import { registerBuiltins } from "../tools/index.js";
import type { Session } from "../session/types.js";

type WireMessage = { role: string; content?: unknown; tool_calls?: { function: { name: string; arguments: string } }[] };
type Reply = string | { tool: string; args: unknown };
type WorkspaceArgs = { action: "create" | "list"; name?: string; path?: string };

async function fixture(toolArgsByTurn: (text: string) => object | undefined, tool = "coco_workspace") {
  const root = mkdtempSync(join(tmpdir(), "coco-workspace-"));
  configureCredentialsRoot(root); configureLegacyKeyBridgeForTests(null); configureUserMemoryRoot(root);
  configurePromptDefaults(join(process.cwd(), "resources/prompts")); registerBuiltins();
  const requests: { tools: string[] }[] = [];
  let calls = 0;
  const server = createServer(async (req, res) => {
    try {
      let body = ""; for await (const part of req) body += String(part);
      const parsed = JSON.parse(body) as { messages: WireMessage[]; tools?: { function?: { name?: string } }[] };
      requests.push({ tools: (parsed.tools ?? []).flatMap(t => t.function?.name ? [t.function.name] : []) });
      calls++;
      const latestUserIndex = [...parsed.messages].reverse().findIndex(m => m.role === "user");
      const currentTurn = latestUserIndex >= 0 ? parsed.messages.slice(parsed.messages.length - 1 - latestUserIndex) : parsed.messages;
      const args = toolArgsByTurn(String(currentTurn[0]?.content ?? ""));
      const alreadyCalled = currentTurn.some(m => m.tool_calls?.some(c => c.function.name === tool));
      const answer: Reply = args && !alreadyCalled ? { tool, args } : "Done.";
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (delta: unknown) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      if (typeof answer === "string") send({ content: answer });
      else send({ tool_calls: [{ index: 0, id: `call-${calls}`, type: "function", function: { name: answer.tool, arguments: JSON.stringify(answer.args) } }] });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: typeof answer === "string" ? "stop" : "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    } catch (error) { res.writeHead(500).end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  writeFileSync(join(root, "settings.json"), JSON.stringify({ providers: [{ id: "local", name: "Local fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: "native-chat" }], activeProviderId: "local", composerRunMode: "agent", userMemoryAutoExtract: false, projectMemoryAutoExtract: false, maxModelIterations: 8 }));
  const store = createSessionStore(root, { startBackgroundServices: false });
  const projectId = (await store.createWorkspace({ name: "Chat fixture", path: root })).id;
  const coco = createCocoService(root, store, undefined, undefined, { projectAwareness: false });
  coco.start(); coco.engine.command({ type: "activation", action: "enable" });
  const wait = async (predicate: () => boolean) => { for (let i = 0; i < 400 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 15)); assert.ok(predicate()); };
  const send = async (text: string) => { coco.engine.command({ type: "chat", text, workspaceId: projectId }); await wait(() => !coco.engine.snapshot().chatJob && coco.engine.snapshot().messages.at(-1)?.role === "assistant"); };
  const lastToolResult = (): { text: string; returnCode: number } => {
    const chatId = coco.engine.repository.meta<string>("chatSessionId", "");
    const session = store.getSession(chatId) as Session;
    const parts = session.messages.flatMap(m => m.parts);
    const index = [...parts].reverse().findIndex(p => p.type === "tool_result");
    assert.ok(index >= 0, "a tool result landed in the transcript");
    const part = parts[parts.length - 1 - index] as { type: "tool_result"; content: { type: string; text: string }[]; returnCode: number };
    return { text: part.content.map(c => c.type === "text" ? c.text : "").join(""), returnCode: part.returnCode };
  };
  return { root, requests, store, coco, send, lastToolResult, async close() { coco.stop(); await coco.shutdown(); store.memorySync.stop(); store.database.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); } };
}

test("coco_workspace creates folders, dedupes paths, guards data folders and reports origin", { timeout: 30000 }, async () => {
  const scratch = join(tmpdir(), `coco-ws-scratch-${Date.now()}`, "scratch");
  const paths = {
    "Create the scratch project.": { action: "create" as const, name: "Scratch", path: scratch },
    "Register it again.": { action: "create" as const, name: "Scratch again", path: scratch },
    "List my projects.": { action: "list" as const },
  };
  const root = mkdtempSync(join(tmpdir(), "coco-workspace-paths-"));
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, "data", "notes.txt"), "user data");
  mkdirSync(join(root, "empty"));
  mkdirSync(join(root, "repo", ".git"), { recursive: true });
  writeFileSync(join(root, "repo", "README.md"), "# repo");
  writeFileSync(join(root, "afile.txt"), "x");
  const plan: Record<string, WorkspaceArgs | undefined> = {
    ...paths,
    "Take this file as a project.": { action: "create", name: "NotAFolder", path: join(root, "afile.txt") },
    "Register my data folder.": { action: "create", name: "Data", path: join(root, "data") },
    "Register the empty folder.": { action: "create", name: "Empty", path: join(root, "empty") },
    "Register the repository.": { action: "create", name: "Repo", path: join(root, "repo") },
  };
  const f = await fixture(text => plan[text]);
  try {
    await f.send("Create the scratch project.");
    assert.ok(existsSync(scratch), "missing folder is created (mkdir -p)");
    let row = f.store.listWorkspaces().find(w => w.path === scratch);
    assert.ok(row && row.origin === "coco", "created workspace carries origin coco");
    assert.match(f.lastToolResult().text, /"origin":"coco"/);

    await f.send("Register it again.");
    assert.equal(f.store.listWorkspaces().filter(w => w.path === scratch).length, 1, "idempotent: no duplicate row");
    assert.match(f.lastToolResult().text, /"existing":true/);

    await f.send("List my projects.");
    const listed = JSON.parse(f.lastToolResult().text) as { workspaces: { path: string; origin: string }[] };
    const scratchEntry = listed.workspaces.find(w => w.path === scratch);
    assert.ok(scratchEntry && scratchEntry.origin === "coco", "list carries origin");

    await f.send("Take this file as a project.");
    assert.equal(f.lastToolResult().returnCode, 5, "non-folder path is invalid");
    assert.match(f.lastToolResult().text, /not a folder/);
    assert.ok(!f.store.listWorkspaces().some(w => w.path === join(root, "afile.txt")));

    await f.send("Register my data folder.");
    assert.equal(f.lastToolResult().returnCode, 2, "non-empty non-git folder is refused");
    assert.match(f.lastToolResult().text, /not a git repository/);
    assert.ok(!f.store.listWorkspaces().some(w => w.path === join(root, "data")));

    await f.send("Register the empty folder.");
    assert.match(f.lastToolResult().text, /"existing":false/);
    await f.send("Register the repository.");
    assert.match(f.lastToolResult().text, /"existing":false/);
    assert.equal(f.store.listWorkspaces().filter(w => w.path.startsWith(root)).length, 2, "empty folder and git repo both register");

    assert.ok(f.requests[0]!.tools.includes("coco_workspace"), "commander turns offer coco_workspace");
    assert.ok(f.requests[0]!.tools.includes("coco_work") && f.requests[0]!.tools.includes("coco_memory"), "sibling CoCo tools stay offered");
  } finally { await f.close(); rmSync(join(scratch, ".."), { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("coco_balance reports the automation budget and unknown balances without a key", { timeout: 30000 }, async () => {
  const f = await fixture(text => text === "How much budget is left?" ? {} : undefined, "coco_balance");
  try {
    await f.send("How much budget is left?");
    assert.ok(f.requests[0]!.tools.includes("coco_balance"), "commander turns offer coco_balance");
    const { text, returnCode } = f.lastToolResult();
    assert.equal(returnCode, 0);
    const body = JSON.parse(text) as {
      automation: { hourly: { used: number; limit: number }; daily: { used: number; limit: number }; cooling: boolean };
      providers: { providerId: string; isDefault: boolean; hasApiKey: boolean; balance: string | null; usageKey: string | null }[];
      usage: unknown[];
    };
    const settings = f.coco.engine.settings();
    assert.equal(body.automation.hourly.limit, settings.hourlyTokens);
    assert.equal(body.automation.daily.limit, settings.dailyTokens);
    assert.ok(body.automation.daily.used >= body.automation.hourly.used);
    assert.equal(body.automation.cooling, false);
    assert.deepEqual(body.providers, [{ providerId: "local", name: "Local fixture", modelId: "native-chat", isDefault: true, hasApiKey: false, balance: null, usageKey: null }]);
    assert.deepEqual(body.usage, [], "no supported usage provider configured");
  } finally { await f.close(); }
});

test("workspace origin defaults to user, persists, and legacy rows migrate as user", { timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "coco-ws-origin-"));
  const db = new DatabaseSync(join(root, "sessions.sqlite"));
  db.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);`);
  db.exec(`INSERT INTO schema_meta VALUES ('version', '24');`);
  db.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
  db.exec(`INSERT INTO workspaces VALUES ('w-legacy', 'Legacy', '/tmp/legacy', 1, 1);`);
  db.close();
  let store = createSessionStore(root, { startBackgroundServices: false });
  const fresh = await store.createWorkspace({ name: "Fresh", path: root });
  const made = await store.createWorkspace({ name: "Made", path: join(root, "made"), origin: "coco" });
  assert.equal(fresh.origin, "user", "IPC-shaped request (no origin) stays user");
  assert.equal(made.origin, "coco");
  const legacy = store.listWorkspaces().find(w => w.name === "Legacy");
  assert.equal(legacy?.origin, "user", "legacy row migrated with default origin");
  store.memorySync.stop(); store.database.close();
  store = createSessionStore(root, { startBackgroundServices: false });
  assert.equal(store.listWorkspaces().find(w => w.id === made.id)?.origin, "coco", "origin survives reopen");
  store.memorySync.stop(); store.database.close();
  rmSync(root, { recursive: true, force: true });
});
