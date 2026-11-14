/**
 * DOM tests: Terminal pane agent shell mirror — Dev Mode session's
 * run_shell / exec_command calls echoed read-only into the panel.
 *
 * Covers session filtering, input-box presentation (command staged →
 * flash → clear → start line), result rendering + divider via
 * getSession, head+tail truncation, terminal-status and session-switch
 * sealing, busy/draft guards, auto-open hook, and busy-state isolation.
 * Presentation timings are zeroed so the queue settles within ticks.
 */
import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

(
  Module as unknown as { _extensions: Record<string, () => void> }
)._extensions[".css"] = () => {};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
});

type StreamHandler = (payload: {
  sessionId: string;
  event: Record<string, unknown>;
}) => void;

/** Minimal jellybot bridge mock — only the surface the pane touches. */
const bridge: {
  streamHandlers: StreamHandler[];
  sessions: Map<string, unknown>;
} = {
  streamHandlers: [],
  sessions: new Map(),
};

(window as unknown as { jellybot: unknown }).jellybot = {
  onTerminalOutput: () => () => {},
  onTerminalDone: () => () => {},
  onAgentStream: (h: StreamHandler) => {
    bridge.streamHandlers.push(h);
    return () => {
      bridge.streamHandlers = bridge.streamHandlers.filter((x) => x !== h);
    };
  },
  getSession: async (sessionId: string) =>
    bridge.sessions.get(sessionId) ?? null,
};

type TerminalPaneControllerT =
  typeof import("./TerminalPaneController.js")["TerminalPaneController"];
type TerminalPaneViewT = typeof import("./TerminalPaneView.js")["TerminalPaneView"];
let TerminalPaneController: TerminalPaneControllerT;
let TerminalPaneView: TerminalPaneViewT;

test.before(async () => {
  const mod = await import("./TerminalPaneController.js");
  ({ TerminalPaneController } = mod);
  ({ TerminalPaneView } = await import("./TerminalPaneView.js"));
  // Zero the presentation timings — the queue settles within timer ticks.
  Object.assign(mod.MIRROR_PRESENT_TIMINGS, {
    typeMsPerChar: 0,
    holdMs: 0,
    instantHoldMs: 0,
    flashMs: 0,
  });
});

function fresh(sessionId: string | null = "sess-1"): {
  view: TerminalPaneViewT;
  controller: TerminalPaneControllerT;
} {
  bridge.streamHandlers = [];
  bridge.sessions.clear();
  const view = new TerminalPaneView();
  const controller = new TerminalPaneController(view);
  controller.setMirrorSession(sessionId);
  return { view, controller };
}

function emit(sessionId: string, event: Record<string, unknown>): void {
  for (const h of [...bridge.streamHandlers]) h({ sessionId, event });
}

function shellCall(id: string, command = "echo hi"): Record<string, unknown> {
  return {
    type: "tool_call",
    id,
    name: "run_shell",
    arguments: { command },
    argumentsRaw: "{}",
  };
}

function chunks(view: TerminalPaneViewT): HTMLElement[] {
  return [...view.outputEl.querySelectorAll(".terminal-pane-chunk")];
}

function dividerCount(view: TerminalPaneViewT): number {
  return view.outputEl.querySelectorAll(".terminal-pane-divider").length;
}

async function waitUntil(
  cond: () => boolean,
  ms = 2000,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitUntil timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sessionWithToolResult(toolCallId: string, text: string): unknown {
  return {
    id: "sess-1",
    messages: [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            id: toolCallId,
            name: "run_shell",
            status: "done",
            arguments: { command: "echo hi" },
            argumentsRaw: "{}",
          },
        ],
      },
      {
        id: "m2",
        role: "tool",
        toolCallId,
        parts: [
          {
            type: "tool_result",
            toolCallId,
            returnCode: 0,
            content: [{ type: "text", text }],
          },
        ],
      },
    ],
  };
}

test("mirrors only the bound session's shell calls (start line)", async () => {
  const { view } = fresh("sess-1");
  emit("sess-2", shellCall("t-other", "echo other"));
  assert.equal(chunks(view).length, 0, "other session is ignored");

  emit("sess-1", shellCall("t1"));
  await waitUntil(() => chunks(view).length === 1);
  const start = chunks(view).at(-1);
  assert.ok(start, "start line appended");
  assert.equal(start.className, "terminal-pane-chunk is-agent");
  assert.equal(start.textContent, "[agent] $ echo hi\n");
  assert.equal(dividerCount(view), 0, "no divider until the result lands");
});

test("ignores non-shell tools and empty commands", () => {
  const { view } = fresh("sess-1");
  emit("sess-1", {
    type: "tool_call",
    id: "r1",
    name: "read_file",
    arguments: { path: "/tmp/x" },
    argumentsRaw: "{}",
  });
  emit("sess-1", {
    type: "tool_call",
    id: "r2",
    name: "run_shell",
    arguments: { command: "   " },
    argumentsRaw: "{}",
  });
  emit("sess-1", {
    type: "tool_call",
    id: "r3",
    name: "run_shell",
    arguments: {},
    argumentsRaw: "{}",
  });
  assert.equal(chunks(view).length, 0);
});

test("echoes exec_command (Windows shell tool name)", async () => {
  const { view } = fresh("sess-1");
  emit("sess-1", {
    type: "tool_call",
    id: "w1",
    name: "exec_command",
    arguments: { command: "dir" },
    argumentsRaw: "{}",
  });
  await waitUntil(() => chunks(view).length === 1);
  assert.equal(chunks(view).at(-1)?.textContent, "[agent] $ dir\n");
});

test("stages the command in the input, then clears it", async () => {
  const { view } = fresh("sess-1");
  const staged: string[] = [];
  const original = view.setCommand.bind(view);
  view.setCommand = (value: string) => {
    staged.push(value);
    original(value);
  };

  emit("sess-1", shellCall("t-stage"));
  await waitUntil(
    () => view.input.value === "" && chunks(view).length === 1,
  );

  assert.ok(staged.includes("echo hi"), "command fully staged in input");
  assert.equal(view.input.value, "", "input cleared after presentation");
  assert.equal(
    view.input.classList.contains("is-agent-filled"),
    false,
    "agent fill class removed",
  );
  assert.equal(
    view.input.classList.contains("flash-ring"),
    false,
    "flash class removed",
  );
});

test("skips staging when a user draft sits in the input", async () => {
  const { view } = fresh("sess-1");
  view.setCommand("user draft");
  emit("sess-1", shellCall("t-draft"));
  await waitUntil(() => chunks(view).length === 1);
  assert.equal(view.input.value, "user draft", "draft untouched");
  assert.equal(view.input.classList.contains("is-agent-filled"), false);
});

test("auto-opens the panel on agent shell start", async () => {
  bridge.streamHandlers = [];
  bridge.sessions.clear();
  const view = new TerminalPaneView();
  let opened = 0;
  const controller = new TerminalPaneController(view, {
    openPanel: () => {
      opened += 1;
    },
  });
  controller.setMirrorSession("sess-1");
  emit("sess-1", shellCall("t-open"));
  await waitUntil(() => chunks(view).length === 1);
  assert.equal(opened, 1);
});

test("renders the result body + divider on tool_finished", async () => {
  const { view } = fresh("sess-1");
  const body = "$ echo hi\ncwd /ws\nexit 0\n--- stdout ---\nhi";
  bridge.sessions.set("sess-1", sessionWithToolResult("t2", body));
  emit("sess-1", shellCall("t2"));
  emit("sess-1", { type: "tool_finished", id: "t2", messageId: "m1" });
  await waitUntil(() => chunks(view).length === 2 && dividerCount(view) === 1);

  const parts = chunks(view);
  assert.equal(parts[0]?.className, "terminal-pane-chunk is-agent");
  assert.equal(parts[1]?.className, "terminal-pane-chunk is-stdout");
  assert.equal(parts[1]?.textContent, body);
});

test("seals with no-result when the snapshot lacks the tool_result", async () => {
  const { view } = fresh("sess-1");
  bridge.sessions.set("sess-1", sessionWithToolResult("t9", ""));
  emit("sess-1", shellCall("t9"));
  emit("sess-1", { type: "tool_finished", id: "t9", messageId: "m1" });
  await waitUntil(() => dividerCount(view) === 1);

  const parts = chunks(view);
  assert.equal(parts.at(-1)?.className, "terminal-pane-chunk is-meta");
  assert.equal(parts.at(-1)?.textContent, "— (no result)\n");
});

test("truncates long result bodies head+tail", async () => {
  const { view } = fresh("sess-1");
  const body = `${"x".repeat(5000)}TAILMARK`;
  bridge.sessions.set("sess-1", sessionWithToolResult("t3", body));
  emit("sess-1", shellCall("t3", "cat big"));
  emit("sess-1", { type: "tool_finished", id: "t3", messageId: "m1" });
  await waitUntil(() => dividerCount(view) === 1);

  const text = chunks(view).at(-1)?.textContent ?? "";
  // 5008 total − (1500 head + 2500 tail) = 1008 omitted.
  assert.ok(text.includes("…(truncated 1008 chars)…"), text.slice(1450, 1600));
  assert.ok(text.startsWith("x".repeat(100)));
  assert.ok(text.endsWith("TAILMARK"));
  assert.ok(text.length < body.length);
});

test("terminal status seals pending entries; late finish is a no-op", async () => {
  const { view } = fresh("sess-1");
  emit("sess-1", shellCall("t4", "sleep 9"));
  emit("sess-1", { type: "status", status: "streaming" });
  assert.equal(chunks(view).length, 0, "non-terminal status does not seal");

  emit("sess-1", { type: "status", status: "idle" });
  await waitUntil(() => dividerCount(view) === 1);
  const parts = chunks(view);
  assert.equal(parts.length, 2, "start line + no-result seal");
  assert.equal(parts.at(-1)?.textContent, "— (no result)\n");

  bridge.sessions.set("sess-1", sessionWithToolResult("t4", "late"));
  emit("sess-1", { type: "tool_finished", id: "t4", messageId: "m1" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(chunks(view).length, 2, "sealed entry ignores late finish");
});

test("switching the mirror session seals leftovers", async () => {
  const { view, controller } = fresh("sess-1");
  emit("sess-1", shellCall("t5", "echo old"));
  controller.setMirrorSession("sess-9");
  await waitUntil(() => dividerCount(view) === 1);
  const parts = chunks(view);
  assert.equal(parts.length, 2, "start line + no-result seal");
  assert.equal(parts.at(-1)?.textContent, "— (no result)\n");

  emit("sess-1", shellCall("t6", "echo stale"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(chunks(view).length, 2, "old session no longer mirrored");
});

test("mirror never touches the busy state", async () => {
  const { view } = fresh("sess-1");
  bridge.sessions.set("sess-1", sessionWithToolResult("t7", "ok"));
  emit("sess-1", shellCall("t7"));
  emit("sess-1", { type: "tool_finished", id: "t7", messageId: "m1" });
  emit("sess-1", { type: "status", status: "idle" });
  await waitUntil(() => dividerCount(view) === 1);

  assert.equal(view.busy, false);
  assert.equal(view.runButton.disabled, false);
  assert.equal(view.stopButton.disabled, true);
  assert.equal(view.input.disabled, false);
});

test("destroy unsubscribes the mirror stream", () => {
  const { view, controller } = fresh("sess-1");
  controller.destroy();
  emit("sess-1", shellCall("t8", "echo gone"));
  assert.equal(chunks(view).length, 0);
});
