/**
 * present_demo web cards (demoCard.ts + toolCards/chat wiring, plan §5):
 * five control types, srcdoc preview (UTF-8), degradation bar, deferred
 * mount, Confirm→callback, settled, postMessage linkage, summary card in
 * the chat stream, settled scan (transcript ∪ queue), confirm orchestration.
 */
import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";

// demoCard/toolCards touch document/HTMLElement at render time — install
// linkedom first (same env as toolCards.dom.test.ts).
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  // linkedom lacks HTMLDetailsElement; card code only uses it for `instanceof`.
  HTMLDetailsElement: class HTMLDetailsElement extends dom.HTMLElement {},
  // The demo select combobox positions its listbox on the next frame.
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
});

const {
  createDemoCardPanel,
  buildDemoScan,
  submitDemoConfirm,
  decodeBase64Utf8,
} = await import("../src/demoCard.js");
const { createToolInvocationCard } = await import("../src/toolCards.js");
const { renderChatStream } = await import("../src/chat.js");
const { buildDemoConfirmMessage } = await import(
  "../../../src/session/demoConfirm.js"
);

function base64Of(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

// Browser checks cover native top-layer positioning, dismissal and focus.
Object.assign(dom.HTMLElement.prototype, {
  showPopover() {
    const event = new dom.window.Event("beforetoggle");
    Object.assign(event, { newState: "open" });
    this.dispatchEvent(event);
  },
  hidePopover() {
    const event = new dom.window.Event("beforetoggle");
    Object.assign(event, { newState: "closed" });
    this.dispatchEvent(event);
  },
  getBoundingClientRect: () => ({ top: 400, bottom: 430, left: 20, width: 360, height: 280 }),
  focus() {},
});
Object.assign(globalThis, { window: dom.window });
Object.assign(dom.window, { innerWidth: 800, innerHeight: 1000 });

function paramsFixture() {
  return [
    { name: "title", label: "Title", type: "string", default: "Hello" },
    { name: "count", type: "number", default: 3, min: 0, max: 10, step: 1 },
    { name: "speed", type: "number", default: 2 },
    { name: "dense", type: "boolean", default: true },
    {
      name: "layout",
      type: "select",
      default: "grid",
      options: ["grid", "list"],
    },
    { name: "accent", type: "color", default: "#3b82f6" },
  ];
}

function panelInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    toolCallId: "call_demo",
    path: "/ws/demos/layout/index.html",
    title: "Layout demo",
    params: paramsFixture(),
    hasResult: true,
    ok: true,
    htmlBase64: base64Of("<!doctype html><p>héllo demo</p>"),
    settled: null,
    initiallyOpen: true,
    ...overrides,
  };
}

test("parameters open in a dialog and retain edits across panel rebuilds", () => {
  const state = { values: {} as Record<string, unknown>, note: "" };
  const input = panelInput({ state });
  const { root } = createDemoCardPanel(input as never);
  const form = root.querySelector<HTMLElement>(".content-card-demo-form")!;
  const toggle = root.querySelector<HTMLButtonElement>(".content-card-demo-params-toggle")!;
  const iframe = root.querySelector("iframe");
  assert.equal(form.hidden, true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.getAttribute("aria-controls"), form.parentElement!.id);
  assert.equal(form.parentElement!.getAttribute("popover"), "auto");
  assert.equal(toggle.getAttribute("aria-haspopup"), "dialog");
  assert.equal(toggle.getAttribute("aria-label"), "Parameters (6)");
  assert.ok(toggle.querySelector("svg.content-card-demo-params-icon"));
  // Floating toggle lives inside the preview window (FAB anchor).
  assert.equal(
    toggle.parentElement!.classList.contains("content-card-demo-preview"),
    true,
  );
  assert.ok(root.querySelector(".content-card-demo-note"));
  assert.ok(root.querySelector(".content-card-demo-confirm-btn"));
  toggle.click();
  assert.equal(form.hidden, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  const range = form.querySelector<HTMLInputElement>('input[type="range"]')!;
  range.value = "8";
  range.dispatchEvent(new dom.window.Event("input"));
  toggle.click();
  assert.equal(form.hidden, true);
  toggle.click();
  assert.equal(range.value, "8");
  assert.equal(state.values.count, 8);
  assert.equal(root.querySelector("iframe"), iframe);

  const rebuilt = createDemoCardPanel(input as never).root;
  assert.equal(rebuilt.querySelector<HTMLElement>(".content-card-demo-form")!.hidden, true);
  assert.equal(rebuilt.querySelector<HTMLInputElement>('input[type="range"]')!.value, "8");
  assert.notEqual(rebuilt.querySelector(".content-card-demo-params-popover")!.id, form.parentElement!.id);
  root.querySelector<HTMLButtonElement>(".content-card-demo-params-close")!.click();
  assert.equal(form.hidden, true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(createDemoCardPanel(input as never).root.querySelector<HTMLElement>(".content-card-demo-form")!.hidden, true);
});

test("panel renders one control per param with defaults and bounds", () => {
  const panel = createDemoCardPanel(panelInput() as never);
  const text = panel.root.querySelector<HTMLInputElement>('input[type="text"]');
  assert.equal(text?.value, "Hello");
  // Bounded number → Variant A slider (range + mono readout).
  const range = panel.root.querySelector<HTMLInputElement>('input[type="range"]');
  assert.equal(range?.min, "0");
  assert.equal(range?.max, "10");
  assert.equal(range?.step, "1");
  assert.equal(range?.value, "3");
  assert.equal(
    panel.root.querySelector(".content-card-demo-readout")?.textContent,
    "3",
  );
  // Unbounded number keeps the plain input (v1 fallback).
  const number = panel.root.querySelector<HTMLInputElement>(
    'input[type="number"]',
  );
  assert.equal(number?.value, "2");
  const checkbox = panel.root.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  assert.equal(checkbox?.checked, true);
  // Select params render as the app-drawn combobox: native <select>
  // dropdowns open behind the popover's top layer in Chromium.
  const combo = panel.root.querySelector<HTMLButtonElement>(
    "button.content-card-demo-select",
  )!;
  assert.equal(combo.getAttribute("role"), "combobox");
  assert.equal(combo.getAttribute("aria-expanded"), "false");
  assert.equal(combo.textContent, "grid");
  combo.click();
  const popover = combo.closest(".content-card-demo-params-popover")!;
  const listbox = popover.querySelector('[role="listbox"]');
  assert.ok(listbox);
  assert.deepEqual(
    [...listbox.children].map((row) => row.getAttribute("aria-selected")),
    ["true", "false"],
  );
  assert.equal(listbox.children[0]!.getAttribute("role"), "option");
  const color = panel.root.querySelector<HTMLInputElement>(
    'input[type="color"]',
  );
  assert.equal(color?.value, "#3b82f6");
});

test("mounted iframe renders decoded UTF-8 HTML via srcdoc, sandboxed", () => {
  const panel = createDemoCardPanel(panelInput() as never);
  const frame = panel.root.querySelector("iframe.content-card-demo-iframe");
  assert.ok(frame, "open card mounts the iframe");
  assert.equal(frame!.getAttribute("sandbox"), "allow-scripts");
  assert.equal(
    frame!.getAttribute("srcdoc"),
    "<!doctype html><p>héllo demo</p>",
  );
  assert.equal(decodeBase64Utf8(base64Of("café ✓")), "café ✓");
});

test("missing htmlBase64 degrades to the unavailable bar; form still works", () => {
  const panel = createDemoCardPanel(panelInput({ htmlBase64: null }) as never);
  assert.equal(panel.root.querySelector("iframe"), null);
  const note = panel.root.querySelector(".content-card-demo-preview-note");
  assert.match(note?.textContent ?? "", /Preview unavailable on web/);
  assert.match(note?.textContent ?? "", /index\.html/);
  assert.ok(panel.root.querySelector('input[type="text"]'), "form renders");
});

test("running card shows the preview skeleton and no Confirm button", () => {
  const panel = createDemoCardPanel(panelInput({ hasResult: false }) as never);
  assert.equal(panel.root.querySelector("iframe"), null);
  assert.match(
    panel.root.querySelector(".content-card-demo-preview-note")?.textContent ??
      "",
    /Loading preview/,
  );
  assert.match(
    panel.root.querySelector(".content-card-demo-submitted.is-waiting")
      ?.textContent ?? "",
    /Waiting for the demo/,
  );
  assert.equal(panel.root.querySelector(".content-card-demo-confirm-btn"), null);
});

test("failed result shows the failure note", () => {
  const panel = createDemoCardPanel(panelInput({ ok: false }) as never);
  assert.match(
    panel.root.querySelector(".content-card-demo-preview-note.is-failed")
      ?.textContent ?? "",
    /failed/i,
  );
});

test("Confirm submits values + note once and settles the form", () => {
  const calls: Array<{ values: unknown; note?: string }> = [];
  const panel = createDemoCardPanel(
    panelInput({
      onSubmitDemoParams: (values: unknown, note?: string) =>
        calls.push({ values, note }),
    }) as never,
  );
  const note = panel.root.querySelector<HTMLInputElement>(
    ".content-card-demo-note",
  )!;
  note.value = "denser please";
  note.dispatchEvent(new dom.window.Event("input"));

  const btn = panel.root.querySelector<HTMLButtonElement>(
    ".content-card-demo-confirm-btn",
  )!;
  btn.dispatchEvent(new dom.window.Event("click"));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.values, {
    title: "Hello",
    count: 3,
    speed: 2,
    dense: true,
    layout: "grid",
    accent: "#3b82f6",
  });
  assert.equal(calls[0]!.note, "denser please");

  btn.dispatchEvent(new dom.window.Event("click"));
  assert.equal(calls.length, 1, "double-click guard");
  assert.equal(
    panel.root.querySelector<HTMLInputElement>('input[type="text"]')!.disabled,
    true,
  );
  assert.equal(
    panel.root.querySelector<HTMLInputElement>('input[type="range"]')!.disabled,
    true,
  );
  assert.match(
    panel.root.querySelector(".content-card-demo-submitted")?.textContent ??
      "",
    /Submitted/,
  );
});

test("settled input disables the form and shows the value summary", () => {
  const panel = createDemoCardPanel(
    panelInput({ settled: { paramsJson: '{"count": 7, "title": "Hi"}' } }) as never,
  );
  assert.equal(panel.root.querySelector(".content-card-demo-confirm-btn"), null);
  assert.equal(
    panel.root.querySelector<HTMLInputElement>('input[type="text"]')!.disabled,
    true,
  );
  assert.equal(
    panel.root.querySelector<HTMLInputElement>('input[type="range"]')!.disabled,
    true,
  );
  assert.equal(
    panel.root.querySelector<HTMLButtonElement>(".content-card-demo-params-toggle")!
      .disabled,
    true,
  );
  assert.match(
    panel.root.querySelector(".content-card-demo-submitted")?.textContent ??
      "",
    /Submitted · count=7, title=Hi/,
  );
  assert.equal(panel.root.querySelector<HTMLInputElement>('input[type="range"]')!.value, "7");
  assert.equal(panel.root.querySelector<HTMLInputElement>('input[type="text"]')!.value, "Hi");
});

test("rejected web Confirm shows Retry without losing values or note", async () => {
  let attempts = 0;
  const received: unknown[] = [];
  const panel = createDemoCardPanel(panelInput({
    onSubmitDemoParams: async (values: unknown, note?: string) => {
      received.push({ values, note });
      if (++attempts === 1) throw new Error("Connection lost");
      return { enqueued: true };
    },
  }) as never);
  const range = panel.root.querySelector<HTMLInputElement>('input[type="range"]')!;
  range.value = "8";
  range.dispatchEvent(new dom.window.Event("input"));
  const note = panel.root.querySelector<HTMLInputElement>(".content-card-demo-note")!;
  note.value = "Keep this";
  note.dispatchEvent(new dom.window.Event("input"));
  panel.root.querySelector<HTMLButtonElement>(".content-card-demo-confirm-btn")!.click();
  assert.equal(panel.root.querySelector(".content-card-demo-confirm-btn")!.textContent, "Submitting…");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(panel.root.querySelector('[role="alert"]')!.textContent!, /Connection lost/);
  assert.equal(range.disabled, false);
  const retry = panel.root.querySelector<HTMLButtonElement>(".content-card-demo-confirm-btn")!;
  assert.equal(retry.textContent, "Retry");
  retry.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(received[0], received[1]);
  assert.match(panel.root.querySelector(".content-card-demo-submitted")!.textContent!, /^Queued/);
});

test("an empty submitted web number stays empty when reopened", () => {
  const panel = createDemoCardPanel(panelInput({ settled: { paramsJson: '{"speed":null}' } }) as never);
  assert.equal(panel.root.querySelector<HTMLInputElement>('input[type="number"]')!.value, "");
});

test("web whole-card rebuild preserves a draft and guards an in-flight Confirm", async () => {
  const states = new Map();
  let accept!: (value: { enqueued: boolean }) => void;
  const pending = new Promise<{ enqueued: boolean }>((resolve) => { accept = resolve; });
  const sent: Array<{ values: Record<string, unknown>; note?: string }> = [];
  const callbacks = {
    demoOpenCallId: "stateful", demoStates: states,
    onSubmitDemoParams: (_id: string, values: Record<string, unknown>, note?: string) => {
      sent.push({ values, note }); return pending;
    },
  };
  const create = () => createToolInvocationCard(demoPart("stateful") as never, demoResult("stateful", base64Of("<p>demo</p>")) as never, callbacks);
  const first = create();
  // The integration fixture has no params, but the note is a real unsent draft.
  const note = first.querySelector<HTMLInputElement>(".content-card-demo-note")!;
  note.value = "Survive refresh";
  note.dispatchEvent(new dom.window.Event("input"));
  const fresh = create();
  assert.equal(fresh.querySelector<HTMLInputElement>(".content-card-demo-note")!.value, "Survive refresh");
  fresh.querySelector<HTMLButtonElement>(".content-card-demo-confirm-btn")!.click();
  const during = create();
  const busy = during.querySelector<HTMLButtonElement>(".content-card-demo-confirm-btn")!;
  assert.equal(busy.disabled, true);
  busy.dispatchEvent(new dom.window.Event("click"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.note, "Survive refresh");
  accept({ enqueued: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(during.querySelector(".content-card-demo-submitted")!.textContent!, /^Submitted/);
});

test("posts current values on load and throttled change", async () => {
  const panel = createDemoCardPanel(panelInput() as never);
  const frame = panel.root.querySelector("iframe")!;
  const posted: Array<{ type: string; values: Record<string, unknown> }> = [];
  Object.defineProperty(frame, "contentWindow", {
    value: { postMessage: (msg: unknown) => posted.push(msg as never) },
    configurable: true,
  });
  frame.dispatchEvent(new dom.window.Event("load"));
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.type, "jellybot-demo-params");
  assert.deepEqual(posted[0]!.values, {
    title: "Hello",
    count: 3,
    speed: 2,
    dense: true,
    layout: "grid",
    accent: "#3b82f6",
  });

  const text = panel.root.querySelector<HTMLInputElement>('input[type="text"]')!;
  text.value = "Changed";
  text.dispatchEvent(new dom.window.Event("input"));
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(posted.length, 2);
  assert.equal(posted[1]!.values.title, "Changed");

  const range = panel.root.querySelector<HTMLInputElement>('input[type="range"]')!;
  range.value = "7";
  range.dispatchEvent(new dom.window.Event("input"));
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(posted.length, 3);
  assert.equal(posted[2]!.values.count, 7);
  assert.equal(
    panel.root.querySelector(".content-card-demo-readout")!.textContent,
    "7",
  );
});

test("deferred mount: iframe appears on mountPreview, gone on unmountPreview", () => {
  const panel = createDemoCardPanel(
    panelInput({ initiallyOpen: false }) as never,
  );
  assert.equal(panel.root.querySelector("iframe"), null);
  assert.match(
    panel.root.querySelector(".content-card-demo-preview-note")?.textContent ??
      "",
    /open to load/i,
  );
  panel.mountPreview();
  assert.ok(panel.root.querySelector("iframe"));
  panel.unmountPreview();
  assert.equal(panel.root.querySelector("iframe"), null);

  // Form state survives unmount cycles.
  const text = panel.root.querySelector<HTMLInputElement>('input[type="text"]')!;
  text.value = "Kept";
  text.dispatchEvent(new dom.window.Event("input"));
  panel.unmountPreview();
  panel.mountPreview();
  assert.equal(
    panel.root.querySelector<HTMLInputElement>('input[type="text"]')!.value,
    "Kept",
  );
});

test("zero params keeps note + Confirm and hides the form", () => {
  const panel = createDemoCardPanel(panelInput({ params: [] }) as never);
  assert.equal(panel.root.querySelector(".content-card-demo-params-toggle"), null);
  assert.ok(
    panel.root
      .querySelector(".content-card-demo-form")!
      .classList.contains("is-empty"),
  );
  assert.ok(panel.root.querySelector(".content-card-demo-note"));
  assert.ok(panel.root.querySelector(".content-card-demo-confirm-btn"));
});

// ── toolCards integration ─────────────────────────────────────────────

function demoPart(id: string): Record<string, unknown> {
  return {
    id,
    type: "tool_call",
    name: "present_demo",
    status: "completed",
    arguments: {
      path: "/ws/demos/x/index.html",
      title: "X demo",
      params: [{ name: "n", type: "number", default: 1, min: 0, max: 5 }],
    },
  };
}

function demoResult(id: string, htmlBase64: string | null): Record<string, unknown> {
  return {
    type: "tool_result",
    toolCallId: id,
    returnCode: 0,
    content: [
      { type: "text", text: "Presented demo /ws/demos/x/index.html." },
      ...(htmlBase64
        ? [
            {
              type: "attachment",
              name: "index.html",
              mimeType: "text/html",
              htmlBase64,
            },
          ]
        : []),
    ],
  };
}

test("demo tool card renders as a rich details card with the panel body", () => {
  const card = createToolInvocationCard(
    demoPart("c1") as never,
    demoResult("c1", base64Of("<p>x</p>")) as never,
    { demoOpenCallId: "c1" },
  );
  assert.equal((card as unknown as { tagName: string }).tagName, "DETAILS");
  assert.ok(card.classList.contains("content-card-demo-tool"));
  assert.equal(
    card.querySelector(".content-card-demo-title")?.textContent,
    "X demo",
  );
  assert.match(
    card.querySelector(".content-card-tool-result-hint")?.textContent ?? "",
    /index\.html · 1 params/,
  );
  assert.ok(card.querySelector(".content-card-demo"), "panel body present");
  assert.ok(
    card.querySelector("iframe"),
    "open card has the iframe mounted (initiallyOpen)",
  );
});

test("non-open demo card defers the iframe until toggle", () => {
  const card = createToolInvocationCard(
    demoPart("c2") as never,
    demoResult("c2", base64Of("<p>y</p>")) as never,
    { demoOpenCallId: "other" },
  );
  assert.ok(!card.hasAttribute("open"), "settled/older card stays closed");
  assert.equal(card.querySelector("iframe"), null, "iframe not mounted");
  (card as unknown as { open: boolean }).open = true;
  card.dispatchEvent(new dom.window.Event("toggle"));
  assert.ok(card.querySelector("iframe"), "toggle mounts the iframe");
  (card as unknown as { open: boolean }).open = false;
  card.dispatchEvent(new dom.window.Event("toggle"));
  assert.equal(card.querySelector("iframe"), null, "close unmounts it");
});

test("settled demo card (confirm in transcript) renders collapsed + settled form", () => {
  const card = createToolInvocationCard(
    demoPart("c3") as never,
    demoResult("c3", base64Of("<p>z</p>")) as never,
    {
      demoSettledByCallId: new Map([["c3", { paramsJson: '{"n": 4}' }]]),
      demoOpenCallId: null,
    },
  );
  assert.ok(!card.hasAttribute("open"));
  assert.match(
    card.querySelector(".content-card-demo-submitted")?.textContent ?? "",
    /Submitted · n=4/,
  );
  assert.equal(card.querySelector(".content-card-demo-confirm-btn"), null);
});

// ── chat stream summary card ──────────────────────────────────────────

test("confirm marker user message renders the summary card, not raw prose", () => {
  const session = {
    id: "s1",
    status: "idle",
    messages: [
      { id: "m1", role: "assistant", createdAt: 1, parts: [demoPart("cx")] },
      { id: "m2", role: "tool", createdAt: 2, parts: [demoResult("cx", null)] },
      {
        id: "m3",
        role: "user",
        createdAt: 3,
        parts: [
          {
            type: "text",
            text: buildDemoConfirmMessage({
              toolCallId: "cx",
              paramsJson: '{"n": 2}',
              note: "go",
            }),
          },
        ],
      },
    ],
  } as never;
  const flow = renderChatStream(session);
  const row = flow.querySelector(".conversation-msg-user.is-demo-confirm");
  assert.ok(row, "summary card row");
  const card = row.querySelector(".content-card-demo-confirm");
  assert.ok(card, "summary card present");
  assert.match(
    card!.querySelector(".content-card-demo-confirm-title")?.textContent ?? "",
    /Demo confirmed · 1 params/,
  );
  assert.match(
    card!.querySelector(".content-card-demo-confirm-brief")?.textContent ?? "",
    /n=2/,
  );
  assert.ok(!row.textContent!.includes('{"n"'), "raw JSON never leaks");
  assert.ok(!row.textContent!.includes("```"), "fence never leaks");
  assert.equal(row.querySelector(".message-part-text"), null);
});

test("non-marker user text renders normally", () => {
  const session = {
    id: "s1",
    status: "idle",
    messages: [
      {
        id: "m1",
        role: "user",
        createdAt: 1,
        parts: [{ type: "text", text: "Please make a demo" }],
      },
    ],
  } as never;
  const flow = renderChatStream(session);
  assert.equal(flow.querySelector(".content-card-demo-confirm"), null);
  assert.ok(flow.querySelector(".message-part-text"));
  assert.equal(flow.querySelector(".is-demo-confirm"), null);
});

// ── settled scan + confirm orchestration ──────────────────────────────

test("buildDemoScan collects settled ids from transcript and queue", () => {
  const messages = [
    {
      id: "a1",
      role: "assistant",
      createdAt: 1,
      parts: [
        { type: "tool_call", id: "call_a", name: "present_demo", status: "completed", arguments: {} },
      ],
    },
    {
      id: "a2",
      role: "assistant",
      createdAt: 2,
      parts: [
        { type: "tool_call", id: "call_b", name: "present_demo", status: "completed", arguments: {} },
      ],
    },
    {
      id: "u1",
      role: "user",
      createdAt: 3,
      parts: [
        {
          type: "text",
          text: buildDemoConfirmMessage({
            toolCallId: "call_a",
            paramsJson: "{}",
          }),
        },
      ],
    },
  ] as never;
  const scan = buildDemoScan(
    messages,
    [buildDemoConfirmMessage({ toolCallId: "call_q", paramsJson: '{"x":1}' })],
  );
  assert.ok(scan.settledByCallId.has("call_a"), "from transcript");
  assert.ok(scan.settledByCallId.has("call_q"), "from queue");
  assert.equal(scan.openCallId, "call_b", "newest unsettled opens");
});

test("submitDemoConfirm starts a turn when idle and enqueues when running", async () => {
  const calls: Array<{ action: string; payload: Record<string, unknown> }> = [];
  const client = {
    async request<T>(
      _deviceId: string,
      action: string,
      payload: Record<string, unknown>,
    ): Promise<T> {
      calls.push({ action, payload });
      return { items: [{ id: "q1" }] } as T;
    },
  };
  const idle = await submitDemoConfirm({
    client,
    deviceId: "d1",
    sessionId: "s1",
    running: false,
    toolCallId: "c1",
    values: { n: 2 },
    note: "go",
  });
  assert.equal(idle.enqueued, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.action, "startTurn");
  assert.match(
    String(calls[0]!.payload.userText),
    /^Demo confirmed \[demo:c1\]:/,
  );
  assert.match(String(calls[0]!.payload.userText), /"n": ?2/);
  assert.match(String(calls[0]!.payload.userText), /Note: go/);

  const running = await submitDemoConfirm({
    client,
    deviceId: "d1",
    sessionId: "s1",
    running: true,
    toolCallId: "c1",
    values: { n: 3 },
  });
  assert.equal(running.enqueued, true);
  assert.deepEqual(running.items, [{ id: "q1" }]);
  assert.equal(calls[1]!.action, "enqueuePrompt");
  assert.equal(calls[1]!.payload.mode, "deferred");
});
