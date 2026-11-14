import { registerCocoExecution } from "../coco/executionAccess.js";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { after, describe, it } from "node:test";
import type { RunAgentTurnInput } from "../agent/types.js";
import { runAgentTurn as runRealAgentTurn } from "../agent/runAgentTurn.js";
import { NodeActionPrepareRole } from "../agent/fsm/actions/NodeActionPrepareRole.js";
import { makeFakeHost, makeScope } from "../agent/fsm/graphScenariosFixtures.js";
import { configureFsmGraphsRoot } from "../agent/fsm/graphLibrary/manager.js";
import { configureCredentialsRoot, configureLegacyKeyBridgeForTests } from "../llm/credentials.js";
import { configureUserMemoryRoot } from "../memory/store.js";
import { openSessionDb, upsertSession, loadSessionMessages } from "../session/db/index.js";
import type { Session } from "../session/types.js";
import { ToolReturnCode } from "../session/returnCodes.js";
import { upsertTool, unregisterTool } from "../tools/registry.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import type { WorkspaceSettings } from "../settings/types.js";
import { addAgentStreamSink, removeAgentStreamSink, createSessionStore, type SessionStore, type SessionStoreDependencies } from "./sessionRuntime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const stores: SessionStore[] = [];
after(() => { for (const store of stores) store.memorySync.stop(); });

function fixture(overrides: SessionStoreDependencies = {}, useRealClient = false) {
  const root = mkdtempSync(join(tmpdir(), "jellybot-turn-lifecycle-"));
  configureUserMemoryRoot(root);
  configureCredentialsRoot(root);
  configureLegacyKeyBridgeForTests(null);
  configureFsmGraphsRoot(join(root, "graphs"));
  configurePromptDefaults(join(process.cwd(), "resources", "prompts"));
  const settings: WorkspaceSettings = {
    providers: [
      { id: "p1", name: "One", baseUrl: "http://127.0.0.1:9/raw-chat", modelId: "m1", rawEndpoint: true },
      { id: "p2", name: "Two", baseUrl: "http://127.0.0.1:9/other", modelId: "m2" },
    ],
    activeProviderId: "p1", composerRunMode: "agent", llmRequestTimeoutMs: 47_000,
    userMemoryAutoExtract: false, projectMemoryAutoExtract: false,
  };
  const writeSettings = () => writeFileSync(join(root, "settings.json"), JSON.stringify(settings));
  writeSettings();
  const session: Session = {
    id: "session", type: "agent", title: "Lifecycle", createdAt: 1, updatedAt: 1,
    status: "idle", progressText: "", messages: [], model: "m1", providerId: "p1",
    workspaceId: "ws", workspacePath: root, pinned: false, archived: false,
    archivedAt: null, contextUsage: { usedTokens: 0 }, plan: null,
  };
  const db = openSessionDb(root);
  upsertSession(db, session);
  db.close();
  const client = {
    baseUrl: settings.providers[0]!.baseUrl, apiKey: "local", model: "m1",
    providerId: "p1", rawEndpoint: true, requestTimeoutMs: 47_000,
  };
  const calls: RunAgentTurnInput[] = [];
  const entered = deferred<RunAgentTurnInput>();
  const store = createSessionStore(root, {
    startBackgroundServices: false,
    ...(useRealClient ? {} : { resolveClient: async () => ({ ...client }) }),
    readSettings: async () => settings,
    runAgentTurn: async (input) => {
      calls.push(input);
      entered.resolve(input);
      input.session.status = "idle";
      return { status: "idle", modelIterations: 0 };
    },
    ...overrides,
  });
  stores.push(store);
  const request = { sessionId: session.id, userText: "Continue", fullPermissions: false };
  return { root, store, settings, writeSettings, client, calls, entered, request };
}

async function flushTurn() { await nextTick(); await nextTick(); }

describe("session runtime turn ownership", () => {
  it("claims the slot before resolving a client and rejects a concurrent start", async () => {
    const resolving = deferred<Awaited<ReturnType<NonNullable<SessionStoreDependencies["resolveClient"]>>>>();
    const fixtureData = fixture({ resolveClient: () => resolving.promise });
    const first = fixtureData.store.startTurn(fixtureData.request);
    await assert.rejects(fixtureData.store.startTurn(fixtureData.request), /running turn/);
    assert.deepEqual(await fixtureData.store.clearSession("session"), { ok: false, reason: "running" });
    assert.equal(fixtureData.store.deleteSession("session"), false);
    resolving.resolve(fixtureData.client);
    await first;
    await fixtureData.entered.promise;
    await flushTurn();
    assert.equal(fixtureData.calls.length, 1);
    assert.equal((await fixtureData.store.clearSession("session")).ok, true);
  });

  it("releases a failed client setup so a subsequent turn can start", async () => {
    let attempts = 0;
    const fixtureData = fixture({ resolveClient: async () => {
      if (++attempts === 1) throw new Error("client setup failed");
      return { baseUrl: "http://127.0.0.1:9", apiKey: "local", model: "m1", providerId: "p1" };
    } });
    await assert.rejects(fixtureData.store.startTurn(fixtureData.request), /client setup failed/);
    await fixtureData.store.startTurn(fixtureData.request);
    await fixtureData.entered.promise;
    await flushTurn();
    assert.equal(fixtureData.calls.length, 1);
  });

  it("releases settings and graph setup failures instead of leaving an occupied slot", async () => {
    let failSettings = true;
    const fixtureData = fixture({ readSettings: async () => {
      if (failSettings) throw new Error("settings setup failed");
      return fixtureData.settings;
    } });
    await assert.rejects(fixtureData.store.startTurn(fixtureData.request), /settings setup failed/);
    failSettings = false;
    fixtureData.store.getSession("session")!.composerRunMode = "custom";
    await assert.rejects(fixtureData.store.startTurn(fixtureData.request), /requires a saved FSM graph/);
    fixtureData.store.getSession("session")!.composerRunMode = "agent";
    await fixtureData.store.startTurn(fixtureData.request);
    await fixtureData.entered.promise;
    await flushTurn();
    assert.equal(fixtureData.calls.length, 1);
  });

  it("honors Stop during client setup without starting a model or losing the prompt", async () => {
    const resolving = deferred<Awaited<ReturnType<NonNullable<SessionStoreDependencies["resolveClient"]>>>>();
    const fixtureData = fixture({ resolveClient: () => resolving.promise });
    const first = fixtureData.store.startTurn(fixtureData.request);
    assert.equal(fixtureData.store.cancelTurn("session"), true);
    resolving.resolve(fixtureData.client);
    await first;
    assert.equal(fixtureData.calls.length, 0);
    assert.equal(fixtureData.store.getSession("session")!.status, "cancelled");
    assert.equal(fixtureData.store.takePromptRestore("session")!.text, "Continue");
    assert.equal((await fixtureData.store.clearSession("session")).ok, true);
  });

  it("reports a claimed turn as running before the runner starts", async () => {
    const release = deferred<void>();
    const entered = deferred<void>();
    const fixtureData = fixture({ runAgentTurn: async (input) => {
      entered.resolve(undefined);
      await release.promise;
      input.session.status = "idle";
      return { status: "idle", modelIterations: 0 };
    } });
    await fixtureData.store.startTurn(fixtureData.request);
    // The claim broadcast must not repeat the previous turn's idle status.
    assert.equal(fixtureData.store.getSession("session")!.status, "running");
    await entered.promise;
    release.resolve(undefined);
    await flushTurn();
    assert.equal(fixtureData.store.getSession("session")!.status, "idle");
  });

  it("keeps a late successful runner completion cancelled after Stop", async () => {
    const running = deferred<void>();
    const entered = deferred<void>();
    const fixtureData = fixture({ runAgentTurn: async (input) => {
      entered.resolve(undefined);
      await running.promise;
      input.session.status = "idle";
      return { status: "idle", modelIterations: 0 };
    } });
    await fixtureData.store.startTurn(fixtureData.request);
    await entered.promise;
    assert.equal(fixtureData.store.cancelTurn("session"), true);
    running.resolve(undefined);
    await flushTurn();
    assert.equal(fixtureData.store.getSession("session")!.status, "cancelled");
    assert.equal(fixtureData.store.takePromptRestore("session")!.text, "Continue");
    assert.equal((await fixtureData.store.clearSession("session")).ok, true);
  });

  for (const phase of ["model", "tool"] as const) for (const action of ["enqueue", "promote"] as const) {
    it(`${action} arms a prompt without aborting active ${phase} work and applies it at a natural boundary`, async () => {
      const active = deferred<void>();
      const release = deferred<void>();
      const finished = deferred<void>();
      const bodies: Array<Record<string, unknown>> = [];
      let modelSignal: AbortSignal | null | undefined;
      let toolSignal: AbortSignal | undefined;
      let effects = 0;
      const toolName = "runtime_boundary_counter";
      upsertTool({ name: toolName, description: "In-memory boundary counter", parameters: { type: "object", properties: {} }, defaultPermissionLevel: 0 }, async (_args, context) => {
        effects += 1;
        toolSignal = context.signal;
        active.resolve(undefined);
        await release.promise;
        assert.equal(toolSignal?.aborted, false);
        return { returnCode: ToolReturnCode.Success, content: [{ type: "text", text: "current tool finished" }] };
      });
      const fixtureData = fixture({
        resolveClient: async () => ({ baseUrl: "https://mock.example/v1/responses", apiKey: "mock-key", model: "m1", providerId: "p1", apiProtocol: "responses", responsesTools: [] }),
        runAgentTurn: async (input) => {
          try { return await runRealAgentTurn({ ...input, unlimitedTurnBudgets: true }); }
          finally { finished.resolve(undefined); }
        },
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (_url, init) => {
        assert.equal(init?.method, "POST");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        modelSignal = init?.signal;
        const id = `resp_boundary_${bodies.length}`;
        if (bodies.length === 1 && phase === "model") {
          active.resolve(undefined);
          await release.promise;
          assert.equal(modelSignal?.aborted, false);
        }
        if (bodies.length === 2) {
          assert.match(JSON.stringify(body.input), /New direction after this step/);
          if (phase === "tool") assert.match(JSON.stringify(body.input), /current tool finished/);
        }
        assert.ok(bodies.length <= 2, "the queued insertion stays in the same turn");
        const output = bodies.length === 1 && phase === "tool"
          ? [{ type: "function_call", id: "fc_boundary", call_id: "call_boundary", name: toolName, arguments: "{}", status: "completed" }]
          : [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: bodies.length === 1 ? "Current response finished" : "New direction handled" }] }];
        const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
        return new Response(frame({ type: "response.created", response: { id, status: "in_progress", store: true } })
          + frame({ type: "response.completed", response: { id, status: "completed", store: true, output } }), { headers: { "Content-Type": "text/event-stream" } });
      };
      try {
        fixtureData.store.getSession("session")!.messages.push({ id: "earlier-boundary-answer", role: "assistant", createdAt: 1,
          parts: [{ type: "text", text: "An earlier turn is already complete." }] });
        await fixtureData.store.startTurn({ ...fixtureData.request, fullPermissions: true });
        await active.promise;
        const queued = fixtureData.store.enqueuePrompt({ sessionId: "session", userText: "New direction after this step", attachments: [], mode: action === "enqueue" ? "interrupt" : "deferred" });
        if (action === "promote") assert.equal(fixtureData.store.promoteQueuedPrompt("session", queued.queued.id).ok, true);
        assert.equal(fixtureData.store.listPromptQueue("session")[0]!.mode, "interrupt");
        await nextTick();
        assert.equal(modelSignal?.aborted, false, "arming must keep the current model request alive");
        if (phase === "tool") assert.equal(toolSignal?.aborted, false, "arming must keep the running tool alive");
        assert.equal(bodies.length, 1);
        release.resolve(undefined);
        await finished.promise;
        await flushTurn();
        assert.equal(fixtureData.store.getSession("session")!.status, "idle");
        assert.equal(bodies.length, 2);
        assert.equal(effects, phase === "tool" ? 1 : 0);
        assert.deepEqual(fixtureData.store.listPromptQueue("session"), []);
        const prompts = fixtureData.store.getSession("session")!.messages.filter((message) => message.role === "user");
        assert.equal(prompts.length, 2);
      } finally {
        release.resolve(undefined);
        globalThis.fetch = originalFetch;
        unregisterTool(toolName);
      }
    });
  }

  it("does not commit an awaited provider change after another turn has claimed the session", async () => {
    const read = deferred<WorkspaceSettings>();
    let holdSettings = true;
    const running = deferred<void>();
    const entered = deferred<void>();
    const fixtureData = fixture({
      readSettings: async () => { if (holdSettings) { holdSettings = false; return read.promise; } return fixtureData.settings; },
      runAgentTurn: async (input) => { entered.resolve(undefined); await running.promise; input.session.status = "idle"; return { status: "idle", modelIterations: 0 }; },
    });
    const changing = fixtureData.store.setSessionProvider("session", "p2");
    await fixtureData.store.startTurn(fixtureData.request);
    await entered.promise;
    read.resolve(fixtureData.settings);
    await assert.rejects(changing, /turn is running/);
    assert.equal(fixtureData.store.getSession("session")!.providerId, "p1");
    running.resolve(undefined);
    await flushTurn();
  });

  it("does not commit an awaited provider change while compaction owns the session", async () => {
    const read = deferred<WorkspaceSettings>();
    const resolving = deferred<Awaited<ReturnType<NonNullable<SessionStoreDependencies["resolveClient"]>>>>();
    let holdSettings = true;
    const fixtureData = fixture({
      readSettings: async () => { if (holdSettings) { holdSettings = false; return read.promise; } return fixtureData.settings; },
      resolveClient: () => resolving.promise,
    });
    const changing = fixtureData.store.setSessionProvider("session", "p2");
    const compacting = fixtureData.store.compactSession("session");
    read.resolve(fixtureData.settings);
    await assert.rejects(changing, /compacting/);
    resolving.resolve(fixtureData.client);
    await compacting;
    assert.equal(fixtureData.store.getSession("session")!.providerId, "p1");
  });

  it("does not persist an awaited provider change after the session was deleted", async () => {
    const read = deferred<WorkspaceSettings>();
    const fixtureData = fixture({ readSettings: () => read.promise });
    const changing = fixtureData.store.setSessionProvider("session", "p2");
    assert.equal(fixtureData.store.deleteSession("session"), true);
    read.resolve(fixtureData.settings);
    await assert.rejects(changing, /Unknown session/);
    assert.equal(fixtureData.store.getSession("session"), null);
  });

  it("does not reassign an active turn's provider metadata when its profile is removed", async () => {
    const running = deferred<void>();
    const entered = deferred<void>();
    const fixtureData = fixture({ runAgentTurn: async (input) => {
      entered.resolve(undefined); await running.promise;
      input.session.status = "idle"; return { status: "idle", modelIterations: 0 };
    } });
    await fixtureData.store.startTurn(fixtureData.request);
    await entered.promise;
    fixtureData.settings.providers = fixtureData.settings.providers.filter((provider) => provider.id !== "p1");
    fixtureData.settings.activeProviderId = "p2";
    await fixtureData.store.reassignSessionsUsingProvider("p1");
    assert.equal(fixtureData.store.getSession("session")!.providerId, "p1");
    running.resolve(undefined);
    await flushTurn();
    await fixtureData.store.reassignSessionsUsingProvider("p1");
    assert.equal(fixtureData.store.getSession("session")!.providerId, "p2");
  });

  it("resolves a removed session profile to the current default on the next turn", async () => {
    const fixtureData = fixture({}, true);
    fixtureData.settings.providers = fixtureData.settings.providers.filter((provider) => provider.id !== "p1");
    fixtureData.settings.activeProviderId = "p2";
    fixtureData.writeSettings();
    await fixtureData.store.startTurn(fixtureData.request);
    const input = await fixtureData.entered.promise;
    assert.equal(input.client.model, "m2");
    assert.equal(fixtureData.store.getSession("session")!.providerId, "p2");
    await flushTurn();
  });

  it("resolves another provider's complete Responses configuration for an explicit FSM role override", async () => {
    const fixtureData = fixture({}, true);
    const nativeTools = [
      { type: "web_search", filters: { allowed_domains: ["example.com"] } },
      { type: "code_interpreter", container: { type: "auto", file_ids: ["file-existing"] } },
      { type: "mcp", server_label: "research", server_url: "https://mcp.example" },
    ];
    fixtureData.settings.providers[1] = {
      id: "p2", name: "Responses role", baseUrl: "http://127.0.0.1:9/custom/native/?tenant=two/",
      modelId: "m2", rawEndpoint: true, apiProtocol: "responses", responsesTools: nativeTools,
      responsesStateful: false,
    };
    fixtureData.writeSettings();
    await fixtureData.store.startTurn(fixtureData.request);
    const input = await fixtureData.entered.promise;
    assert.equal(input.client.model, "m1");
    const alternate = input.llmBundle!.byProviderId.p2!;
    assert.ok(alternate, "a configured provider must be available to PrepareRole even when it is not the session default");
    assert.equal(alternate.client.baseUrl, fixtureData.settings.providers[1]!.baseUrl);
    assert.equal(alternate.client.model, "m2");
    assert.equal(alternate.client.apiProtocol, "responses");
    assert.equal(alternate.client.rawEndpoint, true);
    assert.equal(alternate.client.responsesStateful, false);
    assert.equal(alternate.client.requestTimeoutMs, 47_000);
    assert.deepEqual(alternate.client.responsesTools, nativeTools);
    assert.notEqual(alternate.client.responsesTools, nativeTools, "normalization must not share mutable settings arrays");

    const scope = makeScope(input.session, "agent");
    scope.llmBundle = input.llmBundle!;
    const { host } = makeFakeHost({ session: input.session, rounds: [] });
    const result = await new NodeActionPrepareRole({ roleKind: "researcher", modelProviderId: "p2" })
      .Exec({ host, turnContext: { turnScope: scope }, nodeContext: {} });
    assert.equal(result.status, "continue");
    assert.equal(result.nodeContextPatch!.activeLlm, alternate);
    assert.equal(scope.turnState.activeRole, "researcher");
    assert.equal(scope.llmBundle.sessionDefault.client.model, "m1");
    assert.deepEqual(alternate.client.responsesTools, nativeTools);
    await flushTurn();
  });

  for (const method of ["compactSession", "endSession"] as const) {
    it(`${method} keeps the full raw endpoint client for its summary request`, async () => {
      const fixtureData = fixture();
      fixtureData.settings.contextLimitTokens = 1_000;
      fixtureData.settings.iterationProtectRawIterationCount = 1;
      fixtureData.settings.iterationProtectTokenRatio = 0.001;
      const session = fixtureData.store.getSession("session")!;
      session.messages.push(
        { id: "prompt", role: "user", createdAt: 2, parts: [{ type: "text", text: "Review the system." }] },
        { id: "answer", role: "assistant", createdAt: 3, parts: [{ type: "text", text: "The review is complete." }] },
        { id: "recent-prompt", role: "user", createdAt: 4, parts: [{ type: "text", text: "Review another change." }] },
        { id: "recent-answer", role: "assistant", createdAt: 5, parts: [{ type: "text", text: "The latest change is correct." }] },
      );
      const urls: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input) => {
        urls.push(String(input));
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: "## Active Task\nReview complete." } }] });
      };
      try {
        const result = await fixtureData.store[method]("session");
        assert.equal(result.ok, true);
        assert.equal(result.compacted, true);
        assert.deepEqual(urls, [fixtureData.client.baseUrl]);
      } finally { globalThis.fetch = originalFetch; }
    });
  }

  it("keeps the complete client and supplies a strict checkpoint only to the owning turn", async () => {
    const running = deferred<void>();
    const entered = deferred<RunAgentTurnInput>();
    const fixtureData = fixture({ runAgentTurn: async (input) => {
      entered.resolve(input); await running.promise;
      input.session.status = "idle"; return { status: "idle", modelIterations: 0 };
    } });
    await fixtureData.store.startTurn(fixtureData.request);
    const input = await entered.promise;
    assert.equal(input.client.rawEndpoint, true);
    assert.equal(input.client.requestTimeoutMs, 47_000);
    input.session.messages.push({ id: "durable", role: "assistant", createdAt: 2, parts: [{ type: "text", text: "Saved before execution" }] });
    await input.checkpoint!();
    const db = openSessionDb(fixtureData.root);
    assert.equal(loadSessionMessages(db, "session")[0]!.id, "durable");
    db.exec("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'checkpoint failure'); END");
    assert.throws(() => input.checkpoint!(), /checkpoint failure/);
    db.exec("DROP TRIGGER fail_checkpoint");
    db.close();
    running.resolve(undefined);
    await flushTurn();
    assert.throws(() => input.checkpoint!(), /superseded turn/);
    const staleEvents: unknown[] = [];
    const sink = (payload: { sessionId: string; event: unknown }) => { staleEvents.push(payload.event); };
    addAgentStreamSink(sink);
    try {
      input.onEvent!({ type: "progress", text: "Late event from an old turn" });
      assert.deepEqual(staleEvents, [], "a completed turn cannot emit into the next UI state");
    } finally { removeAgentStreamSink(sink); }
  });
});


describe("Coco supervision of ordinary project sessions", () => {
  async function waitFor(predicate: () => boolean) { for (let i=0;i<100 && !predicate();i++) await new Promise(resolve => setTimeout(resolve,5)); assert.ok(predicate()); }
  function accessFor(store: SessionStore, abort: AbortController, budget = () => true) {
    return registerCocoExecution({ workspaceId: "ws", canStartTurn: budget, signal: abort.signal,
      stream: async function* () {}, summarize: async () => ({ content: "" }),
      assertTool: () => {}, assertPath: () => {},
      ask: async () => ({ selected: "Reuse existing code", custom: true }),
      confirm: async () => false, beforeToolExecute: () => {},
    });
  }
  for (const mode of ["interrupt", "deferred"] as const) it(`reuses an active ordinary session with ${mode} without interrupting its request`, async () => {
    const release = deferred<void>(); let runs = 0;
    const f = fixture({ runAgentTurn: async input => {
      input.session.status = "running";
      if (++runs === 1) {
        await release.promise;
        assert.equal(input.signal?.aborted, false);
        if (mode === "interrupt") {
          const additions = input.takePendingSteer?.();
          assert.equal(additions?.length, 1);
          assert.match(JSON.stringify(additions), /Coco revised requirement/);
        }
      } else assert.equal(input.gate.fullPermissionsEnabled, true, "the appended Coco turn inherits Full permissions");
      input.session.status = "idle"; return { status: "idle", modelIterations: 0 };
    } });
    const abort = new AbortController(), access = accessFor(f.store, abort);
    let unsupervise: (() => void) | undefined;
    try {
      await f.store.startTurn(f.request); await waitFor(() => runs > 0);
      unsupervise = f.store.superviseCocoSession("session", access.id);
      const queued = f.store.enqueueCocoPrompt({ sessionId: "session", userText: "Coco revised requirement", mode }, access.id);
      assert.ok(!JSON.stringify(queued).includes(access.id), "trusted tokens are never exposed in queue payloads");
      assert.equal(f.store.isTurnActive("session"), true);
      release.resolve(); await waitFor(() => !f.store.isTurnActive("session"));
      assert.equal(runs, mode === "interrupt" ? 1 : 2);
      assert.equal(f.store.hasCocoPrompts(access.id), false);
      assert.equal(f.store.listSessions().length, 1);
    } finally { release.resolve(); unsupervise?.(); access.release(); }
  });
  it("revocation removes Coco additions and leaves an existing user turn alive", async () => {
    const release = deferred<void>(); let userSignal: AbortSignal | undefined, runs = 0;
    const f = fixture({ runAgentTurn: async input => { runs++; userSignal = input.signal; await release.promise; input.session.status = "idle"; return { status: "idle", modelIterations: 0 }; } });
    const abort = new AbortController(), access = accessFor(f.store, abort);
    try {
      await f.store.startTurn(f.request); await waitFor(() => runs > 0);
      f.store.enqueueCocoPrompt({ sessionId: "session", userText: "Coco follow-up", mode: "deferred" }, access.id);
      abort.abort(); f.store.clearCocoPrompts(access.id);
      assert.equal(userSignal?.aborted, false);
      assert.equal(f.store.listPromptQueue("session").length, 0);
      release.resolve(); await waitFor(() => !f.store.isTurnActive("session")); assert.equal(runs, 1);
    } finally { release.resolve(); access.release(); }
  });
  it("a deferred Coco prompt does not start a new turn after its budget is exhausted", async () => {
    const release = deferred<void>(); let runs = 0;
    const f = fixture({ runAgentTurn: async input => { runs++; await release.promise; input.session.status = "idle"; return { status: "idle", modelIterations: 0 }; } });
    const abort = new AbortController(), access = accessFor(f.store, abort, () => false);
    try {
      await f.store.startTurn(f.request); await waitFor(() => runs > 0);
      f.store.enqueueCocoPrompt({ sessionId: "session", userText: "After cooldown", mode: "deferred" }, access.id);
      release.resolve(); await waitFor(() => !f.store.isTurnActive("session"));
      assert.equal(runs, 1); assert.equal(f.store.hasCocoPrompts(access.id), true);
      const queued = f.store.listPromptQueue("session")[0]!; f.store.removeQueuedPrompt("session", queued.id);
      assert.equal(f.store.hasCocoPrompts(access.id), false, "removing a queued addition cannot leave Coco waiting forever");
      f.store.clearCocoPrompts(access.id);
    } finally { release.resolve(); access.release(); }
  });
  it("a Coco-owned turn without an explicit source still creates a 'coco' session", async () => {
    const f = fixture({ runAgentTurn: async input => { input.session.status = "idle"; return { status: "idle", modelIterations: 0 }; } });
    const abort = new AbortController();
    const workspace = await f.store.createWorkspace({ name: "CoCo lane", path: f.root });
    const access = registerCocoExecution({ workspaceId: workspace.id, canStartTurn: () => true, signal: abort.signal,
      stream: async function* () {}, summarize: async () => ({ content: "" }),
      assertTool: () => {}, assertPath: () => {}, beforeToolExecute: () => {} });
    try {
      const started = await f.store.startTurn({ workspaceId: workspace.id, userText: "Coco task", fullPermissions: true, cocoExecutionId: access.id });
      await waitFor(() => !f.store.isTurnActive(started.sessionId));
      assert.equal(f.store.getSession(started.sessionId)?.source, "coco", "the origin marker is inferred from the trusted execution access");
      const db = openSessionDb(f.root); try {
        const row = db.prepare("SELECT source FROM sessions WHERE id = ?").get(started.sessionId) as { source: string };
        assert.equal(row.source, "coco", "the inferred marker is persisted");
      } finally { db.close(); }
    } finally { access.release(); }
  });
  it("adopting a user 'app' session re-stamps it as CoCo-owned", async () => {
    const f = fixture({ runAgentTurn: async input => { input.session.status = "idle"; return { status: "idle", modelIterations: 0 }; } });
    const abort = new AbortController(), access = accessFor(f.store, abort);
    let unsupervise: (() => void) | undefined;
    try {
      assert.equal(f.store.getSession("session")?.source, undefined, "fixture session starts unmarked");
      unsupervise = f.store.superviseCocoSession("session", access.id);
      assert.equal(f.store.getSession("session")?.source, "coco", "supervision claims the origin marker immediately");
      const db = openSessionDb(f.root); try {
        const row = db.prepare("SELECT source FROM sessions WHERE id = 'session'").get() as { source: string };
        assert.equal(row.source, "coco", "the marker is persisted, not just in memory");
      } finally { db.close(); }
      // A second adoption path (direct Coco startTurn on the same session) stays idempotent.
      await f.store.startTurn({ sessionId: "session", userText: "Coco continues", fullPermissions: true, cocoExecutionId: access.id });
      await waitFor(() => !f.store.isTurnActive("session"));
      assert.equal(f.store.getSession("session")?.source, "coco");
    } finally { unsupervise?.(); access.release(); }
  });
  it("ordinary executor questions are answered by the attached Coco supervisor", async () => {
    const release = deferred<void>(); let answered: unknown, runs = 0;
    const f = fixture({ runAgentTurn: async input => { runs++; await release.promise; answered = await input.gate.requestUserAsk({ toolCallId: "question", question: "Reuse existing code?", options: [], allowCustom: true }); input.session.status = "idle"; return { status: "idle", modelIterations: 0 }; } });
    const abort = new AbortController(), access = accessFor(f.store, abort);
    let unsupervise: (() => void) | undefined;
    try {
      await f.store.startTurn(f.request); await waitFor(() => runs > 0);
      unsupervise = f.store.superviseCocoSession("session", access.id);
      release.resolve(); await waitFor(() => !f.store.isTurnActive("session"));
      assert.equal((answered as { selected: string }).selected, "Reuse existing code");
      assert.ok(!f.store.getSession("session")?.pendingUserAsk);
    } finally { release.resolve(); unsupervise?.(); access.release(); }
  });
});

describe("workspace deletion with hidden coco_internal sessions", () => {
  async function waitFor(predicate: () => boolean) { for (let i=0;i<100 && !predicate();i++) await new Promise(resolve => setTimeout(resolve,5)); assert.ok(predicate()); }
  it("stops the live background turn, hard-deletes internal sessions and removes the workspace row", async () => {
    let releaseTurn: (() => void) | undefined;
    const f = fixture({ runAgentTurn: async input => {
      input.session.status = "running";
      await new Promise<void>(resolve => {
        if (input.signal?.aborted) return resolve();
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
        releaseTurn = resolve;
      });
      input.session.status = "idle";
      return { status: "idle", modelIterations: 0 };
    } });
    const workspace = await f.store.createWorkspace({ name: "Internal only", path: f.root });
    const abort = new AbortController();
    const access = registerCocoExecution({ role: "background", workspaceId: workspace.id, canStartTurn: () => true, signal: abort.signal,
      stream: async function* () {}, summarize: async () => ({ content: "" }),
      assertTool: () => {}, assertPath: () => {}, beforeToolExecute: () => {} });
    try {
      const started = await f.store.startTurn({ workspaceId: workspace.id, userText: "Background check",
        fullPermissions: true, source: "coco_internal", runMode: "agent", cocoExecutionId: access.id });
      assert.equal(f.store.isTurnActive(started.sessionId), true);
      assert.equal(f.store.listSessions().filter(s => s.workspaceId === workspace.id).length, 0, "internal sessions are hidden from the list");

      assert.equal(await f.store.deleteWorkspace(workspace.id), true);

      const db = openSessionDb(f.root); try {
        const wsRows = db.prepare("SELECT count(*) n FROM workspaces WHERE id = ?").get(workspace.id) as { n: number };
        assert.equal(wsRows.n, 0, "workspace row removed even though only invisible internal sessions existed");
        const sessionRows = db.prepare("SELECT count(*) n FROM sessions WHERE workspace_id = ?").get(workspace.id) as { n: number };
        assert.equal(sessionRows.n, 0, "internal session row hard-deleted, not left orphaned");
      } finally { db.close(); }
      assert.equal(f.store.getSessionSummary(started.sessionId), null);
    } finally { releaseTurn?.(); access.release(); }
  });
  it("an idle internal-only workspace deletes without touching other workspaces", async () => {
    const f = fixture({ runAgentTurn: async input => { input.session.status = "idle"; return { status: "idle", modelIterations: 0 }; } });
    const workspace = await f.store.createWorkspace({ name: "Idle internal", path: f.root });
    const abort = new AbortController();
    const access = registerCocoExecution({ role: "background", workspaceId: workspace.id, canStartTurn: () => true, signal: abort.signal,
      stream: async function* () {}, summarize: async () => ({ content: "" }),
      assertTool: () => {}, assertPath: () => {}, beforeToolExecute: () => {} });
    try {
      const started = await f.store.startTurn({ workspaceId: workspace.id, userText: "Quick check",
        fullPermissions: true, source: "coco_internal", runMode: "agent", cocoExecutionId: access.id });
      await waitFor(() => !f.store.isTurnActive(started.sessionId));
      assert.equal(await f.store.deleteWorkspace(workspace.id), true);
      const db = openSessionDb(f.root); try {
        const wsRows = db.prepare("SELECT count(*) n FROM workspaces WHERE id = ?").get(workspace.id) as { n: number };
        assert.equal(wsRows.n, 0);
        const sessionRows = db.prepare("SELECT count(*) n FROM sessions WHERE workspace_id = ?").get(workspace.id) as { n: number };
        assert.equal(sessionRows.n, 0);
      } finally { db.close(); }
    } finally { access.release(); }
  });
});

describe("ask_user answer transport", () => {
  async function waitFor(predicate: () => boolean) {
    for (let i = 0; i < 100 && !predicate(); i++) await nextTick();
    assert.ok(predicate());
  }
  it("preserves option details in live and persisted asks and trims answer comments", async () => {
    let answer: unknown;
    const f = fixture({ runAgentTurn: async input => {
      answer = await input.gate.requestUserAsk({ toolCallId: "ask-details", question: "Which scope?",
        options: ["Preview", "Build"], optionDetails: [{ label: "Preview", description: "Review first", recommended: true }],
        allowCustom: true, allowMultiple: true });
      input.session.status = "idle";
      return { status: "idle", modelIterations: 0 };
    } });
    await f.store.startTurn(f.request);
    await waitFor(() => f.store.listPendingUserAsks("session").length === 1);
    const pending = f.store.listPendingUserAsks("session")[0]!;
    assert.deepEqual(pending.optionDetails, [{ label: "Preview", description: "Review first", recommended: true }]);
    assert.deepEqual(f.store.getSession("session")?.pendingUserAsk?.optionDetails, pending.optionDetails);
    assert.equal(f.store.respondUserAsk({ requestId: pending.requestId, selections: ["Build", "Preview"], comment: "  Keep drafts.\nNo deploy.  " }), true);
    await waitFor(() => !f.store.isTurnActive("session"));
    assert.deepEqual(answer, { selected: "Build, Preview", selections: ["Build", "Preview"], custom: false, comment: "Keep drafts.\nNo deploy." });
  });
});

describe("durable task interruption reasons",()=>{
  for(const reason of ["user_stopped","coco_stopped"] as const)it(`records ${reason} without relying on error text`,async()=>{
    const entered=deferred<RunAgentTurnInput>();
    const f=fixture({runAgentTurn:async input=>{input.session.status="running";entered.resolve(input);await new Promise<void>(resolve=>input.signal!.addEventListener("abort",()=>resolve(),{once:true}));input.session.status="cancelled";return {status:"cancelled",modelIterations:0};}});
    await f.store.startTurn(f.request);await entered.promise;
    f.store.cancelTurn("session",reason);
    for(let i=0;i<30&&f.store.isTurnActive("session");i++)await nextTick();
    const lifecycle=f.store.getTurnLifecycle("session");assert.equal(lifecycle?.state,reason);assert.equal(lifecycle?.requestedStop,reason);assert.ok(lifecycle?.endedAt);
  });
  it("records a graceful user pause before the next turn boundary",async()=>{
    const entered=deferred<void>(),release=deferred<void>();
    const f=fixture({runAgentTurn:async input=>{input.session.status="running";entered.resolve();await release.promise;assert.equal(input.takePauseRequested?.(),true);input.session.status="paused";return {status:"paused",modelIterations:0};}});
    await f.store.startTurn(f.request);await entered.promise;assert.equal(f.store.pauseTurn("session").ok,true);
    assert.equal(f.store.getTurnLifecycle("session")?.requestedStop,"user_paused");release.resolve();
    for(let i=0;i<30&&f.store.isTurnActive("session");i++)await nextTick();
    assert.equal(f.store.getTurnLifecycle("session")?.state,"user_paused");
  });
  it("records a CoCo budget soft-pause distinctly from a user pause",async()=>{
    const entered=deferred<void>(),release=deferred<void>();
    const f=fixture({runAgentTurn:async input=>{input.session.status="running";entered.resolve();await release.promise;assert.equal(input.takePauseRequested?.(),true);input.session.status="paused";return {status:"paused",modelIterations:0};}});
    await f.store.startTurn(f.request);await entered.promise;
    assert.equal(f.store.pauseTurn("session","coco_budget").ok,true);
    assert.equal(f.store.getTurnLifecycle("session")?.requestedStop,"coco_budget");
    release.resolve();
    for(let i=0;i<30&&f.store.isTurnActive("session");i++)await nextTick();
    assert.equal(f.store.getTurnLifecycle("session")?.state,"coco_budget");
    assert.equal(f.store.getSession("session")?.status,"paused");
  });
  it("resumeTurn can clear a pause without starting a free continuation",async()=>{
    const entered=deferred<void>(),release=deferred<void>();
    const f=fixture({runAgentTurn:async input=>{input.session.status="running";entered.resolve();await release.promise;assert.equal(input.takePauseRequested?.(),true);input.session.status="paused";return {status:"paused",modelIterations:0};}});
    await f.store.startTurn(f.request);await entered.promise;
    assert.equal(f.store.pauseTurn("session","coco_budget").ok,true);
    release.resolve();
    for(let i=0;i<30&&f.store.isTurnActive("session");i++)await nextTick();
    const before = f.calls.length;
    const result = await f.store.resumeTurn({
      sessionId: "session",
      fullPermissions: true,
      note: "Continuing after automation budget reset.",
      startContinuation: false,
    });
    assert.equal(result.ok, true);
    assert.equal(f.calls.length, before, "must not start a continuation turn");
    const session = f.store.getSession("session");
    assert.equal(session?.status, "idle");
    const note = session?.messages.find(m => m.role === "system" && m.parts.some(p => p.type === "text" && p.text.includes("automation budget reset")));
    assert.ok(note, "resume note is appended");
  });
  it("identifies and normalizes a turn that returned without a terminal status",async()=>{
    const done=deferred<void>();
    const f=fixture({runAgentTurn:async input=>{input.session.status="running";done.resolve();return {status:"idle",modelIterations:0};}});
    await f.store.startTurn(f.request);await done.promise;await flushTurn();
    assert.equal(f.store.getTurnLifecycle("session")?.state,"interrupted");assert.equal(f.store.normalizeInterruptedTurn("session"),true);assert.equal(f.store.getSession("session")?.status,"cancelled");
    assert.equal(f.store.getTurnLifecycle("session")?.requestedStop,undefined,"normalizing an unended turn must not invent a user stop");
  });
});
