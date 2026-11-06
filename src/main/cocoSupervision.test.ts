/**
 * Session supervision (sidebar hand-over): ask_user / tool approvals on
 * handed-over sessions (source === "coco") are answered by CoCo's decide
 * model; needs_user and unsupervised sessions fall back to the user. The
 * D-3 pending window (click → wake job start) keeps asks on the user.
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
type RunTurn = NonNullable<NonNullable<Parameters<typeof createSessionStore>[1]>["runAgentTurn"]>;
type RunAgentTurn = NonNullable<Parameters<typeof createSessionStore>[1]>["runAgentTurn"];

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
};

const latestUser = (messages: WireMessage[]): string => String([...messages].reverse().find(m => m.role === "user")?.content);

async function fixture(llmReply: (messages: WireMessage[]) => Reply | Promise<Reply>, runAgentTurn: RunTurn) {
  const root = mkdtempSync(join(tmpdir(), "coco-supervision-"));
  configureCredentialsRoot(root); configureLegacyKeyBridgeForTests(null); configureUserMemoryRoot(root);
  configurePromptDefaults(join(process.cwd(), "resources/prompts")); registerBuiltins();
  const requests: WireMessage[][] = [];
  const server = createServer(async (req, res) => {
    try {
      let body = ""; for await (const part of req) body += String(part);
      const parsed = JSON.parse(body) as { messages: WireMessage[] };
      requests.push(parsed.messages);
      const answer = await llmReply(parsed.messages);
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
  const seed = createSessionStore(root, { startBackgroundServices: false });
  const workspaceId = (await seed.createWorkspace({ name: "Supervision fixture", path: root })).id;
  seed.memorySync.stop(); seed.database.close();
  const session: Session = {
    id: "supervised", type: "agent", title: "Supervised session", createdAt: 1, updatedAt: 1,
    status: "idle", progressText: "", model: "native-chat", providerId: "local",
    workspaceId, workspacePath: root, pinned: false, archived: false, archivedAt: null,
    contextUsage: { usedTokens: 0 }, plan: null,
    messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Refactor the relay handshake." }], createdAt: 1 }],
  };
  const db = openSessionDb(root);
  upsertSession(db, session);
  db.close();
  const store = createSessionStore(root, { startBackgroundServices: false, runAgentTurn });
  const coco = createCocoService(root, store, undefined, undefined, { projectAwareness: false });
  coco.start(); coco.engine.command({ type: "activation", action: "enable" });
  const wait = async (predicate: () => boolean) => { for (let i = 0; i < 400 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 15)); assert.ok(predicate(), JSON.stringify(coco.engine.snapshot().messages.map(m => ({ role: m.role, text: m.text })))); };
  return {
    requests,
    get store() { return store; },
    get coco() { return coco; },
    wait,
    async close() { coco.stop(); await coco.shutdown(); store.memorySync.stop(); store.database.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); },
  };
}

test("handed-over session asks are answered by CoCo's decide model", { timeout: 20000 }, async () => {
  const gate = deferred<void>();
  let entered = 0;
  let answered: { selected?: string } | undefined;
  const f = await fixture(
    messages => latestUser(messages).includes("Reuse existing code?") ? '{"action":"answer","answer":"Reuse the existing parser"}' : "unused",
    async input => {
      entered += 1;
      await gate.promise;
      answered = (await input.gate.requestUserAsk({ toolCallId: "q", question: "Reuse existing code?", options: ["Reuse the existing parser", "Add a new parser"], allowCustom: false })) ?? undefined;
      input.session.status = "idle";
      return { status: "idle", modelIterations: 0 };
    },
  );
  try {
    await f.store.startTurn({ sessionId: "supervised", userText: "Continue", fullPermissions: false });
    await f.wait(() => entered === 1);
    assert.equal(f.store.setSessionSource("supervised", "coco"), true);
    gate.resolve();
    await f.wait(() => !f.store.isTurnActive("supervised"));
    assert.equal((answered as { selected: string })?.selected, "Reuse the existing parser");
    assert.equal(f.store.listPendingUserAsks("supervised").length, 0, "no user-facing ask remains");
  } finally { gate.resolve(); await f.close(); }
});

test("needs_user parks the ask on the CoCo Chat card and the answer resumes the turn", { timeout: 20000 }, async () => {
  const gate = deferred<void>();
  let entered = 0;
  let answered: { selected?: string } | undefined;
  const f = await fixture(
    messages => latestUser(messages).includes("Reuse existing code?") ? '{"action":"needs_user","reason":"Goal-changing decision"}' : "unused",
    async input => {
      if (input.session.id !== "supervised") { input.session.status = "idle"; return { status: "idle", modelIterations: 0 }; }
      entered += 1;
      await gate.promise;
      answered = (await input.gate.requestUserAsk({ toolCallId: "q", question: "Reuse existing code?", options: ["Reuse the existing parser", "Add a new parser"], allowCustom: false })) ?? undefined;
      input.session.status = "idle";
      return { status: "idle", modelIterations: 0 };
    },
  );
  try {
    f.coco.engine.command({ type: "chat", text: "Hi CoCo" });
    await f.wait(() => Boolean(f.coco.engine.snapshot().chat?.sessionId));
    await f.store.startTurn({ sessionId: "supervised", userText: "Continue", fullPermissions: false });
    await f.wait(() => entered === 1);
    f.store.setSessionSource("supervised", "coco");
    gate.resolve();
    await f.wait(() => f.store.listPendingUserAsks("supervised").length === 1);
    const pending = f.store.listPendingUserAsks("supervised")[0]!;
    // The parked ask projects as the CoCo Chat card, labeled with the origin.
    await f.wait(() => f.coco.engine.snapshot().chat?.question?.requestId === pending.requestId);
    assert.equal(f.coco.engine.snapshot().chat?.question?.onBehalfOf, "Supervised session");
    f.coco.engine.command({ type: "chatControl", action: "answer", requestId: pending.requestId, selected: "Add a new parser", custom: false });
    await f.wait(() => !f.store.isTurnActive("supervised"));
    assert.equal((answered as { selected: string })?.selected, "Add a new parser");
    assert.equal(f.store.listCocoParkedRequests().length, 0);
  } finally { gate.resolve(); await f.close(); }
});

test("tool approvals on handed-over sessions are decided by CoCo", { timeout: 20000 }, async () => {
  const gate = deferred<void>();
  let entered = 0;
  let decision: boolean | undefined;
  let approveAnswer = "Deny";
  const f = await fixture(
    messages => latestUser(messages).includes("wants to run") ? `{"action":"answer","answer":"${approveAnswer}"}` : "unused",
    async input => {
      entered += 1;
      await gate.promise;
      decision = await input.gate.requestConfirmation({ toolName: "shell", arguments: { command: "rm -rf /tmp/junk" } });
      input.session.status = "idle";
      return { status: "idle", modelIterations: 0 };
    },
  );
  try {
    await f.store.startTurn({ sessionId: "supervised", userText: "Continue", fullPermissions: false });
    await f.wait(() => entered === 1);
    f.store.setSessionSource("supervised", "coco");
    gate.resolve();
    await f.wait(() => !f.store.isTurnActive("supervised"));
    assert.equal(decision, false, "CoCo denies the risky call");
    approveAnswer = "Approve";
    await f.store.startTurn({ sessionId: "supervised", userText: "Continue", fullPermissions: false });
    await f.wait(() => !f.store.isTurnActive("supervised"));
    assert.equal(decision, true, "CoCo approves the safe call");
    assert.equal(f.store.listPendingUserAsks("supervised").length, 0);
  } finally { gate.resolve(); await f.close(); }
});

test("supervised sessions get live Full permissions and high-risk review; take-back clears both", { timeout: 20000 }, async () => {
  const before = deferred<void>(), during = deferred<void>(), after = deferred<void>();
  const seen: { full: boolean; review: boolean }[] = [];
  let entered = 0;
  const f = await fixture(
    () => "unused",
    async input => {
      entered += 1;
      const probe = () => seen.push({ full: input.gate.fullPermissionsEnabled, review: input.gate.reviewHighRisk === true });
      probe(); await before.promise;
      probe(); await during.promise;
      probe(); await after.promise;
      input.session.status = "idle";
      return { status: "idle", modelIterations: 0 };
    },
  );
  try {
    await f.store.startTurn({ sessionId: "supervised", userText: "Continue", fullPermissions: false });
    await f.wait(() => seen.length === 1);
    f.store.setSessionSource("supervised", "coco");
    before.resolve();
    await f.wait(() => seen.length === 2);
    assert.deepEqual(f.store.reclaimCocoSession("supervised"), { ok: true });
    during.resolve();
    await f.wait(() => seen.length === 3);
    after.resolve();
    await f.wait(() => !f.store.isTurnActive("supervised"));
    assert.deepEqual(seen, [
      { full: false, review: false },
      { full: true, review: true },
      { full: false, review: false },
    ], "the in-flight turn follows hand-over and take-back");
    assert.equal(entered, 1);
  } finally { before.resolve(); during.resolve(); after.resolve(); await f.close(); }
});

test("fatal approvals skip the decide model and park on the CoCo Chat card", { timeout: 20000 }, async () => {
  const gate = deferred<void>();
  let decision: boolean | undefined;
  const f = await fixture(
    messages => latestUser(messages).includes("wants to run") ? '{"action":"answer","answer":"Approve"}' : "unused",
    async input => {
      if (input.session.id !== "supervised") { input.session.status = "idle"; return { status: "idle", modelIterations: 0 }; }
      await gate.promise;
      decision = await input.gate.requestConfirmation({ toolName: "run_shell", arguments: { command: "diskutil eraseDisk APFS X disk4" }, risk: { fatal: true, reason: "diskutil erase destroys the target disk.", trashRewrite: false }, source: "shell_risk" });
      input.session.status = "idle";
      return { status: "idle", modelIterations: 0 };
    },
  );
  try {
    f.coco.engine.command({ type: "chat", text: "Hi CoCo" });
    await f.wait(() => Boolean(f.coco.engine.snapshot().chat?.sessionId));
    await f.store.startTurn({ sessionId: "supervised", userText: "Continue", fullPermissions: false });
    f.store.setSessionSource("supervised", "coco");
    gate.resolve();
    await f.wait(() => f.coco.engine.snapshot().chat?.approval?.onBehalfOf === "Supervised session");
    assert.equal(f.requests.filter(messages => latestUser(messages).includes("wants to run")).length, 0, "the decide model never sees a fatal call");
    const requestId = f.coco.engine.snapshot().chat?.approval?.requestId;
    assert.ok(requestId);
    f.coco.engine.command({ type: "chatControl", action: "approval", requestId, approved: false });
    await f.wait(() => !f.store.isTurnActive("supervised"));
    assert.equal(decision, false, "the user's verdict settles it");
  } finally { gate.resolve(); await f.close(); }
});

test("the D-3 pending window keeps asks on the user until the wake job starts", { timeout: 20000 }, async () => {
  let releaseHold!: () => void;
  const hold = new Promise<void>(resolve => { releaseHold = resolve; });
  const gate = deferred<void>();
  let entered = 0;
  let answered: { selected?: string } | undefined;
  const f = await fixture(
    messages => latestUser(messages).includes("Reuse existing code?") ? '{"action":"answer","answer":"Reuse the existing parser"}' : "unused",
    async input => {
      if (input.session.id !== "supervised") {
        // CoCo Chat lane turn: parks the conversation lane until released,
        // keeping the hand-over wake job queued behind it.
        await hold;
        input.session.status = "idle";
        return { status: "idle", modelIterations: 0 };
      }
      entered += 1;
      await gate.promise;
      answered = (await input.gate.requestUserAsk({ toolCallId: "q", question: "Reuse existing code?", options: ["Reuse the existing parser", "Add a new parser"], allowCustom: false })) ?? undefined;
      input.session.status = "idle";
      return { status: "idle", modelIterations: 0 };
    },
  );
  try {
    f.coco.engine.command({ type: "chat", text: "Hold the lane." });
    await f.wait(() => Boolean(f.coco.engine.snapshot().chatJob));
    assert.deepEqual(f.coco.handoverSession("supervised"), { ok: true });
    // Pending window: the wake job is still queued — the ask reaches the user.
    await f.store.startTurn({ sessionId: "supervised", userText: "Continue", fullPermissions: false });
    await f.wait(() => entered === 1);
    gate.resolve();
    await f.wait(() => f.store.listPendingUserAsks("supervised").length === 1);
    const pending = f.store.listPendingUserAsks("supervised")[0]!;
    f.store.respondUserAsk({ requestId: pending.requestId, selections: ["Add a new parser"] });
    await f.wait(() => !f.store.isTurnActive("supervised"));
    // Wake job runs → supervision activates; the next ask is CoCo's to answer.
    releaseHold();
    await f.wait(() => !f.coco.handoverPending("supervised"));
    await f.store.startTurn({ sessionId: "supervised", userText: "Continue again", fullPermissions: false });
    await f.wait(() => entered === 2);
    await f.wait(() => !f.store.isTurnActive("supervised"));
    assert.equal((answered as { selected: string })?.selected, "Reuse the existing parser", "CoCo answers after the wake job started");
    assert.equal(f.store.listPendingUserAsks("supervised").length, 0);
  } finally { gate.resolve(); releaseHold(); await f.close(); }
});

test("plain sessions keep the ask on the user", { timeout: 20000 }, async () => {
  const gate = deferred<void>();
  let entered = 0;
  const f = await fixture(
    () => '{"action":"answer","answer":"should never be asked"}',
    async input => {
      entered += 1;
      await gate.promise;
      await input.gate.requestUserAsk({ toolCallId: "q", question: "Reuse existing code?", options: ["Reuse the existing parser"], allowCustom: false });
      input.session.status = "idle";
      return { status: "idle", modelIterations: 0 };
    },
  );
  try {
    await f.store.startTurn({ sessionId: "supervised", userText: "Continue", fullPermissions: false });
    await f.wait(() => entered === 1);
    gate.resolve();
    await f.wait(() => f.store.listPendingUserAsks("supervised").length === 1);
    const decideRequests = f.requests.filter(messages => latestUser(messages).includes("Reuse existing code?"));
    assert.equal(decideRequests.length, 0, "the decide model is never consulted without the hand-over marker");
    const pending = f.store.listPendingUserAsks("supervised")[0]!;
    f.store.respondUserAsk({ requestId: pending.requestId, selections: ["Reuse the existing parser"] });
    await f.wait(() => !f.store.isTurnActive("supervised"));
  } finally { gate.resolve(); await f.close(); }
});

test("needs_user tool approvals park on the CoCo Chat card", { timeout: 20000 }, async () => {
  const gate = deferred<void>();
  let entered = 0;
  let decision: boolean | undefined;
  const f = await fixture(
    messages => latestUser(messages).includes("wants to run") ? '{"action":"needs_user","reason":"Destructive command"}' : "unused",
    async input => {
      if (input.session.id !== "supervised") { input.session.status = "idle"; return { status: "idle", modelIterations: 0 }; }
      entered += 1;
      await gate.promise;
      decision = await input.gate.requestConfirmation({ toolName: "shell", arguments: { command: "rm -rf /tmp/junk" } });
      input.session.status = "idle";
      return { status: "idle", modelIterations: 0 };
    },
  );
  try {
    f.coco.engine.command({ type: "chat", text: "Hi CoCo" });
    await f.wait(() => Boolean(f.coco.engine.snapshot().chat?.sessionId));
    await f.store.startTurn({ sessionId: "supervised", userText: "Continue", fullPermissions: false });
    await f.wait(() => entered === 1);
    f.store.setSessionSource("supervised", "coco");
    gate.resolve();
    await f.wait(() => f.coco.engine.snapshot().chat?.approval?.onBehalfOf === "Supervised session");
    const requestId = f.coco.engine.snapshot().chat?.approval?.requestId;
    assert.ok(requestId);
    f.coco.engine.command({ type: "chatControl", action: "approval", requestId, approved: true });
    await f.wait(() => !f.store.isTurnActive("supervised"));
    assert.equal(decision, true);
    assert.equal(f.store.listCocoParkedRequests().length, 0);
  } finally { gate.resolve(); await f.close(); }
});

test("take-back mid-decision voids CoCo's answer and hands the ask to the user", { timeout: 20000 }, async () => {
  const gate = deferred<void>();
  let releaseDecide!: () => void;
  const decideHold = new Promise<void>(resolve => { releaseDecide = resolve; });
  let entered = 0;
  let answered: { selected?: string } | undefined;
  const f = await fixture(
    messages => latestUser(messages).includes("Reuse existing code?") ? { partial: '{"action":"answer","answer":"Reuse the existing parser"}', hold: decideHold } : "unused",
    async input => {
      entered += 1;
      await gate.promise;
      answered = (await input.gate.requestUserAsk({ toolCallId: "q", question: "Reuse existing code?", options: ["Reuse the existing parser", "Add a new parser"], allowCustom: false })) ?? undefined;
      input.session.status = "idle";
      return { status: "idle", modelIterations: 0 };
    },
  );
  try {
    await f.store.startTurn({ sessionId: "supervised", userText: "Continue", fullPermissions: false });
    await f.wait(() => entered === 1);
    assert.equal(f.store.setSessionSource("supervised", "coco"), true);
    gate.resolve();
    // CoCo's decide model is still deliberating (held) when the user takes back.
    await f.wait(() => f.requests.some(messages => latestUser(messages).includes("Reuse existing code?")));
    assert.deepEqual(f.store.reclaimCocoSession("supervised"), { ok: true });
    releaseDecide();
    // Let the late verdict arrive: it must be voided, not settled.
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(answered, undefined, "CoCo's late answer never resolves the ask");
    assert.equal(f.store.listCocoParkedRequests().length, 0);
    const pending = f.store.listPendingUserAsks("supervised")[0]!;
    assert.ok(pending, "the ask is back on the user");
    assert.equal(f.store.respondUserAsk({ requestId: pending.requestId, selections: ["Add a new parser"] }), true);
    await f.wait(() => !f.store.isTurnActive("supervised"));
    assert.equal((answered as unknown as { selected?: string })?.selected, "Add a new parser", "the user's answer wins");
  } finally { gate.resolve(); releaseDecide(); await f.close(); }
});

test("take-back unparks a needs_user question back to the user", { timeout: 20000 }, async () => {
  const gate = deferred<void>();
  let entered = 0;
  let answered: { selected?: string } | undefined;
  const f = await fixture(
    messages => latestUser(messages).includes("Reuse existing code?") ? '{"action":"needs_user","reason":"Goal-changing decision"}' : "unused",
    async input => {
      if (input.session.id !== "supervised") { input.session.status = "idle"; return { status: "idle", modelIterations: 0 }; }
      entered += 1;
      await gate.promise;
      answered = (await input.gate.requestUserAsk({ toolCallId: "q", question: "Reuse existing code?", options: ["Reuse the existing parser", "Add a new parser"], allowCustom: false })) ?? undefined;
      input.session.status = "idle";
      return { status: "idle", modelIterations: 0 };
    },
  );
  try {
    f.coco.engine.command({ type: "chat", text: "Hi CoCo" });
    await f.wait(() => Boolean(f.coco.engine.snapshot().chat?.sessionId));
    await f.store.startTurn({ sessionId: "supervised", userText: "Continue", fullPermissions: false });
    await f.wait(() => entered === 1);
    f.store.setSessionSource("supervised", "coco");
    gate.resolve();
    await f.wait(() => f.coco.engine.snapshot().chat?.question?.onBehalfOf === "Supervised session");
    // Take back: the parked card dissolves and the ask returns to the user.
    assert.deepEqual(f.store.reclaimCocoSession("supervised"), { ok: true });
    await f.wait(() => f.coco.engine.snapshot().chat?.question === undefined);
    assert.equal(f.store.listCocoParkedRequests().length, 0);
    const pending = f.store.listPendingUserAsks("supervised")[0]!;
    assert.ok(pending, "the ask stays open for the user");
    assert.equal(f.store.respondUserAsk({ requestId: pending.requestId, selections: ["Add a new parser"] }), true);
    await f.wait(() => !f.store.isTurnActive("supervised"));
    assert.equal((answered as { selected: string })?.selected, "Add a new parser");
  } finally { gate.resolve(); await f.close(); }
});
