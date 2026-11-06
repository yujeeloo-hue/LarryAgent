/**
 * Sidebar session hand-over (cocoService.handoverSession): marks the session
 * CoCo-managed, wakes CoCo with a handover.md-rendered message carrying the
 * session tail, keeps the pending window (D-3) until the wake job starts,
 * and refuses cleanly while CoCo is disabled or the session is unknown.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionStore } from "./sessionRuntime.js";
import { createCocoService } from "./cocoService.js";
import { openSessionDb, upsertSession } from "../session/db/index.js";
import type { Session } from "../session/types.js";
import { configureCredentialsRoot, configureLegacyKeyBridgeForTests } from "../llm/credentials.js";
import { configureUserMemoryRoot } from "../memory/store.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import { registerBuiltins } from "../tools/index.js";

type WireMessage = { role: string; content?: unknown; tool_calls?: { function: { name: string; arguments: string } }[] };
type Reply = string | { partial: string; hold: Promise<void> };

async function fixture(reply: (messages: WireMessage[]) => Reply | Promise<Reply>, options: { enable?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "coco-handover-"));
  configureCredentialsRoot(root); configureLegacyKeyBridgeForTests(null); configureUserMemoryRoot(root);
  configurePromptDefaults(join(process.cwd(), "resources/prompts")); registerBuiltins();
  const requests: WireMessage[][] = [];
  const server = createServer(async (req, res) => {
    try {
      let body = ""; for await (const part of req) body += String(part);
      const parsed = JSON.parse(body) as { messages: WireMessage[] };
      requests.push(parsed.messages);
      const answer = await reply(parsed.messages);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (delta: unknown) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      if (typeof answer === "string") send({ content: answer });
      else { send({ content: answer.partial }); await Promise.race([answer.hold, new Promise<void>(resolve => res.on("close", () => resolve()))]); }
      if (!res.destroyed) { res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`); res.end("data: [DONE]\n\n"); }
    } catch (error) { res.writeHead(500).end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  writeFileSync(join(root, "settings.json"), JSON.stringify({
    providers: [{ id: "local", name: "Local fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: "native-chat" }],
    activeProviderId: "local", composerRunMode: "agent", userMemoryAutoExtract: false, projectMemoryAutoExtract: false, maxModelIterations: 8,
  }));
  // First store only creates the workspace; the session is seeded with the
  // real workspace id before the second (service-backed) store loads it.
  const seed = createSessionStore(root, { startBackgroundServices: false });
  const workspaceId = (await seed.createWorkspace({ name: "Handover fixture", path: root })).id;
  seed.memorySync.stop(); seed.database.close();
  const session: Session = {
    id: "handover-target", type: "agent", title: "Relay protocol refactor", createdAt: 1, updatedAt: 1,
    status: "idle", progressText: "", model: "native-chat", providerId: "local",
    workspaceId, workspacePath: root, pinned: false, archived: false, archivedAt: null,
    contextUsage: { usedTokens: 0 }, plan: null,
    messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Refactor the relay protocol handshake." }], createdAt: 1 }],
  };
  const db = openSessionDb(root);
  upsertSession(db, session);
  db.close();
  const store = createSessionStore(root, { startBackgroundServices: false });
  const coco = createCocoService(root, store, undefined, undefined, { projectAwareness: false });
  coco.start();
  if (options.enable !== false) coco.engine.command({ type: "activation", action: "enable" });
  const wait = async (predicate: () => boolean) => { for (let i = 0; i < 400 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 15)); assert.ok(predicate(), JSON.stringify(coco.engine.snapshot().messages.map(m => ({ role: m.role, text: m.text })))); };
  return {
    requests,
    get store() { return store; },
    get coco() { return coco; },
    wait,
    async close() { coco.stop(); await coco.shutdown(); store.memorySync.stop(); store.database.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); },
  };
}

test("hand-over marks the session, wakes CoCo from the tail, and clears pending when the wake job starts", { timeout: 20000 }, async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(messages => {
    const latest = String([...messages].reverse().find(m => m.role === "user")?.content);
    // The hand-over instruction rides a system message (ephemeral wake).
    if (JSON.stringify(messages).includes("You are CoCo receiving a session")) return "Taking over the session.";
    if (latest.includes("Hold the lane.")) return { partial: "Holding the lane.", hold };
    return "Taking over the session.";
  });
  try {
    f.coco.engine.command({ type: "chat", text: "Hold the lane." });
    await f.wait(() => f.coco.engine.snapshot().messages.some(m => m.text === "Holding the lane."));
    assert.deepEqual(f.coco.handoverSession("handover-target"), { ok: true });
    assert.equal(f.store.listSessions().find(s => s.id === "handover-target")!.source, "coco");
    assert.equal(f.coco.handoverPending("handover-target"), true, "queued wake keeps asks on the user (D-3 pending window)");
    const wake = f.coco.engine.snapshot().messages.filter(m => m.role === "user" && m.text.includes("handover-target")).at(-1);
    assert.ok(wake, "hand-over wake message is published in CoCo Chat");
    assert.match(wake!.text, /handed over/);
    assert.match(wake!.text, /Relay protocol refactor/);
    // Pointer-only wake: no conversation tail is assembled into the prompt.
    assert.doesNotMatch(wake!.text, /Refactor the relay protocol handshake/);
    assert.match(wake!.text, /Handover fixture/);
    release();
    await f.wait(() => f.coco.engine.snapshot().messages.some(m => m.role === "assistant" && m.text === "Taking over the session."));
    await f.wait(() => !f.coco.handoverPending("handover-target"));
    // Ephemeral wake: marker and instruction ride the turn only — neither ever
    // lands in the chat session transcript (the LLM context of later turns).
    const chat = f.store.getSession(f.coco.engine.snapshot().chat!.sessionId)!;
    const userTexts = JSON.stringify(chat.messages.filter(m => m.role === "user"));
    assert.doesNotMatch(userTexts, /handed over/);
    assert.doesNotMatch(userTexts, /You are CoCo receiving/);
  } finally { await f.close(); }
});

test("hand-over validates input and is idempotent", { timeout: 20000 }, async () => {
  const f = await fixture(() => "Taking over the session.");
  try {
    assert.equal((f.coco.handoverSession("missing") as { error: string }).error, "Unknown session.");
    assert.deepEqual(f.coco.handoverSession("handover-target"), { ok: true });
    await f.wait(() => f.coco.engine.snapshot().messages.some(m => m.role === "assistant" && m.text === "Taking over the session."));
    const wakeCount = f.coco.engine.snapshot().messages.filter(m => m.role === "user" && m.text.includes("handover-target")).length;
    assert.deepEqual(f.coco.handoverSession("handover-target"), { ok: true });
    assert.equal(f.coco.engine.snapshot().messages.filter(m => m.role === "user" && m.text.includes("handover-target")).length, wakeCount, "re-handover never wakes CoCo again");
  } finally { await f.close(); }
});

test("hand-over refuses while CoCo is disabled", { timeout: 20000 }, async () => {
  const f = await fixture(() => "unused", { enable: false });
  try {
    const result = f.coco.handoverSession("handover-target") as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Enable CoCo/);
    assert.notEqual(f.store.listSessions().find(s => s.id === "handover-target")!.source, "coco");
  } finally { await f.close(); }
});

test("take-back flips the source to user-owned, is idempotent, and re-hand-over works", { timeout: 20000 }, async () => {
  const f = await fixture(messages => {
    return JSON.stringify(messages).includes("You are CoCo receiving a session") ? "Taking over the session." : "unused";
  });
  try {
    assert.equal((f.store.reclaimCocoSession("missing") as { error: string }).error, "Unknown session.");
    assert.deepEqual(f.coco.handoverSession("handover-target"), { ok: true });
    await f.wait(() => f.coco.engine.snapshot().messages.some(m => m.role === "assistant" && m.text === "Taking over the session."));
    assert.equal(f.store.listSessions().find(s => s.id === "handover-target")!.source, "coco");
    // Take back: store-level, no CoCo involvement.
    assert.deepEqual(f.store.reclaimCocoSession("handover-target"), { ok: true });
    assert.equal(f.store.listSessions().find(s => s.id === "handover-target")!.source, "app");
    assert.deepEqual(f.store.reclaimCocoSession("handover-target"), { ok: true }, "reclaim is idempotent on user-owned rows");
    // Handing over again works right away (a fresh wake job).
    assert.deepEqual(f.coco.handoverSession("handover-target"), { ok: true });
    assert.equal(f.store.listSessions().find(s => s.id === "handover-target")!.source, "coco");
  } finally { await f.close(); }
});

test("take-back works while CoCo is disabled and refuses archived sessions", { timeout: 20000 }, async () => {
  const f = await fixture(() => "unused", { enable: false });
  try {
    // Marker left by an earlier hand-over: reclaiming must not need the engine.
    assert.equal(f.store.setSessionSource("handover-target", "coco"), true);
    assert.deepEqual(f.store.reclaimCocoSession("handover-target"), { ok: true });
    assert.equal(f.store.listSessions().find(s => s.id === "handover-target")!.source, "app");
    f.store.setSessionArchived("handover-target", true);
    assert.equal(f.store.setSessionSource("handover-target", "coco"), true);
    assert.match((f.store.reclaimCocoSession("handover-target") as { error: string }).error, /archived/);
  } finally { await f.close(); }
});
