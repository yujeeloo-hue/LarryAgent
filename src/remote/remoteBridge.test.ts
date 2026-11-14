import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRemoteBridge,
  REMOTE_READ_ONLY_ERROR,
  HEARTBEAT_PING_MS,
  HEARTBEAT_PONG_TIMEOUT_MS,
  EXEC_COMMAND_LIMIT_CHARS,
  EXEC_OUTPUT_LIMIT_BYTES,
  type RemoteBridge,
  type WebSocketLike,
  type DeviceExecResult,
} from "./remoteBridge.js";
import type { SessionStore } from "../main/sessionRuntime.js";
import {
  filterExistingFilePaths,
  readTextFilePreview,
} from "../main/filePreview.js";
import type { RemoteRelaySettings } from "../settings/types.js";

/** Manually drivable fake socket. */
class FakeSocket implements WebSocketLike {
  readyState = 1;
  OPEN = 1;
  sent: string[] = [];
  closed = false;
  listeners = new Map<string, Array<(args: unknown[]) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }
  pingCount = 0;
  ping(): void {
    this.pingCount += 1;
  }
  close(): void {
    this.closed = true;
  }
  terminate(): void {
    this.closed = true;
  }
  on(event: string, cb: (args: unknown[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
    return cb;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
  lastJson(): { [key: string]: unknown } | undefined {
    const raw = this.sent[this.sent.length - 1];
    return raw ? (JSON.parse(raw) as { [key: string]: unknown }) : undefined;
  }
}

function fakeStore(overrides: Partial<SessionStore> = {}): SessionStore {
  const calls: { startTurn: unknown[]; setSessionProvider: unknown[][]; setComposerPrefs: unknown[][] } = {
    startTurn: [],
    setSessionProvider: [],
    setComposerPrefs: [],
  };

  return {
    listSessions: () => [{ id: "s1", title: "T", updatedAt: 1, status: "idle", progressText: "", type: "agent", messageCount: 2, workspaceId: "w", archived: false, archivedAt: null }],
    getSession: (id: string) =>
      id === "s1"
        ? ({ id: "s1", title: "T", messages: [], status: "idle" } as never)
        : null,
    startTurn: async (req: unknown) => {
      calls.startTurn.push(req);
      const r = req as { userText: string; fullPermissions: boolean };
      return { sessionId: `started:${r.userText}:${r.fullPermissions}` };
    },
    setSessionProvider: async (sessionId: string, providerId: string) => {
      calls.setSessionProvider.push([sessionId, providerId]);
      return { id: sessionId, providerId } as never;
    },
    reassignSessionsUsingProvider: async () => {},
    setComposerPrefs: async (sessionId: string, patch: unknown) => {
      calls.setComposerPrefs.push([sessionId, patch]);
      return { id: sessionId, patch } as never;
    },
    cancelTurn: (id: string) => id === "s1",
    takePromptRestore: () => null,
    pauseTurn: () => ({ ok: true }),
    resumeTurn: async () => ({ ok: true }),
    enqueuePrompt: (req: { sessionId: string; userText: string; mode?: string }) => ({
      queued: { id: "q1", sessionId: req.sessionId, userText: req.userText, attachments: [], createdAt: 1, mode: req.mode ?? "deferred" },
      items: [],
    }),
    listPromptQueue: (sessionId: string) => [{ id: "q1", sessionId, userText: "hi", attachments: [], createdAt: 1, mode: "deferred" }],
    promoteQueuedPrompt: (sessionId: string, promptId: string) => ({ ok: true, started: true, items: [], args: ["promote", sessionId, promptId] }),
    deferQueuedPrompt: (sessionId: string, promptId: string) => ({ ok: true, items: [], args: ["defer", sessionId, promptId] }),
    removeQueuedPrompt: (sessionId: string, promptId: string) => ({ ok: true, items: [], args: ["remove", sessionId, promptId] }),
    moveQueuedPromptToFront: (sessionId: string, promptId: string) => ({ ok: true, items: [], args: ["front", sessionId, promptId] }),
    updateQueuedPromptText: (sessionId: string, promptId: string, text: string) => ({ ok: true, items: [], args: ["text", sessionId, promptId, text] }),
    respondUserAsk: () => true,
    respondToolApproval: () => true,
    approvePlan: async () => ({ ok: true }),
    discardPlan: () => ({ ok: true }),
    deleteSession: (id: string) => {
      return id === "s1";
    },
    ...overrides,
    __calls: calls,
  } as unknown as SessionStore & { __calls: typeof calls };
}

function makeBridge(opts: {
  settings?: Partial<RemoteRelaySettings>;
  store?: Partial<SessionStore>;
  deps?: Record<string, unknown>;
  socket: FakeSocket;
}): RemoteBridge {
  const settings: RemoteRelaySettings = {
    enabled: true,
    serverUrl: "ws://relay.test",
    deviceId: "device-1234",
    deviceName: "Test Mac",
    mode: "readonly",
    pushActivity: "all",
    ...opts.settings,
  };
  let timers: Array<() => void> = [];
  return createRemoteBridge({
    store: fakeStore(opts.store),
    getSettings: () => settings,
    getApiKey: async () => "jbr_test",
    appVersion: () => "0.7.3",
    platform: () => "darwin",
    webSocketFactory: () => opts.socket,
    setTimeoutFn: (fn) => {
      const handle = () => fn();
      timers.push(handle);
      return handle;
    },
    clearTimeoutFn: (t) => {
      timers = timers.filter((x) => x !== t);
    },
    ...(opts.deps as object),
  });
}

import { deriveStreamKey as deriveKey, FrameCipher as Cipher } from "./streamCipher.ts";

describe("remoteBridge", () => {
  it("forwards selected options and multiline answer comments from Relay", async () => {
    const socket = new FakeSocket();
    let received: unknown;
    const bridge = makeBridge({ socket, settings: { mode: "full" }, store: {
      respondUserAsk: input => { received = input; return true; },
    } });
    await bridge.start(); socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: "reply", action: "respondUserAsk",
      payload: { requestId: "ask", selections: ["Preview"], custom: false, comment: "Keep drafts.\nNo deployment." } })));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(received, { requestId: "ask", selected: null, selections: ["Preview"], custom: false, comment: "Keep drafts.\nNo deployment." });
    bridge.stop();
  });
  it("sends hello on open and reports connected", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({ socket });
    const statuses: string[] = [];
    const observable = createRemoteBridge({
      store: fakeStore(),
      getSettings: () => ({ enabled: true, serverUrl: "ws://x", deviceId: "d-1234", deviceName: "N", mode: "readonly", pushActivity: "all" }),
      getApiKey: async () => "k",
      appVersion: () => "1",
      platform: () => "darwin",
      webSocketFactory: () => socket,
      events: { onStatusChange: (s) => statuses.push(s) },
    });
    await observable.start();
    socket.emit("open");
    const hello = socket.sent
      .map((s) => JSON.parse(s) as { type: string; device?: { deviceId: string } })
      .find((m) => m.type === "hello");
    assert.equal(hello?.type, "hello");
    assert.equal(hello?.device?.deviceId, "d-1234");
    assert.ok(statuses.includes("connected"));
  });

  it("pushes the running-session count on connect and turn transitions", async () => {
    const socket = new FakeSocket();
    let summaries: Array<{ id: string; status: string }> = [{ id: "s1", status: "idle" }];
    const bridge = makeBridge({
      socket,
      store: { listSessions: () => summaries.map((s, i) => ({ id: s.id, title: `T${i}`, updatedAt: 1, status: s.status, progressText: "", type: "agent", messageCount: 0, workspaceId: "w", archived: false, archivedAt: null })) as never },
    });
    await bridge.start();
    socket.emit("open");
    const lastStatus = () =>
      socket.sent
        .map((s) => JSON.parse(s) as { type?: string; runningSessions?: number })
        .filter((m) => m.type === "status")
        .pop();
    // Initial push after hello (0 running).
    assert.equal(lastStatus()?.runningSessions, 0);

    // status transition → count re-push (2 running now).
    summaries = [{ id: "s1", status: "running" }, { id: "s2", status: "running" }];
    bridge.handleStreamEvent({ sessionId: "s1", event: { type: "status", status: "running" } });
    assert.equal(lastStatus()?.runningSessions, 2);
    const pushesSoFar = socket.sent.filter((s) => s.includes('"runningSessions"')).length;

    // Non-lifecycle events never re-push the count.
    bridge.handleStreamEvent({ sessionId: "s1", event: { type: "text_delta", text: "x" } });
    assert.equal(socket.sent.filter((s) => s.includes('"runningSessions"')).length, pushesSoFar);

    // done → count drops back to 0.
    summaries = [{ id: "s1", status: "idle" }, { id: "s2", status: "idle" }];
    bridge.handleStreamEvent({ sessionId: "s1", event: { type: "done" } });
    assert.equal(lastStatus()?.runningSessions, 0);
  });

  const sentEvents = (socket: FakeSocket) =>
    socket.sent
      .map((s) => JSON.parse(s) as { type?: string; sessionId?: string })
      .filter((m) => m.type === "event");

  it("holds events while no viewer is subscribed and resumes on presence", async () => {
    const socket = new FakeSocket();
    let summaries: Array<{ id: string; status: string }> = [{ id: "s1", status: "idle" }];
    const bridge = makeBridge({
      socket,
      store: {
        listSessions: () =>
          summaries.map((s) => ({ id: s.id, title: "T", updatedAt: 1, status: s.status, progressText: "", type: "agent", messageCount: 0, workspaceId: "w", archived: false, archivedAt: null })) as never,
      },
    });
    await bridge.start();
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "welcome", viewers: 0 })));

    // Nobody subscribed → content stays local.
    bridge.handleStreamEvent({ sessionId: "s1", event: { type: "text_delta", text: "x" } });
    assert.equal(sentEvents(socket).length, 0);

    // Busy count survives the gate — it is metadata, not conversation content.
    summaries = [{ id: "s1", status: "running" }];
    bridge.handleStreamEvent({ sessionId: "s1", event: { type: "status", status: "running" } });
    assert.equal(sentEvents(socket).length, 0);
    assert.ok(socket.sent.some((s) => s.includes('"runningSessions":1')));

    // A viewer subscribes → live events flow again.
    socket.emit("message", Buffer.from(JSON.stringify({ type: "presence", viewers: 1 })));
    bridge.handleStreamEvent({ sessionId: "s1", event: { type: "text_delta", text: "y" } });
    assert.equal(sentEvents(socket).length, 1);

    // Last viewer leaves → hold again.
    socket.emit("message", Buffer.from(JSON.stringify({ type: "presence", viewers: 0 })));
    bridge.handleStreamEvent({ sessionId: "s1", event: { type: "text_delta", text: "z" } });
    assert.equal(sentEvents(socket).length, 1);
  });

  it("keeps streaming when the relay reports no presence (pre-1.3 relays)", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({ socket });
    await bridge.start();
    socket.emit("open");
    // Old relays never send welcome.viewers or presence — unknown must
    // fail open, not silently mute the device.
    bridge.handleStreamEvent({ sessionId: "s1", event: { type: "text_delta", text: "x" } });
    assert.equal(sentEvents(socket).length, 1);
  });

  it("fires onActivity only when payloads actually leave for the relay", async () => {
    const socket = new FakeSocket();
    const pulses: number[] = [];
    const bridge = makeBridge({
      socket,
      deps: { events: { onActivity: () => pulses.push(1) } },
    });
    await bridge.start();
    socket.emit("open");

    // House rule (#9): the connect-time busy-count status push leaves the
    // machine too, so it pulses before any explicit traffic.
    const baseline = pulses.length;
    assert.ok(baseline >= 1, "connect-time status push should pulse");

    // Event fanout → one pulse.
    bridge.handleStreamEvent({ sessionId: "s1", event: { type: "text_delta", text: "x" } });
    assert.equal(pulses.length, baseline + 1);

    // Held by the presence gate → nothing leaves, no pulse.
    socket.emit("message", Buffer.from(JSON.stringify({ type: "presence", viewers: 0 })));
    bridge.handleStreamEvent({ sessionId: "s1", event: { type: "text_delta", text: "y" } });
    assert.equal(pulses.length, baseline + 1);

    // Viewer-request responses travel up too.
    socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: "r9", action: "listSessions" })));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(pulses.length, baseline + 2);
  });

  it("pushActivity=active streams only sessions with a turn in flight", async () => {
    const socket = new FakeSocket();
    let summaries: Array<{ id: string; status: string }> = [
      { id: "s1", status: "running" },
      { id: "s2", status: "idle" },
    ];
    const bridge = makeBridge({
      socket,
      settings: { pushActivity: "active" },
      store: {
        listSessions: () =>
          summaries.map((s) => ({ id: s.id, title: "T", updatedAt: 1, status: s.status, progressText: "", type: "agent", messageCount: 0, workspaceId: "w", archived: false, archivedAt: null })) as never,
      },
    });
    await bridge.start();
    socket.emit("open");

    // Idle-session chatter stays local; running sessions stream.
    bridge.handleStreamEvent({ sessionId: "s2", event: { type: "text_delta", text: "no" } });
    assert.equal(sentEvents(socket).length, 0);
    bridge.handleStreamEvent({ sessionId: "s1", event: { type: "text_delta", text: "yes" } });
    assert.equal(sentEvents(socket).length, 1);
    assert.equal(sentEvents(socket)[0]?.sessionId, "s1");

    // Turn tail: the store flips to idle *before* done is broadcast — the
    // latched in-flight set must still forward the closing event.
    summaries = [
      { id: "s1", status: "idle" },
      { id: "s2", status: "idle" },
    ];
    bridge.handleStreamEvent({ sessionId: "s1", event: { type: "done", reason: "complete" } });
    assert.equal(sentEvents(socket).length, 2);

    // Post-done chatter for s1 stays local again until its next turn.
    bridge.handleStreamEvent({ sessionId: "s1", event: { type: "text_delta", text: "late" } });
    assert.equal(sentEvents(socket).length, 2);

    // Paused turns count as in-flight (resumable) and stream.
    summaries = [
      { id: "s1", status: "paused" },
      { id: "s2", status: "idle" },
    ];
    bridge.handleStreamEvent({ sessionId: "s1", event: { type: "status", status: "paused" } });
    assert.equal(sentEvents(socket).length, 3);
  });

  it("pushActivity=active still forwards session_deleted for idle sessions", async () => {
    const socket = new FakeSocket();
    // Deleted sessions are never in flight (deleteSession refuses mid-turn),
    // so without an exemption the active gate would swallow every notice.
    const summaries: Array<{ id: string; status: string }> = [{ id: "s1", status: "idle" }];
    const bridge = makeBridge({
      socket,
      settings: { pushActivity: "active" },
      store: {
        listSessions: () =>
          summaries.map((s) => ({ id: s.id, title: "T", updatedAt: 1, status: s.status, progressText: "", type: "agent", messageCount: 0, workspaceId: "w", archived: false, archivedAt: null })) as never,
      },
    });
    await bridge.start();
    socket.emit("open");

    bridge.handleStreamEvent({ sessionId: "s1", event: { type: "session_deleted", sessionId: "s1" } });
    assert.equal(sentEvents(socket).length, 1);
    assert.equal(sentEvents(socket)[0]?.sessionId, "s1");
  });

  it("pushActivity=off holds session_deleted like any other event", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({ socket, settings: { pushActivity: "off" } });
    await bridge.start();
    socket.emit("open");

    bridge.handleStreamEvent({ sessionId: "s1", event: { type: "session_deleted", sessionId: "s1" } });
    assert.equal(sentEvents(socket).length, 0);
  });

  it("serves read-only actions in readonly mode", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({ socket });
    await bridge.start();
    socket.emit("open");

    socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: "r1", action: "listSessions" })));
    await new Promise((r) => setTimeout(r, 10));
    const res = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok?: boolean }).find((m) => m.type === "res" && m.requestId === "r1");
    assert.ok(res?.ok);
  });

  it("never exposes opaque model replay state through session reads or mutation responses", async () => {
    const session = { id: "s1", title: "Visible session", status: "idle", messages: [{
      id: "assistant", role: "assistant", parts: [
        { type: "text", text: "Visible answer" },
        { type: "hosted_tool", id: "search", name: "web_search_call", status: "completed" },
        { type: "model_response", responseId: "response-private", output: [{ type: "reasoning", encrypted_content: "OPAQUE-REPLAY-SECRET" }] },
      ],
    }] };
    const socket = new FakeSocket();
    const bridge = makeBridge({ socket, settings: { mode: "full" }, store: {
      getSession: () => session as never,
      setSessionProvider: async () => session as never,
      setComposerPrefs: async () => session as never,
    } });
    await bridge.start();
    socket.emit("open");
    try {
      for (const action of ["getSession", "setSessionProvider", "setComposerPrefs"]) {
        socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: action, action, payload: { sessionId: "s1", providerId: "p", patch: { infinite: true } } })));
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      for (const action of ["getSession", "setSessionProvider", "setComposerPrefs"]) {
        const response = socket.sent.map((value) => JSON.parse(value) as { requestId?: string; ok?: boolean; result?: unknown }).find((value) => value.requestId === action)!;
        assert.equal(response.ok, true);
        assert.match(JSON.stringify(response.result), /Visible answer/);
        assert.match(JSON.stringify(response.result), /web_search_call/);
        assert.doesNotMatch(JSON.stringify(response.result), /model_response|OPAQUE-REPLAY|response-private/);
      }
      assert.equal(session.messages[0]!.parts.length, 3);
      assert.match(JSON.stringify(session), /OPAQUE-REPLAY/);
    } finally { bridge.stop(); }
  });

  it("serves browseDir in readonly mode, scoped to the home subtree", async () => {
    const home = mkdtempSync(join(tmpdir(), "jb-home-"));
    mkdirSync(join(home, "Developer"), { recursive: true });
    mkdirSync(join(home, "Developer", "JellyBot"));
    mkdirSync(join(home, "Developer", ".git-hidden"), { recursive: true });
    mkdirSync(join(home, "Desktop"), { recursive: true });
    writeFileSync(join(home, "Developer", "README.md"), "not a folder");

    const socket = new FakeSocket();
    const bridge = makeBridge({ socket, deps: { homeDir: () => home } });
    await bridge.start();
    socket.emit("open");

    const req = (rid: string, action: string, payload: unknown) =>
      socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: rid, action, payload })));
    const res = (rid: string) =>
      socket.sent
        .map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; result?: unknown; error?: string })
        .find((m) => m.type === "res" && m.requestId === rid);

    // No path → home listing (dirs only, dotfiles hidden, sorted).
    req("b1", "browseDir", {});
    // Explicit subfolder.
    req("b2", "browseDir", { path: join(home, "Developer") });
    // Outside the home subtree → refused.
    req("b3", "browseDir", { path: tmpdir() });
    // Missing folder inside home → device error, not a crash.
    req("b4", "browseDir", { path: join(home, "nope") });
    await new Promise((r) => setTimeout(r, 20));

    const r1 = res("b1");
    assert.ok(r1?.ok, "home listing should work in readonly mode");
    assert.deepEqual((r1?.result as { dirs: string[] }).dirs, ["Desktop", "Developer"]);
    assert.equal((r1?.result as { parent: string | null }).parent, null, "home has no browsable parent");

    const r2 = res("b2");
    assert.ok(r2?.ok);
    assert.deepEqual((r2?.result as { dirs: string[] }).dirs, ["JellyBot"]);
    assert.equal((r2?.result as { parent: string }).parent, home);

    const r3 = res("b3");
    assert.ok(r3 && !r3.ok, "paths outside home must be refused");
    assert.match(r3?.error ?? "", /home directory/);

    const r4 = res("b4");
    assert.ok(r4 && !r4.ok, "missing folder reports an error");
  });

  it("rejects createWorkspace in readonly mode", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({ socket, deps: { homeDir: () => mkdtempSync(join(tmpdir(), "jb-home-")) } });
    await bridge.start();
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: "cw", action: "createWorkspace", payload: { name: "X", path: "/tmp/x" } })));
    await new Promise((r) => setTimeout(r, 10));
    const res = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; error?: string }).find((m) => m.type === "res" && m.requestId === "cw");
    assert.ok(res && !res.ok);
    assert.equal(res?.error, REMOTE_READ_ONLY_ERROR);
  });

  it("rejects deleteSession in readonly mode", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({ socket });
    await bridge.start();
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: "d0", action: "deleteSession", payload: { sessionId: "s1" } })));
    await new Promise((r) => setTimeout(r, 10));
    const res = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; error?: string }).find((m) => m.type === "res" && m.requestId === "d0");
    assert.ok(res && !res.ok);
    assert.equal(res?.error, REMOTE_READ_ONLY_ERROR);
  });

  it("deleteSession in full mode: deletes, refuses busy/unknown/missing-id", async () => {
    const socket = new FakeSocket();
    const deleted: string[] = [];
    const bridge = makeBridge({
      socket,
      settings: { mode: "full" },
      store: {
        // "busy" exists but its delete refuses (turn in flight / compacting).
        getSession: ((id: string) =>
          id === "s1" || id === "busy"
            ? ({ id, title: "T", messages: [], status: "idle" } as never)
            : null) as never,
        deleteSession: (id: string) => {
          deleted.push(id);
          return id === "s1";
        },
      },
    });
    await bridge.start();
    socket.emit("open");
    const send = (rid: string, payload: unknown): void => {
      socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: rid, action: "deleteSession", payload })));
    };
    const res = (rid: string) =>
      socket.sent
        .map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; error?: string; result?: { deleted?: boolean; sessionId?: string } })
        .find((m) => m.type === "res" && m.requestId === rid);

    send("d1", { sessionId: "s1" });
    send("d2", { sessionId: "busy" });
    send("d3", { sessionId: "nope" });
    send("d4", {});
    await new Promise((r) => setTimeout(r, 10));

    const r1 = res("d1");
    assert.ok(r1?.ok, "known idle session deletes");
    assert.equal(r1?.result?.deleted, true);
    assert.equal(r1?.result?.sessionId, "s1");
    assert.deepEqual(deleted, ["s1", "busy"], "store.deleteSession is the only delete path");

    const r2 = res("d2");
    assert.ok(r2 && !r2.ok, "busy session refuses");
    assert.match(r2?.error ?? "", /stop it first/);

    const r3 = res("d3");
    assert.ok(r3 && !r3.ok, "unknown session refuses");
    assert.match(r3?.error ?? "", /not found/);

    const r4 = res("d4");
    assert.ok(r4 && !r4.ok, "missing sessionId refuses");
    assert.match(r4?.error ?? "", /sessionId required/);
  });

  // ── deviceExec (agentd ≥ 1.3.5, sandboxed one-shot shell) ──────

  /** Full-control bridge with the agentd gate satisfied (dep presence). */
  function makeExecBridge(socket: FakeSocket): RemoteBridge {
    return makeBridge({
      socket,
      settings: { mode: "full" },
      deps: { deviceMaintenance: { execSupported: true } },
    });
  }

  function sendExec(socket: FakeSocket, rid: string, payload: unknown): void {
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "req", requestId: rid, action: "deviceExec", payload })),
    );
  }

  type ExecRes = { ok: boolean; error?: string; result?: DeviceExecResult };

  async function waitExecRes(socket: FakeSocket, rid: string, timeoutMs = 8000): Promise<ExecRes> {
    const started = Date.now();
    for (;;) {
      const found = socket.sent
        .map((s) => JSON.parse(s) as { type: string; requestId: string } & ExecRes)
        .find((m) => m.type === "res" && m.requestId === rid);
      if (found) return found;
      if (Date.now() - started > timeoutMs) throw new Error(`no res for ${rid} within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("deviceExec rejects readonly viewers and non-agentd devices", async () => {
    const roSocket = new FakeSocket();
    const roBridge = makeBridge({ socket: roSocket }); // readonly default
    await roBridge.start();
    roSocket.emit("open");
    sendExec(roSocket, "x1", { command: "echo hi" });
    await new Promise((r) => setTimeout(r, 20));
    const ro = roSocket.sent
      .map((s) => JSON.parse(s) as { type: string; requestId: string; error?: string })
      .find((m) => m.type === "res" && m.requestId === "x1");
    assert.equal(ro?.error, REMOTE_READ_ONLY_ERROR);

    // Full control but no deviceMaintenance dep (desktop) → refuses.
    const dtSocket = new FakeSocket();
    const dtBridge = makeBridge({ socket: dtSocket, settings: { mode: "full" } });
    await dtBridge.start();
    dtSocket.emit("open");
    sendExec(dtSocket, "x2", { command: "echo hi" });
    await new Promise((r) => setTimeout(r, 20));
    const dt = dtSocket.sent
      .map((s) => JSON.parse(s) as { type: string; requestId: string; error?: string })
      .find((m) => m.type === "res" && m.requestId === "x2");
    assert.match(dt?.error ?? "", /only available on agentd/);
  });

  it("deviceExec validates the command (missing / blank / too long)", async () => {
    const socket = new FakeSocket();
    const bridge = makeExecBridge(socket);
    await bridge.start();
    socket.emit("open");
    sendExec(socket, "v1", {});
    sendExec(socket, "v2", { command: "   " });
    sendExec(socket, "v3", { command: "x".repeat(EXEC_COMMAND_LIMIT_CHARS + 1) });
    sendExec(socket, "v4", { command: "echo a\0b" });
    await new Promise((r) => setTimeout(r, 30));
    const res = (rid: string) =>
      socket.sent
        .map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; error?: string })
        .find((m) => m.type === "res" && m.requestId === rid);
    assert.match(res("v1")?.error ?? "", /command required/);
    assert.match(res("v2")?.error ?? "", /command required/);
    assert.match(res("v3")?.error ?? "", /command too long/);
    assert.match(res("v4")?.error ?? "", /NUL byte/);
  });

  it("deviceExec runs: exit codes, stderr, timeout clamp, output cap", { skip: process.platform === "win32" && "deviceExec runs /bin/sh" }, async () => {
    const socket = new FakeSocket();
    const bridge = makeExecBridge(socket);
    await bridge.start();
    socket.emit("open");

    sendExec(socket, "e1", { command: "echo hello" });
    const r1 = await waitExecRes(socket, "e1");
    assert.ok(r1.ok);
    assert.equal(r1.result?.exitCode, 0);
    assert.equal(r1.result?.stdout, "hello\n");
    assert.equal(r1.result?.timedOut, false);
    assert.equal(r1.result?.truncated, false);

    sendExec(socket, "e2", { command: "echo oops >&2; exit 3" });
    const r2 = await waitExecRes(socket, "e2");
    assert.ok(r2.ok, "non-zero exit is data, not an action error");
    assert.equal(r2.result?.exitCode, 3);
    assert.match(r2.result?.stderr ?? "", /oops/);

    // timeoutMs clamps to a 1s floor: sleep 3 must die at ~1s, not 50ms.
    const t0 = Date.now();
    sendExec(socket, "e3", { command: "sleep 3", timeoutMs: 50 });
    const r3 = await waitExecRes(socket, "e3", 6000);
    assert.ok(r3.ok);
    assert.equal(r3.result?.timedOut, true);
    assert.equal(r3.result?.exitCode, null);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 900 && elapsed < 2600, `killed at the 1s clamp, got ${elapsed}ms`);

    // Chatty command → maxBuffer kill, flagged truncated, payload stays capped.
    sendExec(socket, "e4", {
      command: `head -c ${EXEC_OUTPUT_LIMIT_BYTES + 40_000} /dev/zero | tr '\\0' 'x'`,
    });
    const r4 = await waitExecRes(socket, "e4");
    assert.ok(r4.ok);
    assert.equal(r4.result?.truncated, true);
    assert.ok((r4.result?.stdout ?? "").length <= EXEC_OUTPUT_LIMIT_BYTES + 64);
  });

  it("deviceExec is single-flight and releases the lock afterwards", { skip: process.platform === "win32" && "deviceExec runs /bin/sh" }, async () => {
    const socket = new FakeSocket();
    const bridge = makeExecBridge(socket);
    await bridge.start();
    socket.emit("open");
    sendExec(socket, "f1", { command: "sleep 2", timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 200)); // f1 definitely in flight
    sendExec(socket, "f2", { command: "echo nope" });
    const r2 = await waitExecRes(socket, "f2", 2000);
    assert.ok(!r2.ok);
    assert.match(r2.error ?? "", /another command is already running/);
    const r1 = await waitExecRes(socket, "f1", 6000);
    assert.ok(r1.ok, "first command completes");
    assert.equal(r1.result?.exitCode, 0);
    sendExec(socket, "f3", { command: "echo again" });
    const r3 = await waitExecRes(socket, "f3", 3000);
    assert.ok(r3.ok, "lock released after completion");
    assert.equal(r3.result?.stdout, "again\n");
  });

  it("createWorkspace in full mode: mkdir, register, idempotent, non-folder refused", async () => {
    const home = mkdtempSync(join(tmpdir(), "jb-home-"));
    const created: Array<{ name: string; path: string }> = [];
    const workspaces = [{ id: "w-existing", name: "Existing", path: join(home, "Existing") }];
    const socket = new FakeSocket();
    const bridge = makeBridge({
      socket,
      settings: { mode: "full" },
      store: {
        listWorkspaces: () => workspaces as never,
        createWorkspace: async (req: { name: string; path: string }) => {
          created.push(req);
          const ws = { id: `w-${created.length}`, name: req.name, path: req.path };
          workspaces.push(ws as never);
          return ws as never;
        },
      },
      deps: { homeDir: () => home },
    });
    await bridge.start();
    socket.emit("open");

    const req = (rid: string, payload: unknown) =>
      socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: rid, action: "createWorkspace", payload })));
    const res = (rid: string) =>
      socket.sent
        .map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; result?: { id: string; existing?: boolean }; error?: string })
        .find((m) => m.type === "res" && m.requestId === rid);

    // 1. Missing folder → mkdir -p + register.
    req("c1", { name: "PiBot", path: `${home}/Developer/PiBot` });
    await new Promise((r) => setTimeout(r, 15));
    // 2. Same path again → existing workspace, no duplicate store call.
    req("c2", { name: "PiBot 2", path: `${home}/Developer/PiBot/` });
    await new Promise((r) => setTimeout(r, 15));
    // 3. Path exists as a file → refused.
    const filePath = join(home, "afile.txt");
    writeFileSync(filePath, "x");
    req("c3", { name: "Bad", path: filePath });
    // 4. Relative path → refused before touching fs.
    req("c4", { name: "Rel", path: "relative/path" });
    await new Promise((r) => setTimeout(r, 30));

    const r1 = res("c1");
    assert.ok(r1?.ok, "create should succeed in full mode");
    assert.equal(r1?.result?.id, "w-1");
    assert.equal(r1?.result?.existing, false);
    assert.ok(existsSync(join(home, "Developer", "PiBot")), "folder should be created");
    assert.equal(created.length, 1);

    const r2 = res("c2");
    assert.ok(r2?.ok, "re-register returns the existing workspace");
    assert.equal(r2?.result?.id, "w-1");
    assert.equal(r2?.result?.existing, true);
    assert.equal(created.length, 1, "no duplicate store.createWorkspace call");

    const r3 = res("c3");
    assert.ok(r3 && !r3.ok, "a file path must be refused");
    assert.match(r3?.error ?? "", /not a folder/);

    const r4 = res("c4");
    assert.ok(r4 && !r4.ok, "relative paths must be refused");
    assert.match(r4?.error ?? "", /absolute/);
  });

  it("serves session-scoped file preview actions in readonly mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jb-files-"));
    const listed = join(dir, "out.txt");
    const mentionedMissing = join(dir, "gone.txt");
    const secret = join(dir, "secret.txt");
    const planDocPath = join(dir, "docs", "plans", "20261010-demo.md");
    const otherPlanDocPath = join(dir, "docs", "plans", "20261010-other.md");
    writeFileSync(listed, "hello files");
    writeFileSync(secret, "no peeking");
    mkdirSync(join(dir, "docs", "plans"), { recursive: true });
    writeFileSync(planDocPath, "# plan");

    // write_file tool pair yields `listed`; assistant prose mentions
    // `mentionedMissing`; `secret` appears nowhere in the conversation.
    const session = {
      id: "s1",
      title: "T",
      status: "idle",
      // Plan doc staged by the plan writer (absolute path, never a tool
      // call) — must be readable for the remote Approve bar.
      planDoc: { path: planDocPath, summary: "s", updatedAt: 1, approvalPending: true },
      messages: [
        { role: "user", parts: [{ type: "text", text: "write a file" }] },
        {
          role: "assistant",
          parts: [
            { type: "tool_call", id: "call-1", name: "write_file", arguments: { path: listed } },
          ],
        },
        {
          role: "tool",
          parts: [
            {
              type: "tool_result",
              toolCallId: "call-1",
              returnCode: 0,
              content: [{ type: "attachment", uri: `file://${listed}`, name: "out.txt" }],
            },
          ],
        },
        {
          role: "assistant",
          parts: [{ type: "text", text: `wrote ${listed}, also mentioned ${mentionedMissing}` }],
        },
      ],
    };

    const socket = new FakeSocket();
    const bridge = makeBridge({
      socket,
      store: {
        getSession: (id: string) => (id === "s1" ? (session as never) : null),
      },
      deps: {
        readTextFilePreview,
        filterExistingFiles: filterExistingFilePaths,
      },
    });
    await bridge.start();
    socket.emit("open");

    const req = (rid: string, action: string, payload: unknown) =>
      socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: rid, action, payload })));
    const res = (rid: string) =>
      socket.sent
        .map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; result?: unknown; error?: string })
        .find((m) => m.type === "res" && m.requestId === rid);

    req("f1", "readTextFile", { sessionId: "s1", path: listed });
    req("f2", "readTextFile", { sessionId: "s1", path: secret });
    req("f3", "readTextFile", { sessionId: "nope", path: listed });
    req("f6", "readTextFile", { sessionId: "s1", path: planDocPath });
    req("f7", "readTextFile", { sessionId: "s1", path: otherPlanDocPath });
    req("f4", "filterExistingFiles", { sessionId: "s1", paths: [listed, mentionedMissing, secret] });
    req("f5", "getPathsDiffStats", { sessionId: "s1", paths: [listed] });
    await new Promise((r) => setTimeout(r, 20));

    const r1 = res("f1");
    assert.ok(r1?.ok, "listed file should preview");
    assert.deepEqual(r1?.result, { ok: true, content: "hello files" });

    const r2 = res("f2");
    assert.ok(r2 && !r2.ok, "unlisted file must be refused");
    assert.equal(r2?.error, "path is not in this conversation's file list");

    const r3 = res("f3");
    assert.ok(r3 && !r3.ok);
    assert.equal(r3?.error, "session not found");

    const r6 = res("f6");
    assert.ok(r6?.ok, "the session's own plan doc should preview");
    assert.deepEqual(r6?.result, { ok: true, content: "# plan" });

    const r7 = res("f7");
    assert.ok(r7 && !r7.ok, "a different plan doc must stay refused");
    assert.equal(r7?.error, "path is not in this conversation's file list");

    const r4 = res("f4");
    assert.ok(r4?.ok);
    assert.deepEqual(r4?.result, [listed]);

    const r5 = res("f5");
    assert.ok(r5?.ok);
    assert.deepEqual(r5?.result, []);
  });

  it("rejects mutating actions in readonly mode", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({ socket, settings: { mode: "readonly" } });
    await bridge.start();
    socket.emit("open");

    socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: "r2", action: "startTurn", payload: { sessionId: "s1", userText: "hi" } })));
    await new Promise((r) => setTimeout(r, 10));
    const res = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; error?: string }).find((m) => m.type === "res" && m.requestId === "r2");
    assert.ok(res && !res.ok);
    assert.equal(res?.error, REMOTE_READ_ONLY_ERROR);
  });

  it("serves deviceStatus in readonly mode but gates maintenance mutations", async () => {
    const socket = new FakeSocket();
    const calls: string[] = [];
    const maintenance = {
      status: () => ({ version: "1.3.1", supervised: true, calls }),
      currentState: () => null,
      restart: () => ({ restarting: true, supervisor: "systemd" }),
      reboot: () => ({ rebooting: true }),
      update: async () => ({ queued: true, id: "u1", mode: "updater" }),
      checkUpdate: async () => null,
    };
    const bridge = makeBridge({
      socket,
      settings: { mode: "readonly" },
      deps: { deviceMaintenance: maintenance },
    });
    await bridge.start();
    socket.emit("open");
    const resOf = (rid: string) =>
      socket.sent
        .map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; result?: unknown; error?: string })
        .find((m) => m.type === "res" && m.requestId === rid);

    socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: "st", action: "deviceStatus" })));
    await new Promise((r) => setTimeout(r, 10));
    const st = resOf("st");
    assert.ok(st?.ok);
    assert.equal((st?.result as { version: string }).version, "1.3.1");

    for (const [rid, action] of [
      ["rs", "restartDevice"],
      ["rb", "rebootDevice"],
      ["up", "updateDevice"],
      ["cu", "checkUpdate"],
    ] as const) {
      socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: rid, action, payload: {} })));
      await new Promise((r) => setTimeout(r, 10));
      const res = resOf(rid);
      assert.ok(res && !res.ok, `${action} must be gated`);
      assert.equal(res?.error, REMOTE_READ_ONLY_ERROR);
    }
  });

  it("answers maintenance actions with a clear error when unsupported", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({ socket, settings: { mode: "full" } });
    await bridge.start();
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: "d1", action: "restartDevice" })));
    await new Promise((r) => setTimeout(r, 10));
    const res = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; error?: string }).find((m) => m.type === "res" && m.requestId === "d1");
    assert.ok(res && !res.ok);
    assert.match(res?.error ?? "", /remote restart is not available on this device/);
  });

  it("desktop maintenance: serves status/restart/update but never the remote shell", async () => {
    const socket = new FakeSocket();
    const updates: Array<{ source: string; sha256?: string; version?: string }> = [];
    const bridge = makeBridge({
      socket,
      settings: { mode: "full" },
      deps: {
        deviceMaintenance: {
          // Desktop shape: update/restart yes, exec opted OUT.
          status: () => ({ agent: "desktop", version: "1.5.1" }),
          currentState: () => null,
          restart: () => ({ restarting: true, supervisor: "electron" }),
          reboot: () => {
            throw new Error("system reboot is not supported on desktop devices");
          },
          update: async (input: { source: string; sha256?: string; version?: string }) => {
            updates.push(input);
            return { queued: true, id: "u-desktop", mode: "in-process" };
          },
          checkUpdate: async () => null,
        },
      },
    });
    await bridge.start();
    socket.emit("open");
    const ask = async (rid: string, action: string, payload: Record<string, unknown> = {}) => {
      socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: rid, action, payload })));
      await new Promise((r) => setTimeout(r, 10));
      return socket.sent
        .map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; result?: unknown; error?: string })
        .find((m) => m.type === "res" && m.requestId === rid);
    };

    const status = await ask("d1", "deviceStatus");
    assert.ok(status?.ok);
    assert.equal((status?.result as { agent: string }).agent, "desktop");

    const restart = await ask("d2", "restartDevice");
    assert.ok(restart?.ok);
    assert.deepEqual(restart?.result, { restarting: true, supervisor: "electron" });

    // The target version from checkUpdate rides through to the device.
    const upd = await ask("d3", "updateDevice", {
      source: "https://larryagent.online/download/Larry-Agent-1.6.0-win-x64-setup.exe",
      sha256: "b".repeat(64),
      version: "1.6.0",
    });
    assert.ok(upd?.ok);
    assert.deepEqual(updates, [
      {
        source: "https://larryagent.online/download/Larry-Agent-1.6.0-win-x64-setup.exe",
        sha256: "b".repeat(64),
        force: false,
        version: "1.6.0",
      },
    ]);

    // Host reboot and remote shell stay agentd-only regardless of maintenance.
    const reboot = await ask("d4", "rebootDevice");
    assert.ok(reboot && !reboot.ok);
    assert.match(reboot?.error ?? "", /not supported on desktop devices/);

    const exec = await ask("d5", "deviceExec", { command: "echo hi" });
    assert.ok(exec && !exec.ok);
    assert.match(exec?.error ?? "", /only available on agentd/);
  });

  it("restarts, reboots and queues updates in full mode with validation", async () => {
    const socket = new FakeSocket();
    const restarts: number[] = [];
    const updates: Array<{ source: string; sha256?: string; force?: boolean }> = [];
    const bridge = makeBridge({
      socket,
      settings: { mode: "full" },
      deps: {
        deviceMaintenance: {
          status: () => ({}),
          currentState: () => null,
          restart: () => {
            restarts.push(Date.now());
            return { restarting: true, supervisor: "systemd" };
          },
          reboot: () => ({ rebooting: true }),
          update: async (input: { source: string; sha256?: string; force?: boolean }) => {
            updates.push(input);
            return { queued: true, id: "u9", mode: "updater" };
          },
          checkUpdate: async () => null,
        },
      },
    });
    await bridge.start();
    socket.emit("open");
    const resOf = (rid: string) =>
      socket.sent
        .map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; result?: unknown; error?: string })
        .find((m) => m.type === "res" && m.requestId === rid);
    const ask = async (rid: string, action: string, payload: Record<string, unknown>) => {
      socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: rid, action, payload })));
      await new Promise((r) => setTimeout(r, 10));
      return resOf(rid);
    };

    const restart = await ask("r1", "restartDevice", {});
    assert.ok(restart?.ok);
    assert.deepEqual(restart?.result, { restarting: true, supervisor: "systemd" });
    assert.equal(restarts.length, 1);

    const reboot = await ask("r2", "rebootDevice", {});
    assert.ok(reboot?.ok);
    assert.deepEqual(reboot?.result, { rebooting: true });

    // URL without sha256 → refused (mirrors the CLI's rule).
    const bare = await ask("r3", "updateDevice", { source: "https://example.test/x.tar.gz" });
    assert.ok(bare && !bare.ok);
    assert.match(bare?.error ?? "", /sha256/i);

    const hex64 = "a".repeat(64);
    const upd = await ask("r4", "updateDevice", { source: "https://example.test/x.tar.gz", sha256: hex64.toUpperCase(), force: true });
    assert.ok(upd?.ok);
    assert.deepEqual(upd?.result, { queued: true, id: "u9", mode: "updater" });
    assert.deepEqual(updates, [{ source: "https://example.test/x.tar.gz", sha256: hex64, force: true }]);

    // Local path source (no sha required), relative path refused.
    const local = await ask("r5", "updateDevice", { source: "/var/lib/jellybot-agent/x.tar.gz" });
    assert.ok(local?.ok);
    const relative = await ask("r6", "updateDevice", { source: "x.tar.gz" });
    assert.ok(relative && !relative.ok);

    const check = await ask("r7", "checkUpdate", { manifestUrl: "http://insecure.test/downloads.json" });
    assert.ok(check && !check.ok);
    assert.match(check?.error ?? "", /https/);

    const insecure = await ask("r8", "updateDevice", {
      source: "http://example.test/x.tar.gz",
      sha256: hex64,
    });
    assert.ok(insecure && !insecure.ok);
    assert.match(insecure?.error ?? "", /https only/);
    assert.equal(updates.length, 2);
  });

  it("pushes maintenance state frames and re-pushes on welcome", async () => {
    const socket = new FakeSocket();
    let state: { phase: "idle" | "queued"; ts: number } | null = null;
    const bridge = makeBridge({
      socket,
      settings: { mode: "full" },
      deps: {
        deviceMaintenance: {
          status: () => ({}),
          currentState: () => state,
          restart: () => ({ restarting: true, supervisor: "systemd" }),
          reboot: () => ({ rebooting: true }),
          update: async () => ({ queued: true, id: "u1", mode: "updater" }),
          checkUpdate: async () => null,
        },
      },
    });
    await bridge.start();
    socket.emit("open");

    const maintenanceFrames = () =>
      socket.sent
        .map((s) => JSON.parse(s) as { type?: string; maintenance?: { phase: string } })
        .filter((m) => m.type === "status" && m.maintenance);

    state = { phase: "queued", ts: 1 };
    bridge.pushMaintenanceState({ phase: "queued", id: "u1", ts: 1 });
    assert.equal(maintenanceFrames().length, 1);

    // Reconnect: welcome → current state re-pushed automatically.
    socket.sent.length = 0;
    socket.emit("message", Buffer.from(JSON.stringify({ type: "welcome", viewers: 0 })));
    assert.equal(maintenanceFrames().length, 1, "welcome must re-push the live maintenance state");

    // pushActivity=off holds maintenance frames like busy-count pushes.
    const quietBridge = makeBridge({
      socket,
      settings: { mode: "full", pushActivity: "off" },
    });
    await quietBridge.start();
    socket.emit("open");
    socket.sent.length = 0;
    quietBridge.pushMaintenanceState({ phase: "idle", ts: 2 });
    assert.equal(maintenanceFrames().length, 0);
  });

  it("passes an explicit fullPermissions through in full mode", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({ socket, settings: { mode: "full" } });
    await bridge.start();
    socket.emit("open");

    socket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "r3", action: "startTurn",
      payload: { sessionId: "s1", userText: "hello", fullPermissions: true },
    })));
    await new Promise((r) => setTimeout(r, 10));
    const res = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; result?: unknown }).find((m) => m.type === "res" && m.requestId === "r3");
    assert.ok(res?.ok);
    // fakeStore encodes the args into the result sessionId.
    assert.equal((res?.result as { sessionId: string }).sessionId, "started:hello:true");
  });

  it("defaults fullPermissions=false when the payload omits it", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({ socket, settings: { mode: "full" } });
    await bridge.start();
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "r3b", action: "startTurn",
      payload: { sessionId: "s1", userText: "hello" },
    })));
    await new Promise((r) => setTimeout(r, 10));
    const res = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; result?: unknown }).find((m) => m.type === "res" && m.requestId === "r3b");
    assert.ok(res?.ok);
    assert.equal((res?.result as { sessionId: string }).sessionId, "started:hello:false");
  });

  it("serves listComposerOptions in readonly mode", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({
      socket,
      deps: {
        getComposerSnapshot: async () => ({
          providers: [{ id: "deepseek", name: "DeepSeek", modelId: "deepseek-v4-flash" }],
          activeProviderId: "deepseek",
          composerInfinite: true,
          reasoningEffort: "low",
          contextLimitTokens: 200_000,
        }),
      },
    });
    await bridge.start();
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: "rc1", action: "listComposerOptions" })));
    await new Promise((r) => setTimeout(r, 10));
    const res = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; result?: Record<string, unknown> }).find((m) => m.type === "res" && m.requestId === "rc1");
    assert.ok(res?.ok);
    const result = res!.result!;
    assert.equal((result.providers as Array<{ id: string }>)[0].id, "deepseek");
    assert.deepEqual(result.defaults, {
      composerInfinite: true,
      reasoningEffort: "low",
      contextLimitTokens: 200_000,
    });
    assert.equal(result.remoteMode, "readonly");
  });

  it("omits contextLimitTokens from listComposerOptions when the snapshot lacks it", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({
      socket,
      deps: {
        getComposerSnapshot: async () => ({
          providers: [],
          activeProviderId: "",
          composerInfinite: false,
          reasoningEffort: "low",
        }),
      },
    });
    await bridge.start();
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: "rc1", action: "listComposerOptions" })));
    await new Promise((r) => setTimeout(r, 10));
    const res = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; result?: Record<string, unknown> }).find((m) => m.type === "res" && m.requestId === "rc1");
    assert.ok(res?.ok);
    const defaults = res!.result!.defaults as Record<string, unknown>;
    assert.equal("contextLimitTokens" in defaults, false);
  });

  it("rejects composer mutation actions in readonly mode", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({ socket, settings: { mode: "readonly" } });
    await bridge.start();
    socket.emit("open");
    for (const [rid, action] of [
      ["ru1", "uploadAttachment"],
      ["rp1", "setSessionProvider"],
      ["rc2", "setComposerPrefs"],
    ] as const) {
      socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: rid, action, payload: {} })));
    }
    await new Promise((r) => setTimeout(r, 10));
    for (const rid of ["ru1", "rp1", "rc2"]) {
      const res = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; error?: string }).find((m) => m.type === "res" && m.requestId === rid);
      assert.ok(res && !res.ok, `${rid} should fail`);
      assert.equal(res?.error, REMOTE_READ_ONLY_ERROR);
    }
  });

  it("uploadAttachment sanitizes names and enforces the size cap", async () => {
    const socket = new FakeSocket();
    const saved: Array<{ name: string; contentBase64: string }> = [];
    const bridge = makeBridge({
      socket,
      settings: { mode: "full" },
      deps: {
        saveRemoteUpload: async ({ name, contentBase64 }: { name: string; contentBase64: string }) => {
          saved.push({ name, contentBase64 });
          return { path: `/tmp/jellybot-remote-uploads/x-${name}`, name, kind: "file", mimeType: "text/plain" };
        },
      },
    });
    await bridge.start();
    socket.emit("open");
    // Oversized payload (base64 of 8MB+ zeros → >8MB decoded).
    const huge = "A".repeat(Math.ceil((8 * 1024 * 1024 + 1024) * 4 / 3));
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "ru2", action: "uploadAttachment",
      payload: { name: "../../etc/passwd", mimeType: "text/plain", contentBase64: huge },
    })));
    await new Promise((r) => setTimeout(r, 10));
    const tooBig = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; error?: string }).find((m) => m.type === "res" && m.requestId === "ru2");
    assert.ok(tooBig && !tooBig.ok);
    assert.match(tooBig!.error!, /8 MB/);

    socket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "ru3", action: "uploadAttachment",
      payload: { name: "../../notes.txt", mimeType: "text/plain", contentBase64: "aGVsbG8=" },
    })));
    await new Promise((r) => setTimeout(r, 10));
    const ok = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; result?: { path: string } }).find((m) => m.type === "res" && m.requestId === "ru3");
    assert.ok(ok?.ok);
    // Path traversal stripped to the basename before hitting the device fs.
    assert.equal(saved[0].name, "notes.txt");
  });

  it("startTurn rejects attachments outside the remote upload dir", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({
      socket,
      settings: { mode: "full" },
      deps: { remoteUploadDir: () => "/tmp/jellybot-remote-uploads" },
    });
    await bridge.start();
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "ra1", action: "startTurn",
      payload: {
        sessionId: "s1",
        userText: "with file",
        attachments: [{ path: "/Users/youyee/Secrets/keys.txt", name: "keys.txt", kind: "file", mimeType: "text/plain" }],
      },
    })));
    await new Promise((r) => setTimeout(r, 10));
    const res = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; error?: string }).find((m) => m.type === "res" && m.requestId === "ra1");
    assert.ok(res && !res.ok);
    assert.match(res!.error!, /uploadAttachment/);
  });

  it("startTurn forwards composer fields and staged attachments", async () => {
    const socket = new FakeSocket();
    const store = fakeStore();
    const bridge = makeBridge({
      socket,
      store,
      settings: { mode: "full" },
      deps: { remoteUploadDir: () => "/tmp/jellybot-remote-uploads" },
    });
    await bridge.start();
    socket.emit("open");
    const stagedPath = "/tmp/jellybot-remote-uploads/123-ab-shot.png";
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "ra2", action: "startTurn",
      payload: {
        sessionId: "s1",
        userText: "look at this",
        providerId: "deepseek",
        reasoningEffort: "max",
        composerInfinite: true,
        fullPermissions: true,
        attachments: [{ path: stagedPath, name: "shot.png", kind: "image", mimeType: "image/png", sizeBytes: 12 }],
      },
    })));
    await new Promise((r) => setTimeout(r, 10));
    const res = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean }).find((m) => m.type === "res" && m.requestId === "ra2");
    assert.ok(res?.ok);
    const req = (store as unknown as { __calls: { startTurn: unknown[] } }).__calls.startTurn[0] as Record<string, unknown>;
    assert.equal(req.providerId, "deepseek");
    assert.equal(req.reasoningEffort, "max");
    assert.equal(req.composerInfinite, true);
    assert.equal(req.fullPermissions, true);
    assert.deepEqual(req.attachments, [{ path: stagedPath, name: "shot.png", kind: "image", mimeType: "image/png", sizeBytes: 12 }]);
  });

  it("setSessionProvider and setComposerPrefs reach the store", async () => {
    const socket = new FakeSocket();
    const store = fakeStore();
    const bridge = makeBridge({ socket, store, settings: { mode: "full" } });
    await bridge.start();
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "rp2", action: "setSessionProvider",
      payload: { sessionId: "s1", providerId: "deepseek" },
    })));
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "rc3", action: "setComposerPrefs",
      payload: { sessionId: "s1", patch: { infinite: true, reasoningEffort: "max" } },
    })));
    // Legacy console builds still send the Max boolean — mapped onto the dial.
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "rc4", action: "setComposerPrefs",
      payload: { sessionId: "s1", patch: { reasoningMax: false } },
    })));
    await new Promise((r) => setTimeout(r, 10));
    const calls = (store as unknown as { __calls: { setSessionProvider: unknown[][]; setComposerPrefs: unknown[][] } }).__calls;
    assert.deepEqual(calls.setSessionProvider, [["s1", "deepseek"]]);
    assert.deepEqual(calls.setComposerPrefs, [
      ["s1", { infinite: true, reasoningEffort: "max" }],
      ["s1", { reasoningEffort: "low" }],
    ]);
    for (const rid of ["rp2", "rc3", "rc4"]) {
      const res = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean }).find((m) => m.type === "res" && m.requestId === rid);
      assert.ok(res?.ok, `${rid} should succeed`);
    }
  });

  it("serves listPromptQueue in readonly mode but rejects queue mutations", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({ socket, settings: { mode: "readonly" } });
    await bridge.start();
    socket.emit("open");

    socket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "rq0", action: "listPromptQueue", payload: { sessionId: "s1" },
    })));
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "rq1", action: "enqueuePrompt",
      payload: { sessionId: "s1", userText: "hi" },
    })));
    await new Promise((r) => setTimeout(r, 10));
    const read = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; result?: unknown }).find((m) => m.type === "res" && m.requestId === "rq0");
    assert.ok(read?.ok);
    assert.equal((read?.result as Array<{ userText: string }>)[0].userText, "hi");

    const mutate = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; error?: string }).find((m) => m.type === "res" && m.requestId === "rq1");
    assert.ok(mutate && !mutate.ok);
    assert.equal(mutate?.error, REMOTE_READ_ONLY_ERROR);
  });

  it("maps a legacy steer mode to interrupt and forwards staged attachments", async () => {
    const socket = new FakeSocket();
    const store = fakeStore();
    const enqueued: unknown[] = [];
    const bridge = makeBridge({
      socket,
      store: { ...store, enqueuePrompt: (req: unknown) => { enqueued.push(req); return store.enqueuePrompt(req as never); } } as never,
      settings: { mode: "full" },
      deps: { remoteUploadDir: () => "/tmp/jellybot-remote-uploads" },
    });
    await bridge.start();
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "rq2", action: "enqueuePrompt",
      payload: {
        sessionId: "s1",
        userText: "while you're at it",
        mode: "steer",
        attachments: [{ path: "/tmp/jellybot-remote-uploads/1-a.png", name: "a.png", kind: "image", mimeType: "image/png" }],
      },
    })));
    await new Promise((r) => setTimeout(r, 10));
    const res = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; result?: { queued: { mode: string } } }).find((m) => m.type === "res" && m.requestId === "rq2");
    assert.ok(res?.ok);
    const req = enqueued[0] as Record<string, unknown>;
    assert.equal(req.mode, "interrupt");
    assert.equal((req.attachments as Array<{ name: string }>)[0].name, "a.png");
    assert.equal(res?.result?.queued.mode, "interrupt");
  });

  it("forwards enqueuePrompt with an explicit interrupt mode", async () => {
    const socket = new FakeSocket();
    const store = fakeStore();
    const enqueued: unknown[] = [];
    const bridge = makeBridge({
      socket,
      store: { ...store, enqueuePrompt: (req: unknown) => { enqueued.push(req); return store.enqueuePrompt(req as never); } } as never,
      settings: { mode: "full" },
    });
    await bridge.start();
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "rq-int", action: "enqueuePrompt",
      payload: { sessionId: "s1", userText: "pivot now", mode: "interrupt" },
    })));
    await new Promise((r) => setTimeout(r, 10));
    const res = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; result?: { queued: { mode: string } } }).find((m) => m.type === "res" && m.requestId === "rq-int");
    assert.ok(res?.ok);
    const req = enqueued[0] as Record<string, unknown>;
    assert.equal(req.mode, "interrupt");
    assert.equal(res?.result?.queued.mode, "interrupt");
  });

  it("rejects enqueuePrompt attachments outside the remote upload dir", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({
      socket,
      settings: { mode: "full" },
      deps: { remoteUploadDir: () => "/tmp/jellybot-remote-uploads" },
    });
    await bridge.start();
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "rq3", action: "enqueuePrompt",
      payload: {
        sessionId: "s1",
        userText: "with file",
        attachments: [{ path: "/Users/youyee/Secrets/keys.txt", name: "keys.txt", kind: "file", mimeType: "text/plain" }],
      },
    })));
    await new Promise((r) => setTimeout(r, 10));
    const res = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean; error?: string }).find((m) => m.type === "res" && m.requestId === "rq3");
    assert.ok(res && !res.ok);
    assert.match(res!.error!, /uploadAttachment/);
  });

  it("routes every queue mutation action with its promptId", async () => {
    const socket = new FakeSocket();
    const results: unknown[][] = [];
    const capture = (impl: (sessionId: string, promptId: string, text?: string) => { ok: boolean; items: []; args: unknown[] }) =>
      (sessionId: string, promptId: string, text?: string) => {
        const out = impl(sessionId, promptId, text);
        results.push(out.args);
        return out;
      };
    const store = fakeStore();
    const bridge = makeBridge({
      socket,
      store: {
        ...store,
        promoteQueuedPrompt: capture(store.promoteQueuedPrompt),
        deferQueuedPrompt: capture(store.deferQueuedPrompt),
        removeQueuedPrompt: capture(store.removeQueuedPrompt),
        moveQueuedPromptToFront: capture(store.moveQueuedPromptToFront),
        updateQueuedPromptText: capture(store.updateQueuedPromptText as never) as never,
      } as never,
      settings: { mode: "full" },
    });
    await bridge.start();
    socket.emit("open");
    const cases = [
      ["rq4", "promoteQueuedPrompt"],
      ["rq5", "deferQueuedPrompt"],
      ["rq6", "removeQueuedPrompt"],
      ["rq7", "moveQueuedPromptToFront"],
    ] as const;
    for (const [rid, action] of cases) {
      socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: rid, action, payload: { sessionId: "s1", promptId: "q1" } })));
    }
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "rq8", action: "updateQueuedPromptText",
      payload: { sessionId: "s1", promptId: "q1", text: "edited" },
    })));
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(results, [
      ["promote", "s1", "q1"],
      ["defer", "s1", "q1"],
      ["remove", "s1", "q1"],
      ["front", "s1", "q1"],
      ["text", "s1", "q1", "edited"],
    ]);
    for (const [rid] of [...cases, ["rq8"] as const]) {
      const res = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean }).find((m) => m.type === "res" && m.requestId === rid);
      assert.ok(res?.ok, `${rid} should succeed`);
    }
  });

  it("unknown action replies with an error", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({ socket });
    await bridge.start();
    socket.emit("open");

    socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: "r4", action: "nope" })));
    await new Promise((r) => setTimeout(r, 10));
    const res = socket.sent.map((s) => JSON.parse(s) as { type: string; requestId: string; ok: boolean }).find((m) => m.type === "res" && m.requestId === "r4");
    assert.ok(res && !res.ok);
  });

  it("forwards stream events only when connected", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({ socket });
    await bridge.start();
    // Before open: dropped silently.
    bridge.handleStreamEvent({ sessionId: "s1", event: { type: "text_delta", text: "x" } });
    assert.equal(socket.sent.length, 0);

    socket.emit("open");
    bridge.handleStreamEvent({ sessionId: "s1", event: { type: "text_delta", text: "hi" } });
    const ev = socket.sent.map((s) => JSON.parse(s) as { type: string }).find((m) => m.type === "event");
    assert.ok(ev);
  });

  it("stops reconnecting after an auth kick", async () => {
    const socket = new FakeSocket();
    const statuses: string[] = [];
    const timers: Array<() => void> = [];
    let connects = 0;
    const bridge = createRemoteBridge({
      store: fakeStore(),
      getSettings: () => ({ enabled: true, serverUrl: "ws://x", deviceId: "d-1234", deviceName: "N", mode: "full", pushActivity: "all" }),
      getApiKey: async () => "k",
      appVersion: () => "1",
      platform: () => "darwin",
      webSocketFactory: () => {
        connects += 1;
        return socket;
      },
      events: { onStatusChange: (s, d) => statuses.push(`${s}:${d ?? ""}`) },
      setTimeoutFn: (fn) => {
        timers.push(fn);
        return fn;
      },
      clearTimeoutFn: () => {},
    });
    await bridge.start();
    socket.emit("open");
    socket.emit("close", 4001, Buffer.from("bad api key"));
    assert.ok(statuses.some((s) => s.startsWith("error:")));
    // Firing every pending timer (stability timer included) must never
    // trigger a second connection attempt after a deliberate kick.
    for (const fn of [...timers]) fn();
    assert.equal(connects, 1, "no reconnect after auth kick");
  });

  it("stops without reconnecting on a replaced kick message", async () => {
    const sockets: FakeSocket[] = [];
    const statuses: string[] = [];
    const timers: Array<() => void> = [];
    const bridge = createRemoteBridge({
      store: fakeStore(),
      getSettings: () => ({ enabled: true, serverUrl: "ws://x", deviceId: "d-1234", deviceName: "N", mode: "full", pushActivity: "all" }),
      getApiKey: async () => "k",
      appVersion: () => "1",
      platform: () => "darwin",
      webSocketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      events: { onStatusChange: (s, d) => statuses.push(`${s}:${d ?? ""}`) },
      setTimeoutFn: (fn) => {
        timers.push(fn);
        return fn;
      },
      clearTimeoutFn: () => {},
    });
    await bridge.start();
    sockets[0]!.emit("open");
    sockets[0]!.emit("message", Buffer.from(JSON.stringify({ type: "kick", reason: "replaced by new connection" })));
    assert.ok(sockets[0]!.closed, "socket closed locally after the kick");
    assert.ok(
      statuses.some((s) => s.startsWith("stopped:") && s.includes("device ID is shared")),
      `status mentions the shared device ID: ${statuses.join(" | ")}`,
    );
    for (const fn of [...timers]) fn();
    assert.equal(sockets.length, 1, "no reconnect after a replaced kick");
  });

  it("treats close code 4409 as a terminal replaced kick", async () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    const bridge = createRemoteBridge({
      store: fakeStore(),
      getSettings: () => ({ enabled: true, serverUrl: "ws://x", deviceId: "d-1234", deviceName: "N", mode: "full", pushActivity: "all" }),
      getApiKey: async () => "k",
      appVersion: () => "1",
      platform: () => "darwin",
      webSocketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      setTimeoutFn: (fn) => {
        timers.push(fn);
        return fn;
      },
      clearTimeoutFn: () => {},
    });
    await bridge.start();
    sockets[0]!.emit("open");
    sockets[0]!.emit("close", 4409, Buffer.from("replaced by new connection"));
    assert.equal(bridge.status(), "stopped");
    for (const fn of [...timers]) fn();
    assert.equal(sockets.length, 1, "no reconnect after a 4409 close");
  });

  it("grows reconnect backoff until a connection proves stable", async () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const bridge = createRemoteBridge({
      store: fakeStore(),
      getSettings: () => ({ enabled: true, serverUrl: "ws://x", deviceId: "d-1234", deviceName: "N", mode: "full", pushActivity: "all" }),
      getApiKey: async () => "k",
      appVersion: () => "1",
      platform: () => "darwin",
      webSocketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      setTimeoutFn: (fn, ms) => {
        const handle = { fn, ms };
        timers.push(handle);
        return handle;
      },
      clearTimeoutFn: (t) => {
        const idx = timers.indexOf(t as { fn: () => void; ms: number });
        if (idx >= 0) timers.splice(idx, 1);
      },
    });
    await bridge.start();
    const cycle = () => {
      const s = sockets[sockets.length - 1]!;
      s.emit("open");
      s.emit("close", 1006, Buffer.from("")); // plain network drop
    };
    const fireReconnects = () => {
      for (const h of [...timers].filter((x) => x.ms < 10_000)) {
        h.fn();
        timers.splice(timers.indexOf(h), 1);
      }
    };
    // Three instant-death cycles: backoff must keep growing.
    const delays: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      cycle();
      delays.push(...timers.filter((x) => x.ms < 10_000).map((x) => x.ms));
      fireReconnects();
      // connect() awaits getApiKey() — let it create the next socket.
      await new Promise((r) => setTimeout(r, 0));
    }
    assert.deepEqual(delays, [1000, 2000, 4000], `backoff grows: ${delays.join(",")}`);
    // Let the stability timer fire while the socket is still open, then
    // drop it — the next reconnect is back at the base delay.
    const stable = sockets[sockets.length - 1]!;
    stable.emit("open");
    for (const h of [...timers]) {
      h.fn();
      timers.splice(timers.indexOf(h), 1);
    }
    stable.emit("close", 1006, Buffer.from(""));
    const reset = timers.filter((x) => x.ms < 10_000).map((x) => x.ms);
    assert.deepEqual(reset, [1000], "backoff resets after a stable connection");
  });

  it("pushActivity=off suppresses event forwarding", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({ socket, settings: { pushActivity: "off" } });
    await bridge.start();
    socket.emit("open");
    bridge.handleStreamEvent({ sessionId: "s1", event: { type: "text_delta", text: "x" } });
    assert.ok(!socket.sent.some((s) => s.includes('"event"')));
  });

  // ── E2EE v1 (frame sealing toward relays ≥ 1.5) ────────────────────────
  const TEST_KEY = deriveKey("jbr_test");

  it("hello advertises e2ee caps; welcome without caps stays plaintext", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({ socket });
    await bridge.start();
    socket.emit("open");
    const hello = socket.sent.map((s) => JSON.parse(s) as { type?: string; caps?: string[] }).find((m) => m.type === "hello");
    assert.deepEqual(hello?.caps, ["e2ee-v1"]);

    // Old relay: no caps in welcome → events stay plaintext.
    socket.emit("message", Buffer.from(JSON.stringify({ type: "welcome", viewers: 1 })));
    socket.emit("message", Buffer.from(JSON.stringify({ type: "presence", viewers: 1 })));
    bridge.handleStreamEvent({ sessionId: "s1", event: { type: "text_delta", text: "x" } });
    const ev = socket.sent.map((s) => JSON.parse(s) as { type?: string; sessionId?: string }).find((m) => m.type === "event");
    assert.equal(ev?.sessionId, "s1", "plaintext event on an old relay");
  });

  it("seals events after a caps-advertising welcome", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({ socket });
    await bridge.start();
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "welcome", viewers: 1, caps: ["e2ee-v1"] })));
    socket.emit("message", Buffer.from(JSON.stringify({ type: "presence", viewers: 1 })));
    bridge.handleStreamEvent({ sessionId: "s2", event: { type: "text_delta", text: "秘密 🐶" } });
    const ev = socket.sent.map((s) => JSON.parse(s) as { type?: string; enc?: unknown; sessionId?: string }).find((m) => m.type === "event");
    assert.equal(ev?.sessionId, undefined, "sessionId lives inside the envelope only");
    const d2r = new Cipher(TEST_KEY, "d2r");
    assert.deepEqual(d2r.open(ev?.enc)?.value, { sessionId: "s2", event: { type: "text_delta", text: "秘密 🐶" } });
  });

  it("unseals inbound requests and seals the response", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({ socket, settings: { mode: "full" } });
    await bridge.start();
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "welcome", viewers: 1, caps: ["e2ee-v1"] })));

    const r2d = new Cipher(TEST_KEY, "r2d");
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "req",
      requestId: "v1-q",
      action: "startTurn",
      enc: r2d.seal({ sessionId: "s1", userText: "加密任务" }),
    })));
    await new Promise((r) => setTimeout(r, 10));

    const res = socket.sent.map((s) => JSON.parse(s) as { type?: string; requestId?: string; ok?: boolean; enc?: unknown }).find((m) => m.type === "res");
    assert.equal(res?.requestId, "v1-q");
    assert.equal(res?.ok, true);
    const d2r = new Cipher(TEST_KEY, "d2r");
    assert.deepEqual((d2r.open(res?.enc)?.value as { result?: unknown }).result, { sessionId: "started:加密任务:false" });
  });

  it("answers an unreadable sealed request with a plaintext error", async () => {
    const socket = new FakeSocket();
    const bridge = makeBridge({ socket, settings: { mode: "full" } });
    await bridge.start();
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "welcome", viewers: 1, caps: ["e2ee-v1"] })));

    const r2d = new Cipher(TEST_KEY, "r2d");
    const env = r2d.seal({ sessionId: "s1" });
    const corrupted = Buffer.from(env.c, "base64");
    corrupted[2] ^= 0xff;
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "req",
      requestId: "bad",
      action: "startTurn",
      enc: { n: env.n, c: corrupted.toString("base64") },
    })));
    await new Promise((r) => setTimeout(r, 10));

    const res = socket.sent.map((s) => JSON.parse(s) as { type?: string; ok?: boolean; error?: string }).find((m) => m.type === "res");
    assert.equal(res?.ok, false);
    assert.match(String(res?.error), /unreadable/);
  });

  /** Heartbeat harness: manual timers keyed by delay, one fake socket. */
  function makeHeartbeatBridge(socket: WebSocketLike) {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const bridge = createRemoteBridge({
      store: fakeStore(),
      getSettings: () => ({
        enabled: true,
        serverUrl: "ws://relay.test",
        deviceId: "device-1234",
        deviceName: "Test Mac",
        mode: "readonly",
        pushActivity: "all",
      }),
      getApiKey: async () => "jbr_test",
      appVersion: () => "0.7.3",
      platform: () => "darwin",
      webSocketFactory: () => socket,
      setTimeoutFn: (fn, ms) => {
        const handle = { fn, ms };
        timers.push(handle);
        return handle;
      },
      clearTimeoutFn: (t) => {
        const idx = timers.indexOf(t as { fn: () => void; ms: number });
        if (idx >= 0) timers.splice(idx, 1);
      },
    });
    const fireNext = (ms: number): void => {
      const idx = timers.findIndex((t) => t.ms === ms);
      assert.ok(idx >= 0, `a ${ms}ms timer is scheduled`);
      const [handle] = timers.splice(idx, 1);
      handle!.fn();
    };
    return { bridge, timers, fireNext };
  }

  it("heartbeat: a missed pong terminates the zombie socket and reconnects", async () => {
    const socket = new FakeSocket();
    const { bridge, timers, fireNext } = makeHeartbeatBridge(socket);
    await bridge.start();
    socket.emit("open");
    // Cadence: the probe goes out on the ping interval…
    fireNext(HEARTBEAT_PING_MS);
    assert.equal(socket.pingCount, 1);
    // …and a missing pong tears the socket down locally. After a WAN
    // address change the hub's FIN never arrives — this is the only exit
    // from a half-open zombie (Pi, 2026-10-14: five hours of fake
    // "connected" heartbeats over a dead link).
    fireNext(HEARTBEAT_PONG_TIMEOUT_MS);
    assert.equal(socket.closed, true);
    // The teardown rides the normal close→reconnect path.
    socket.emit("close", 1006, Buffer.from(""));
    assert.ok(
      timers.some((t) => t.ms < 10_000),
      "reconnect scheduled after the heartbeat kill",
    );
    bridge.stop();
  });

  it("heartbeat: a pong cancels the deadline and the cadence continues", async () => {
    const socket = new FakeSocket();
    const { bridge, timers, fireNext } = makeHeartbeatBridge(socket);
    await bridge.start();
    socket.emit("open");
    fireNext(HEARTBEAT_PING_MS);
    assert.equal(socket.pingCount, 1);
    assert.ok(timers.some((t) => t.ms === HEARTBEAT_PONG_TIMEOUT_MS), "kill deadline armed");
    socket.emit("pong");
    assert.ok(
      !timers.some((t) => t.ms === HEARTBEAT_PONG_TIMEOUT_MS),
      "pong cleared the kill deadline",
    );
    assert.equal(socket.closed, false);
    fireNext(HEARTBEAT_PING_MS);
    assert.equal(socket.pingCount, 2);
    bridge.stop();
  });

  it("heartbeat: stop() clears the probe timers", async () => {
    const socket = new FakeSocket();
    const { bridge, timers } = makeHeartbeatBridge(socket);
    await bridge.start();
    socket.emit("open");
    assert.ok(timers.some((t) => t.ms === HEARTBEAT_PING_MS), "probe scheduled on open");
    bridge.stop();
    assert.ok(
      !timers.some((t) => t.ms === HEARTBEAT_PING_MS || t.ms === HEARTBEAT_PONG_TIMEOUT_MS),
      "no heartbeat timers survive stop()",
    );
  });

  it("heartbeat: sockets without ping() degrade to event-driven reconnects", async () => {
    class NoPingSocket extends FakeSocket {
      ping = undefined as unknown as () => void;
    }
    const socket = new NoPingSocket();
    const { bridge, timers } = makeHeartbeatBridge(socket);
    await bridge.start();
    socket.emit("open");
    assert.ok(
      !timers.some((t) => t.ms === HEARTBEAT_PING_MS),
      "no probe scheduled without a ping method",
    );
    bridge.stop();
  });

  it("provider sync actions respect full-control and never echo through readonly", async () => {
    const calls: string[] = [];
    const providerSync = {
      list: async () => {
        calls.push("list");
        return [{
          id: "p1",
          name: "GPT",
          baseUrl: "https://example.com/v1",
          modelId: "gpt-5",
          supportsMultimodal: false,
          imageInput: "url" as const,
          rawEndpoint: false,
          apiKeyConfigured: true,
        }];
      },
      exportOne: async (id: string) => {
        calls.push(`export:${id}`);
        return {
          id,
          name: "GPT",
          baseUrl: "https://example.com/v1",
          modelId: "gpt-5",
          apiKey: "sk-secret",
          supportsMultimodal: false,
          imageInput: "url" as const,
          rawEndpoint: false,
        };
      },
      upsert: async () => {
        calls.push("upsert");
        return { id: "p1", action: "overwritten" as const };
      },
      remove: async (baseUrl: string, modelId: string) => {
        calls.push(`remove:${baseUrl}:${modelId}`);
        return { removed: true, id: "p1" };
      },
      removeById: async (id: string) => {
        calls.push(`removeById:${id}`);
        if (id === "fail") throw new Error("Cannot remove the last LLM provider on this device.");
        return { removed: true, id };
      },
    };

    const roSocket = new FakeSocket();
    const roBridge = makeBridge({ socket: roSocket, deps: { providerSync } });
    await roBridge.start();
    roSocket.emit("open");
    roSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "l1", action: "listSyncProviders", payload: {},
    })));
    await new Promise((r) => setTimeout(r, 20));
    const listRes = roSocket.sent
      .map((s) => JSON.parse(s) as { type: string; requestId: string; ok?: boolean; result?: { providers: unknown[] } })
      .find((m) => m.type === "res" && m.requestId === "l1");
    assert.equal(listRes?.ok, true);
    assert.equal(listRes?.result?.providers.length, 1);
    assert.deepEqual(calls, ["list"]);

    roSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "e1", action: "exportSyncProvider", payload: { providerId: "p1" },
    })));
    await new Promise((r) => setTimeout(r, 20));
    const exportDenied = roSocket.sent
      .map((s) => JSON.parse(s) as { type: string; requestId: string; error?: string })
      .find((m) => m.type === "res" && m.requestId === "e1");
    assert.equal(exportDenied?.error, REMOTE_READ_ONLY_ERROR);
    roSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "d-ro", action: "removeSyncProvider", payload: { providerId: "p2" },
    })));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(roSocket.sent.map((s) => JSON.parse(s)).find((m) => m.requestId === "d-ro")?.error, REMOTE_READ_ONLY_ERROR);
    assert.equal(calls.some((call) => call.startsWith("remove")), false);

    const fullSocket = new FakeSocket();
    const fullBridge = makeBridge({
      socket: fullSocket,
      settings: { mode: "full" },
      deps: { providerSync },
    });
    await fullBridge.start();
    fullSocket.emit("open");
    fullSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "e2", action: "exportSyncProvider", payload: { providerId: "p1" },
    })));
    await new Promise((r) => setTimeout(r, 20));
    const exportOk = fullSocket.sent
      .map((s) => JSON.parse(s) as { type: string; requestId: string; ok?: boolean; result?: { apiKey?: string } })
      .find((m) => m.type === "res" && m.requestId === "e2");
    assert.equal(exportOk?.ok, true);
    assert.equal(exportOk?.result?.apiKey, "sk-secret");
    assert.ok(calls.includes("export:p1"));

    for (const [requestId, payload] of [
      ["d-id", { providerId: " p2 ", baseUrl: "https://ignored.example/v1", modelId: "ignored" }],
      ["d-legacy", { baseUrl: "https://example.com/v1", modelId: "gpt-5" }],
      ["d-invalid", { providerId: " ", baseUrl: "https://example.com/v1", modelId: "gpt-5" }],
      ["d-fail", { providerId: "fail" }],
    ] as const) {
      fullSocket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId, action: "removeSyncProvider", payload })));
    }
    await new Promise((r) => setTimeout(r, 20));
    const responses = fullSocket.sent.map((s) => JSON.parse(s));
    assert.deepEqual(responses.find((m) => m.requestId === "d-id")?.result, { removed: true, id: "p2" });
    assert.equal(responses.find((m) => m.requestId === "d-legacy")?.ok, true);
    assert.equal(responses.find((m) => m.requestId === "d-invalid")?.error, "providerId required");
    assert.match(responses.find((m) => m.requestId === "d-fail")?.error, /last LLM provider/);
    assert.deepEqual(calls.filter((call) => call.startsWith("remove")), [
      "removeById:p2", "remove:https://example.com/v1:gpt-5", "removeById:fail",
    ]);
    roBridge.stop();
    fullBridge.stop();
  });

  it("provider mutations notify the device and reassign sessions off a removed id", async () => {
    const reassigned: string[] = [];
    const upsertCalls: unknown[] = [];
    let providerChanges = 0;
    const providerSync = {
      list: async () => [],
      exportOne: async (id: string) => ({
        id,
        name: "GPT",
        baseUrl: "https://example.com/v1",
        modelId: "gpt-5",
        apiKey: "sk",
        supportsMultimodal: false,
        imageInput: "url" as const,
        rawEndpoint: false,
      }),
      upsert: async (transfer: unknown) => {
        upsertCalls.push(transfer);
        return { id: "p3", action: "added" as const };
      },
      remove: async () => ({ removed: false }),
      removeById: async (id: string) => {
        if (id === "fail") throw new Error("Cannot remove the last LLM provider on this device.");
        if (id === "missing") return { removed: false };
        return { removed: true, id };
      },
    };
    const socket = new FakeSocket();
    const bridge = makeBridge({
      socket,
      settings: { mode: "full" },
      store: {
        reassignSessionsUsingProvider: async (id: string) => {
          reassigned.push(id);
        },
      },
      deps: {
        providerSync,
        events: {
          onProvidersChanged: () => {
            providerChanges += 1;
          },
        },
      },
    });
    await bridge.start();
    socket.emit("open");

    const send = (requestId: string, action: string, payload: Record<string, unknown>) => {
      socket.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "req", requestId, action, payload })),
      );
    };
    send("up", "upsertSyncProvider", {
      name: "New",
      baseUrl: "https://example.com/v1",
      modelId: "gpt-5",
      apiKey: "sk",
      toolRoleImages: false,
    });
    send("rm", "removeSyncProvider", { providerId: "p2" });
    send("gone", "removeSyncProvider", { providerId: "missing" });
    send("bad", "removeSyncProvider", { providerId: "fail" });
    send("legacy", "removeSyncProvider", {
      baseUrl: "https://example.com/v1",
      modelId: "gpt-5",
    });
    await new Promise((r) => setTimeout(r, 30));

    const responses = socket.sent.map((raw) => JSON.parse(raw) as { requestId?: string; ok?: boolean });
    assert.equal(responses.find((m) => m.requestId === "up")?.ok, true);
    assert.equal(responses.find((m) => m.requestId === "rm")?.ok, true);
    assert.equal(responses.find((m) => m.requestId === "gone")?.ok, true);
    assert.equal(responses.find((m) => m.requestId === "bad")?.ok, false);
    assert.equal(responses.find((m) => m.requestId === "legacy")?.ok, true);
    assert.equal(providerChanges, 4);
    assert.deepEqual(reassigned, ["p2"]);
    assert.equal((upsertCalls[0] as { toolRoleImages?: boolean }).toolRoleImages, false);
    bridge.stop();
  });

  it("mcp sync actions respect full-control, readonly lists only, and surface mcpSync errors", async () => {
    const calls: string[] = [];
    const mcpSync = {
      list: () => {
        calls.push("list");
        return [{
          id: "s1",
          name: "Files",
          enabled: false,
          transport: { type: "stdio" as const, command: "npx" },
          secretConfigured: true,
          status: "disconnected" as const,
          toolCount: 0,
        }];
      },
      exportOne: (id: string) => {
        calls.push(`export:${id}`);
        if (id === "missing") throw new Error("MCP server not found.");
        return {
          id,
          name: "Files",
          enabled: false,
          transport: { type: "stdio" as const, command: "npx", env: { FS_KEY: "secret" } },
        };
      },
      upsert: async (transfer: { name: string }) => {
        calls.push(`upsert:${transfer.name}`);
        if (transfer.name === "fail") throw new Error("stdio command is required.");
        return { id: "s2", action: "overwritten" as const };
      },
      remove: async (serverId: string) => {
        calls.push(`remove:${serverId}`);
        return { removed: true, id: serverId };
      },
    };

    const roSocket = new FakeSocket();
    const roBridge = makeBridge({ socket: roSocket, deps: { mcpSync } });
    await roBridge.start();
    roSocket.emit("open");
    roSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "l1", action: "listSyncMcpServers", payload: {},
    })));
    await new Promise((r) => setTimeout(r, 20));
    const listRes = roSocket.sent
      .map((s) => JSON.parse(s) as { type: string; requestId: string; ok?: boolean; result?: { servers: unknown[] } })
      .find((m) => m.type === "res" && m.requestId === "l1");
    assert.equal(listRes?.ok, true);
    assert.equal(listRes?.result?.servers.length, 1);

    roSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "e1", action: "exportSyncMcpServer", payload: { serverId: "s1" },
    })));
    roSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "u1", action: "upsertSyncMcpServer", payload: { name: "Files", transport: { type: "stdio", command: "x" } },
    })));
    await new Promise((r) => setTimeout(r, 20));
    const roResponses = roSocket.sent.map((s) => JSON.parse(s) as { requestId?: string; error?: string });
    assert.equal(roResponses.find((m) => m.requestId === "e1")?.error, REMOTE_READ_ONLY_ERROR);
    assert.equal(roResponses.find((m) => m.requestId === "u1")?.error, REMOTE_READ_ONLY_ERROR);
    assert.deepEqual(calls, ["list"]);

    const fullSocket = new FakeSocket();
    const fullBridge = makeBridge({ socket: fullSocket, settings: { mode: "full" }, deps: { mcpSync } });
    await fullBridge.start();
    fullSocket.emit("open");
    fullSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "e2", action: "exportSyncMcpServer", payload: { serverId: "s1" },
    })));
    fullSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "e3", action: "exportSyncMcpServer", payload: { serverId: " " },
    })));
    fullSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "u2", action: "upsertSyncMcpServer",
      payload: { name: "Hub Files", enabled: false, transport: { type: "http", url: "https://mcp.example.com/mcp" } },
    })));
    fullSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "u3", action: "upsertSyncMcpServer", payload: { name: " ", transport: {} },
    })));
    fullSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "u4", action: "upsertSyncMcpServer", payload: { name: "fail" },
    })));
    fullSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "r1", action: "removeSyncMcpServer", payload: { serverId: " s1 " },
    })));
    fullSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "r2", action: "removeSyncMcpServer", payload: {},
    })));
    await new Promise((r) => setTimeout(r, 30));
    const responses = fullSocket.sent.map((s) => JSON.parse(s) as {
      requestId?: string; ok?: boolean; result?: { transport?: { env?: Record<string, string> }; action?: string }; error?: string;
    });
    assert.equal(responses.find((m) => m.requestId === "e2")?.result?.transport?.env?.FS_KEY, "secret");
    assert.equal(responses.find((m) => m.requestId === "e3")?.error, "serverId required");
    assert.deepEqual(responses.find((m) => m.requestId === "u2")?.result, { id: "s2", action: "overwritten" });
    assert.equal(responses.find((m) => m.requestId === "u3")?.error, "name required");
    assert.match(responses.find((m) => m.requestId === "u4")?.error, /command is required/);
    assert.deepEqual(responses.find((m) => m.requestId === "r1")?.result, { removed: true, id: "s1" });
    assert.equal(responses.find((m) => m.requestId === "r2")?.error, "serverId required");
    assert.deepEqual(calls, [
      "list", "export:s1", "upsert:Hub Files", "upsert:fail", "remove:s1",
    ]);
    roBridge.stop();
    fullBridge.stop();
  });

  it("skill sync actions respect full-control, readonly lists only, and surface skillSync errors", async () => {
    const calls: string[] = [];
    const skillSync = {
      list: () => {
        calls.push("list");
        return [{
          id: "k1",
          name: "alpha",
          enabled: true,
          description: "Alpha skill.",
          fileCount: 2,
        }];
      },
      exportOne: (id: string) => {
        calls.push(`export:${id}`);
        if (id === "missing") throw new Error("Skill not found.");
        return {
          id,
          name: "alpha",
          enabled: true,
          description: "Alpha skill.",
          zipBase64: "UEsDBAoAAAAAAA==",
        };
      },
      upsert: async (transfer: { name: string }) => {
        calls.push(`upsert:${transfer.name}`);
        if (transfer.name === "fail") throw new Error("Skill package is too large to sync (max 8 MB).");
        return { id: "k2", action: "overwritten" as const, fileCount: 3 };
      },
      remove: async (skillId: string) => {
        calls.push(`remove:${skillId}`);
        return { removed: true, id: skillId };
      },
    };

    const roSocket = new FakeSocket();
    const roBridge = makeBridge({ socket: roSocket, deps: { skillSync } });
    await roBridge.start();
    roSocket.emit("open");
    roSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "l1", action: "listSyncSkills", payload: {},
    })));
    await new Promise((r) => setTimeout(r, 20));
    const listRes = roSocket.sent
      .map((s) => JSON.parse(s) as { type: string; requestId: string; ok?: boolean; result?: { skills: unknown[] } })
      .find((m) => m.type === "res" && m.requestId === "l1");
    assert.equal(listRes?.ok, true);
    assert.equal(listRes?.result?.skills.length, 1);

    roSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "e1", action: "exportSyncSkill", payload: { skillId: "k1" },
    })));
    roSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "u1", action: "upsertSyncSkill", payload: { name: "alpha", zipBase64: "UEsDBAoAAAAAAA==" },
    })));
    await new Promise((r) => setTimeout(r, 20));
    const roResponses = roSocket.sent.map((s) => JSON.parse(s) as { requestId?: string; error?: string });
    assert.equal(roResponses.find((m) => m.requestId === "e1")?.error, REMOTE_READ_ONLY_ERROR);
    assert.equal(roResponses.find((m) => m.requestId === "u1")?.error, REMOTE_READ_ONLY_ERROR);
    assert.deepEqual(calls, ["list"]);

    const fullSocket = new FakeSocket();
    const fullBridge = makeBridge({ socket: fullSocket, settings: { mode: "full" }, deps: { skillSync } });
    await fullBridge.start();
    fullSocket.emit("open");
    fullSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "e2", action: "exportSyncSkill", payload: { skillId: "k1" },
    })));
    fullSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "e3", action: "exportSyncSkill", payload: { skillId: " " },
    })));
    fullSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "u2", action: "upsertSyncSkill",
      payload: { name: "alpha", enabled: false, zipBase64: "UEsDBAoAAAAAAA==" },
    })));
    fullSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "u3", action: "upsertSyncSkill", payload: { name: " ", zipBase64: "x" },
    })));
    fullSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "u4", action: "upsertSyncSkill", payload: { name: "alpha" },
    })));
    fullSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "u5", action: "upsertSyncSkill", payload: { name: "fail", zipBase64: "x" },
    })));
    fullSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "r1", action: "removeSyncSkill", payload: { skillId: " k1 " },
    })));
    fullSocket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "r2", action: "removeSyncSkill", payload: {},
    })));
    await new Promise((r) => setTimeout(r, 30));
    const responses = fullSocket.sent.map((s) => JSON.parse(s) as {
      requestId?: string; ok?: boolean; result?: { zipBase64?: string; action?: string; fileCount?: number }; error?: string;
    });
    assert.equal(responses.find((m) => m.requestId === "e2")?.result?.zipBase64, "UEsDBAoAAAAAAA==");
    assert.equal(responses.find((m) => m.requestId === "e3")?.error, "skillId required");
    assert.deepEqual(responses.find((m) => m.requestId === "u2")?.result, {
      id: "k2", action: "overwritten", fileCount: 3,
    });
    assert.equal(responses.find((m) => m.requestId === "u3")?.error, "name required");
    assert.equal(responses.find((m) => m.requestId === "u4")?.error, "zipBase64 required");
    assert.match(responses.find((m) => m.requestId === "u5")?.error, /too large/);
    assert.deepEqual(responses.find((m) => m.requestId === "r1")?.result, { removed: true, id: "k1" });
    assert.equal(responses.find((m) => m.requestId === "r2")?.error, "skillId required");
    assert.deepEqual(calls, [
      "list", "export:k1", "upsert:alpha", "upsert:fail", "remove:k1",
    ]);
    roBridge.stop();
    fullBridge.stop();
  });

  it("notifyProvidersChanged pushes providers_changed (sealed under E2EE, gated by pushActivity=off)", async () => {
    // Sealed relay: welcome advertises e2ee-v1 → the frame carries enc only.
    const socket = new FakeSocket();
    let fired = 0;
    const bridge = makeBridge({ socket, deps: { events: { onProvidersChanged: () => { fired += 1; } } } });
    await bridge.start();
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "welcome", viewers: 1, caps: ["e2ee-v1"] })));

    bridge.notifyProvidersChanged();
    const sealed = socket.sent
      .map((raw) => JSON.parse(raw) as { type?: string; enc?: unknown; sessionId?: string; event?: { type?: string } })
      .filter((m) => m.type === "event");
    assert.equal(sealed.length, 1);
    assert.equal(sealed[0]!.sessionId, undefined, "payload lives inside the envelope only");
    const d2r = new Cipher(TEST_KEY, "d2r");
    assert.deepEqual(d2r.open(sealed[0]!.enc)?.value, { sessionId: "", event: { type: "providers_changed" } });
    assert.equal(fired, 1, "local renderer still gets onProvidersChanged");
    bridge.stop();

    // Old relay: no caps → plaintext frame.
    const plainSocket = new FakeSocket();
    const plainBridge = makeBridge({ socket: plainSocket });
    await plainBridge.start();
    plainSocket.emit("open");
    plainSocket.emit("message", Buffer.from(JSON.stringify({ type: "welcome", viewers: 0 })));
    plainBridge.notifyProvidersChanged();
    const plain = plainSocket.sent
      .map((raw) => JSON.parse(raw) as { type?: string; sessionId?: string; event?: { type?: string } })
      .filter((m) => m.type === "event");
    assert.equal(plain.length, 1);
    assert.equal(plain[0]!.event?.type, "providers_changed");
    assert.equal(plain[0]!.sessionId, "");
    assert.equal(fired, 1);
    plainBridge.stop();

    // pushActivity=off is the kill switch — nothing leaves the machine.
    const offSocket = new FakeSocket();
    const offBridge = makeBridge({ socket: offSocket, settings: { pushActivity: "off" } });
    await offBridge.start();
    offSocket.emit("open");
    offBridge.notifyProvidersChanged();
    assert.equal(offSocket.sent.filter((raw) => (JSON.parse(raw) as { type?: string }).type === "event").length, 0);
    offBridge.stop();
  });

  // ── CoCo actions (cocoSnapshot / cocoCommand) ──────────────────

  it("serves cocoSnapshot in read-only mode and pulses onActivity", async () => {
    const socket = new FakeSocket();
    const pulses: number[] = [];
    const snapshot = {
      state: "idle", settings: { enabled: true }, budget: { hourly: 0, daily: 0, estimated: false },
      work: [], rules: [], messages: [], reports: [],
    };
    const bridge = makeBridge({
      socket,
      deps: {
        getCoco: () => ({ snapshot: () => snapshot, command: () => {} }),
        events: { onActivity: () => pulses.push(1) },
      },
    });
    await bridge.start();
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: "cs1", action: "cocoSnapshot" })));
    await new Promise((r) => setTimeout(r, 10));
    const res = socket.sent
      .map((s) => JSON.parse(s) as { type?: string; requestId?: string; ok?: boolean; result?: unknown })
      .find((m) => m.type === "res" && m.requestId === "cs1");
    assert.equal(res?.ok, true);
    assert.deepEqual(res?.result, snapshot);
    // House rule (decision #9): a frame leaving for the relay pulses the button.
    assert.ok(pulses.length >= 1);
    bridge.stop();
  });

  it("answers unknown action when no CoCo engine is bound (or null)", async () => {
    // No getCoco dep at all — agentd builds.
    const socketA = new FakeSocket();
    const bridgeA = makeBridge({ socket: socketA, settings: { mode: "full" } });
    await bridgeA.start();
    socketA.emit("open");
    socketA.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: "cs2", action: "cocoSnapshot" })));
    await new Promise((r) => setTimeout(r, 10));
    const resA = socketA.sent
      .map((s) => JSON.parse(s) as { type?: string; requestId?: string; ok?: boolean; error?: string })
      .find((m) => m.type === "res" && m.requestId === "cs2");
    assert.equal(resA?.ok, false);
    assert.match(String(resA?.error), /unknown action: cocoSnapshot/);
    bridgeA.stop();

    // getCoco present but null — desktop before the service starts.
    const socketB = new FakeSocket();
    const bridgeB = makeBridge({ socket: socketB, settings: { mode: "full" }, deps: { getCoco: () => null } });
    await bridgeB.start();
    socketB.emit("open");
    socketB.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "cs3", action: "cocoCommand",
      payload: { command: { type: "chat", text: "hi" } },
    })));
    await new Promise((r) => setTimeout(r, 10));
    const resB = socketB.sent
      .map((s) => JSON.parse(s) as { type?: string; requestId?: string; ok?: boolean; error?: string })
      .find((m) => m.type === "res" && m.requestId === "cs3");
    assert.equal(resB?.ok, false);
    assert.match(String(resB?.error), /unknown action: cocoCommand/);
    bridgeB.stop();
  });

  it("forwards cocoCommand in full-control mode and rejects malformed payloads", async () => {
    const socket = new FakeSocket();
    const commands: unknown[] = [];
    const pulses: number[] = [];
    const bridge = makeBridge({
      socket,
      settings: { mode: "full" },
      deps: {
        getCoco: () => ({ snapshot: () => ({}), command: (c: unknown) => commands.push(c) }),
        events: { onActivity: () => pulses.push(1) },
      },
    });
    await bridge.start();
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "cc1", action: "cocoCommand",
      payload: { command: { type: "chat", text: "hello" } },
    })));
    await new Promise((r) => setTimeout(r, 10));
    const res = socket.sent
      .map((s) => JSON.parse(s) as { type?: string; requestId?: string; ok?: boolean; result?: unknown })
      .find((m) => m.type === "res" && m.requestId === "cc1");
    assert.equal(res?.ok, true);
    assert.deepEqual(res?.result, { accepted: true });
    assert.deepEqual(commands, [{ type: "chat", text: "hello" }]);
    assert.ok(pulses.length >= 1);

    socket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "cc2", action: "cocoCommand",
      payload: { command: {} },
    })));
    await new Promise((r) => setTimeout(r, 10));
    const bad = socket.sent
      .map((s) => JSON.parse(s) as { type?: string; requestId?: string; ok?: boolean; error?: string })
      .find((m) => m.type === "res" && m.requestId === "cc2");
    assert.equal(bad?.ok, false);
    assert.equal(bad?.error, "command required");
    assert.equal(commands.length, 1);
    bridge.stop();
  });

  it("refuses cocoCommand in read-only mode", async () => {
    const socket = new FakeSocket();
    let commanded = 0;
    const bridge = makeBridge({
      socket,
      deps: { getCoco: () => ({ snapshot: () => ({}), command: () => { commanded += 1; } }) },
    });
    await bridge.start();
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "req", requestId: "cc3", action: "cocoCommand",
      payload: { command: { type: "chat", text: "hi" } },
    })));
    await new Promise((r) => setTimeout(r, 10));
    const res = socket.sent
      .map((s) => JSON.parse(s) as { type?: string; requestId?: string; ok?: boolean; error?: string })
      .find((m) => m.type === "res" && m.requestId === "cc3");
    assert.equal(res?.ok, false);
    assert.equal(res?.error, REMOTE_READ_ONLY_ERROR);
    assert.equal(commanded, 0);
    bridge.stop();
  });

  it("listSessions passes includeCoco through", async () => {
    const socket = new FakeSocket();
    const seen: Array<boolean | undefined> = [];
    const summary = (id: string) => ({ id, title: "T", updatedAt: 1, status: "idle", progressText: "", type: "agent", messageCount: 2, workspaceId: "w", archived: false, archivedAt: null });
    const bridge = makeBridge({
      socket,
      store: {
        listSessions: ((includeCoco?: boolean) => {
          seen.push(includeCoco);
          return [summary("s1")];
        }) as never,
      },
    });
    await bridge.start();
    socket.emit("open");
    // The connect-time busy-count push already called listSessions() once.
    socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: "ls1", action: "listSessions", payload: { includeCoco: true } })));
    await new Promise((r) => setTimeout(r, 10));
    socket.emit("message", Buffer.from(JSON.stringify({ type: "req", requestId: "ls2", action: "listSessions" })));
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(seen.slice(-2), [true, false]);
    bridge.stop();
  });

  it("pulses onActivity for status and providers pushes (house rule #9)", async () => {
    const socket = new FakeSocket();
    const pulses: number[] = [];
    const bridge = makeBridge({ socket, deps: { events: { onActivity: () => pulses.push(1) } } });
    await bridge.start();
    socket.emit("open");
    // providers_changed push → pulse.
    let before = pulses.length;
    bridge.notifyProvidersChanged();
    assert.ok(pulses.length > before, "providers push should pulse");
    // maintenance status push → pulse.
    before = pulses.length;
    (bridge as unknown as { pushMaintenanceState(state: unknown): void }).pushMaintenanceState({
      phase: "running", id: "u1", source: "test", version: "1", error: "", logTail: "", ts: 1,
    });
    assert.ok(pulses.length > before, "maintenance push should pulse");
    bridge.stop();
  });
});
