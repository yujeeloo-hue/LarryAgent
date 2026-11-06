import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const moduleLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.includes("?raw")) return "";
  return moduleLoad.call(this, request, parent, isMain);
};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  CSS: { escape: (value: string) => value },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  ResizeObserver: class { observe() {} disconnect() {} },
});

type Controller = import("./SubagentsWindowController.js").SubagentsWindowController;
let SubagentsWindowController: new () => Controller;

test.before(async () => {
  ({ SubagentsWindowController } = await import(
    "./SubagentsWindowController.js"
  ));
});
test.afterEach(() => document.body.replaceChildren());

type RunSummaryFixture = {
  id: string;
  batchId: string;
  name: string;
  role: string;
  priority: number;
  status: "queued" | "running" | "completed" | "error" | "cancelled";
  progressText: string;
  parentToolCallId: string;
  createdAt: number;
  updatedAt: number;
};

function runFixture(overrides: Partial<RunSummaryFixture> = {}): RunSummaryFixture {
  return {
    id: "run-1",
    batchId: "batch-1",
    name: "relay-e2e-check",
    role: "explore",
    priority: 50,
    status: "running",
    progressText: "Checking",
    parentToolCallId: "call_1",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

/**
 * Subagent Message[] exactly as loadSubagentMessages / the live manager
 * returns it: user prompt, assistant with tool_call part, tool result
 * message, final assistant text. Rendering must go through the real
 * conversation pipeline (tool cards merge tool results).
 */
function transcriptFixture(): Array<{ id: string; role: string; createdAt: number; toolCallId?: string; parts: Array<Record<string, unknown>> }> {
  return [
    {
      id: "m1",
      role: "user",
      createdAt: 1000,
      parts: [{ type: "text", text: "Compare relay health endpoints." }],
    },
    {
      id: "m2",
      role: "assistant",
      createdAt: 1001,
      parts: [
        { type: "text", text: "Checking both origins." },
        {
          type: "tool_call",
          id: "call_1",
          name: "run_shell",
          status: "done",
          arguments: { command: "curl -s localhost:8787/health" },
        },
      ],
    },
    {
      id: "m3",
      role: "tool",
      createdAt: 1002,
      toolCallId: "call_1",
      parts: [
        {
          type: "tool_result",
          toolCallId: "call_1",
          returnCode: 0,
          content: [{ type: "text", text: '{"ok":true,"version":"1.5.7"}' }],
        },
      ],
    },
    {
      id: "m4",
      role: "assistant",
      createdAt: 1003,
      parts: [{ type: "text", text: "Both report 1.5.7." }],
    },
  ];
}

function installBridge(fixtures: {
  runs: RunSummaryFixture[];
  messages: ReturnType<typeof transcriptFixture>;
}): {
  controller: Controller;
  streamHandlers: Array<(payload: unknown) => void>;
} {
  const streamHandlers: Array<(payload: unknown) => void> = [];
  (globalThis as { jellybot?: unknown }).jellybot = {
    platform: "darwin",
    listSubagents: async () => fixtures.runs,
    getSubagentTranscript: async () => ({
      run: fixtures.runs[0],
      messages: fixtures.messages,
    }),
    getSession: async () => null,
    onAgentStream: (handler: (payload: unknown) => void) => {
      streamHandlers.push(handler);
      return () => {};
    },
    openPath: async () => "",
    showItemInFolder: async () => true,
  };
  const controller = new SubagentsWindowController();
  controller.mount(document.body);
  return { controller, streamHandlers };
}

test("renders runs as tabs with role badges and reuses conversation rows", async () => {
  const runs = [
    runFixture({ id: "run-1", role: "explore", status: "running" }),
    runFixture({ id: "run-2", name: "sha-verify", role: "worker", status: "completed", createdAt: 2000 }),
  ];
  const { controller } = installBridge({ runs, messages: transcriptFixture() });
  controller.setSession("session-1");
  await new Promise((resolve) => setTimeout(resolve, 20));

  const tabs = document.querySelectorAll(".subagents-tab");
  assert.equal(tabs.length, 2);
  const active = document.querySelector(".subagents-tab.is-active");
  assert.ok(active, "one active tab");
  // Live run is preferred over the terminal one.
  assert.equal(active?.querySelector(".subagents-tab-label")?.textContent, "relay-e2e-check");
  const badges = document.querySelectorAll(".subagents-tab-role");
  assert.equal(badges[0]?.getAttribute("data-role"), "explore");
  assert.equal(badges[1]?.getAttribute("data-role"), "worker");

  // No blinking status dot anywhere; terminal tabs carry a circle mark
  // (completed → check) in the spinner slot instead.
  assert.equal(document.querySelectorAll(".subagents-tab-dot").length, 0);
  const terminalMarks = document.querySelectorAll(".subagents-tab-terminal");
  assert.equal(terminalMarks.length, 2);
  assert.equal(terminalMarks[1]?.getAttribute("data-status"), "completed");
  assert.ok(terminalMarks[1]?.querySelector("svg"), "completed tab has check glyph");

  // Transcript reuses the conversation projection: user bubble, the line
  // before the shell call, and the final reply all stay visible; only the
  // tool call itself folds into a Thinking hint chip.
  const turn = document.querySelector(".conversation-turn");
  assert.ok(turn, "conversation-turn wrapper");
  assert.ok(document.querySelector(".conversation-msg-user"), "user bubble");
  assert.equal(
    document.querySelectorAll(".content-card-tool-invocation[data-tool-name='run_shell']").length,
    0,
  );
  assert.equal(document.querySelectorAll(".conversation-msg-tool").length, 0);
  const text = Array.from(
    document.querySelectorAll(".message-part-text"),
    (node) => node.textContent ?? "",
  ).join("|");
  assert.match(text, /Both report 1\.5\.7\./);
  assert.match(
    text,
    /Checking both origins/,
    "reply text stays in the column (never folded into Thinking)",
  );
  const thought = document.querySelector("[data-turn-reasoning='1']");
  assert.doesNotMatch(
    thought?.querySelector(".conversation-reasoning-cot")?.textContent ?? "",
    /Checking both origins/,
    "reply prose never folds into the Thinking body",
  );
  // Historical projection: folded calls land in the expandable tool log, verb
  // on the icon row and the object in the detail cell.
  const toolRow = thought?.querySelector(".conversation-reasoning-toollog-row");
  assert.equal(
    toolRow?.getAttribute("title"),
    "Shell curl -s localhost:8787/health",
    "record keeps the full hint (verb included)",
  );
  assert.match(
    thought?.querySelector(".conversation-reasoning-toollog-detail")?.textContent ?? "",
    /^curl -s localhost:8787\/health$/,
  );

  // Running run keeps a single spinner node per tab (no duplicates).
  const spinners = tabs[0]?.querySelectorAll(".subagents-tab-spinner");
  assert.equal(spinners?.length, 1);
  controller.dispose();
});

test("manual tab selection survives refreshes while a newer live run exists", async () => {
  // run-1 older+completed, run-2 newer+running: auto-follow would normally
  // yank a manual run-1 selection back to run-2 on every throttled refresh.
  const runs = [
    runFixture({ id: "run-1", status: "completed", createdAt: 1000 }),
    runFixture({ id: "run-2", name: "sha-verify", role: "worker", status: "running", createdAt: 2000 }),
  ];
  const { controller, streamHandlers } = installBridge({ runs, messages: transcriptFixture() });
  controller.setSession("session-1");
  await new Promise((resolve) => setTimeout(resolve, 20));

  const tabs = document.querySelectorAll(".subagents-tab");
  (tabs[0] as unknown as HTMLButtonElement).click(); // manual pick run-1
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    document.querySelector(".subagents-tab.is-active .subagents-tab-label")?.textContent,
    "relay-e2e-check",
  );

  // Stream event → throttled refresh → applyRuns: selection must stick.
  streamHandlers[0]!({
    sessionId: "session-1",
    event: { type: "subagent_live", id: "run-2", kind: "delta", text: "x" },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    document.querySelector(".subagents-tab.is-active .subagents-tab-label")?.textContent,
    "relay-e2e-check",
    "manual selection sticks across refresh",
  );
  controller.dispose();
});

test("completed tabs compact by age, fresh ones stay full", async () => {
  const runs = [
    // finished long ago → narrow (icon + label) immediately on open
    runFixture({ id: "run-1", status: "completed", createdAt: 1000, updatedAt: 1000 }),
    // just finished → full-width tab until the 10s deadline
    runFixture({ id: "run-2", name: "sha-verify", role: "worker", status: "completed", createdAt: 2000, updatedAt: Date.now() }),
    // live → never compact
    runFixture({ id: "run-3", name: "live-check", role: "general", status: "running", createdAt: 3000, updatedAt: Date.now() }),
  ];
  const { controller } = installBridge({ runs, messages: transcriptFixture() });
  controller.setSession("session-1");
  await new Promise((resolve) => setTimeout(resolve, 20));

  const compact = document.querySelectorAll(".subagents-tab.is-compact");
  assert.equal(compact.length, 1, "only the long-completed tab is compact");
  assert.equal((compact[0] as HTMLElement).dataset.runId, "run-1");
  // Compact is a width treatment only — the badge node stays (animates shut).
  assert.ok(compact[0]?.querySelector(".subagents-tab-role"));
  controller.dispose();
});

test("live delta paints a streaming tail and pruning clears it", async () => {
  const runs = [runFixture({ status: "running" })];
  const messages = transcriptFixture();
  const { controller, streamHandlers } = installBridge({ runs, messages });
  controller.setSession("session-1");
  await new Promise((resolve) => setTimeout(resolve, 20));

  streamHandlers[0]!({
    sessionId: "session-1",
    event: {
      type: "subagent_live",
      id: "run-1",
      name: "relay-e2e-check",
      role: "explore",
      status: "running",
      kind: "delta",
      text: " Still hashing…",
    },
  });
  const tail = document.querySelector(".subagents-tail-host .subagents-tail");
  assert.ok(tail, "live tail rendered");
  assert.ok(tail.textContent.includes("Still hashing"));

  // Committed text now covers the tail length → pruned on next refresh.
  const bridge = (globalThis as { jellybot: { getSubagentTranscript: unknown } }).jellybot;
  const refreshed = transcriptFixture().map((message) =>
    message.id === "m4"
      ? { ...message, parts: [{ type: "text", text: "Both report 1.5.7. Still hashing…" }] }
      : message,
  );
  (bridge as { getSubagentTranscript: () => Promise<unknown> }).getSubagentTranscript =
    async () => ({ run: runs[0], messages: refreshed });
  (controller as unknown as { refresh: (o?: { immediate?: boolean }) => Promise<void> }).refresh({
    immediate: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(document.querySelector(".subagents-tail-host"), null, "tail pruned");
  controller.dispose();
});

test("ignores stream events for other sessions", async () => {
  const runs = [runFixture({ status: "running" })];
  const { controller, streamHandlers } = installBridge({ runs, messages: transcriptFixture() });
  controller.setSession("session-1");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const before = document.querySelectorAll(".subagents-tail-host").length;
  streamHandlers[0]!({
    sessionId: "other-session",
    event: { type: "subagent_live", id: "run-1", kind: "delta", text: "noise" },
  });
  assert.equal(document.querySelectorAll(".subagents-tail-host").length, before);
  controller.dispose();
});
