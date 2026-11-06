/**
 * present_demo desktop card (plan §3): five control types, defaults,
 * min/max/step, postMessage linkage, Confirm→callback, settled scan
 * (transcript ∪ queue), iframe sandbox + mount strategy.
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { before, describe, it } from "node:test";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })
  ._extensions[".css"] = () => {};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  MutationObserver: dom.window.MutationObserver,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
});

let createDemoCardPanel: typeof import("./DemoCardView.js")["createDemoCardPanel"];
let createToolInvocationCard: typeof import("./ToolInvocationCardView.js")["createToolInvocationCard"];
let buildMessageRenderContext: typeof import("../buildMessageRenderContext.js")["buildMessageRenderContext"];
let buildDemoConfirmMessage: typeof import("../../../../../session/demoConfirm.js")["buildDemoConfirmMessage"];

before(async () => {
  ({ createDemoCardPanel } = await import("./DemoCardView.js"));
  ({ createToolInvocationCard } = await import("./ToolInvocationCardView.js"));
  ({ buildMessageRenderContext } = await import(
    "../buildMessageRenderContext.js"
  ));
  ({ buildDemoConfirmMessage } = await import(
    "../../../../../session/demoConfirm.js"
  ));
});

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
  overrides: Partial<Parameters<typeof createDemoCardPanel>[0]> = {},
): Parameters<typeof createDemoCardPanel>[0] {
  return {
    toolCallId: "call_demo",
    path: "/ws/demos/layout/index.html",
    title: "Layout demo",
    params: paramsFixture(),
    hasResult: true,
    ok: true,
    settled: null,
    state: { values: {}, note: "" },
    ...overrides,
  };
}

describe("createDemoCardPanel form", () => {
  it("opens a parameter dialog without resetting the preview or draft", () => {
    const input = panelInput();
    const panel = createDemoCardPanel(input);
    const form = panel.querySelector<HTMLElement>(".content-card-demo-form")!;
    const toggle = panel.querySelector<HTMLButtonElement>(".content-card-demo-params-toggle")!;
    const iframe = panel.querySelector("iframe");
    assert.equal(form.hidden, true);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(toggle.getAttribute("aria-controls"), form.parentElement!.id);
    assert.equal(form.parentElement!.getAttribute("popover"), "auto");
    assert.equal(toggle.getAttribute("aria-haspopup"), "dialog");
    assert.equal(toggle.getAttribute("aria-label"), "Parameters (6)");
    assert.ok(toggle.querySelector("svg.content-card-demo-params-icon"));
    // Floating toggle lives inside the preview window (FAB anchor).
    assert.ok(toggle.closest(".content-card-demo-preview"));
    assert.ok(panel.querySelector(".content-card-demo-note"));
    assert.ok(panel.querySelector(".content-card-demo-confirm-btn"));
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
    assert.equal(input.state.values.count, 8);
    assert.equal(panel.querySelector("iframe"), iframe);

    const rebuilt = createDemoCardPanel(input);
    assert.equal(rebuilt.querySelector<HTMLElement>(".content-card-demo-form")!.hidden, true);
    assert.equal(rebuilt.querySelector<HTMLInputElement>('input[type="range"]')!.value, "8");
    assert.notEqual(rebuilt.querySelector(".content-card-demo-params-popover")!.id, form.parentElement!.id);
    panel.querySelector<HTMLButtonElement>(".content-card-demo-params-close")!.click();
    assert.equal(form.hidden, true);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(createDemoCardPanel(input).querySelector<HTMLElement>(".content-card-demo-form")!.hidden, true);
  });

  it("renders one control per declared param with defaults and bounds", () => {
    const input0 = panelInput();
    const panel = createDemoCardPanel(input0);
    const text = panel.querySelector<HTMLInputElement>('input[type="text"]');
    assert.equal(text?.value, "Hello");

    // Bounded number → Variant A slider (range + mono readout).
    const range = panel.querySelector<HTMLInputElement>('input[type="range"]');
    assert.equal(range?.min, "0");
    assert.equal(range?.max, "10");
    assert.equal(range?.step, "1");
    assert.equal(range?.value, "3");
    assert.equal(
      panel.querySelector(".content-card-demo-readout")?.textContent,
      "3",
    );
    // Unbounded number keeps the plain input (v1 fallback).
    const number = panel.querySelector<HTMLInputElement>('input[type="number"]');
    assert.equal(number?.value, "2");

    const checkbox = panel.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    assert.equal(checkbox?.checked, true);

    // Select params render as the app-drawn combobox: native <select>
    // dropdowns open behind the popover's top layer in Chromium.
    const combo = panel.querySelector<HTMLButtonElement>(
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
    assert.equal(
      listbox.children[0]!.getAttribute("role"),
      "option",
    );
    listbox.children[1]!.dispatchEvent(new dom.window.Event("click"));
    assert.equal(input0.state.values.layout, "list");
    assert.equal(combo.getAttribute("aria-expanded"), "false");
    assert.equal(combo.textContent, "list");
    assert.equal(popover.querySelector('[role="listbox"]'), null);

    const color = panel.querySelector<HTMLInputElement>('input[type="color"]');
    assert.equal(color?.value, "#3b82f6");
  });

  it("falls back to the param name for missing labels", () => {
    const panel = createDemoCardPanel(panelInput());
    const labels = [...panel.querySelectorAll(".content-card-demo-label")].map(
      (el) => el.textContent,
    );
    assert.ok(labels.includes("count"));
    assert.ok(labels.includes("dense"));
    assert.ok(labels.includes("layout"));
  });

  it("running card shows a preview skeleton and no Confirm button", () => {
    const panel = createDemoCardPanel(panelInput({ hasResult: false }));
    assert.equal(panel.querySelector("iframe"), null);
    assert.match(
      panel.querySelector(".content-card-demo-preview-note")!.textContent!,
      /Loading preview/,
    );
    assert.match(
      panel.querySelector(".content-card-demo-submitted.is-waiting")!
        .textContent!,
      /Waiting for the demo/,
    );
    assert.equal(panel.querySelector(".content-card-demo-confirm"), null);
  });

  it("failed result shows the failure note", () => {
    const panel = createDemoCardPanel(panelInput({ ok: false }));
    assert.match(
      panel.querySelector(".content-card-demo-preview-note.is-failed")!
        .textContent!,
      /failed/i,
    );
  });

  it("mounts a sandboxed jellybot-file iframe once done", () => {
    const panel = createDemoCardPanel(panelInput());
    const iframe = panel.querySelector("iframe")!;
    assert.equal(iframe.getAttribute("sandbox"), "allow-scripts");
    assert.equal(
      iframe.getAttribute("src"),
      "jellybot-file://local/?path=%2Fws%2Fdemos%2Flayout%2Findex.html",
    );
  });

  it("posts current values on load and on throttled change", async () => {
    const panel = createDemoCardPanel(panelInput());
    const iframe = panel.querySelector("iframe")!;
    const posted: Array<{ type: string; values: Record<string, unknown> }> = [];
    Object.defineProperty(iframe, "contentWindow", {
      value: { postMessage: (msg: unknown) => posted.push(msg as never) },
      configurable: true,
    });
    iframe.dispatchEvent(new dom.window.Event("load"));
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

    const text = panel.querySelector<HTMLInputElement>('input[type="text"]')!;
    text.value = "Changed";
    text.dispatchEvent(new dom.window.Event("input"));
    const checkbox = panel.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    checkbox.checked = false;
    checkbox.dispatchEvent(new dom.window.Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(posted.length, 2);
    assert.equal(posted[1]!.values.title, "Changed");
    assert.equal(posted[1]!.values.dense, false);

    const range = panel.querySelector<HTMLInputElement>('input[type="range"]')!;
    range.value = "7";
    range.dispatchEvent(new dom.window.Event("input"));
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(posted.length, 3);
    assert.equal(posted[2]!.values.count, 7);
    assert.equal(
      panel.querySelector(".content-card-demo-readout")!.textContent,
      "7",
    );
  });

  it("Confirm submits current values + note once and settles the form", () => {
    const state = { values: {}, note: "" };
    const calls: Array<{ values: unknown; note?: string }> = [];
    const panel = createDemoCardPanel(
      panelInput({
        state,
        onSubmitDemoParams: (values, note) => calls.push({ values, note }),
      }),
    );
    const note = panel.querySelector<HTMLInputElement>(".content-card-demo-note")!;
    note.value = "denser please";
    note.dispatchEvent(new dom.window.Event("input"));

    const btn = panel.querySelector<HTMLButtonElement>(
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

    // Double-click guard + settled form.
    btn.dispatchEvent(new dom.window.Event("click"));
    assert.equal(calls.length, 1);
    assert.equal(
      panel.querySelector<HTMLInputElement>('input[type="text"]')!.disabled,
      true,
    );
    assert.equal(
      panel.querySelector<HTMLInputElement>('input[type="range"]')!.disabled,
      true,
    );
    assert.equal(
      panel.querySelector<HTMLButtonElement>("button.content-card-demo-select")!
        .disabled,
      true,
    );
    assert.equal(
      panel.querySelector<HTMLButtonElement>(".content-card-demo-params-toggle")!
        .disabled,
      true,
    );
    assert.match(
      panel.querySelector(".content-card-demo-submitted")!.textContent!,
      /Submitted/,
    );
  });

  it("settled input disables the form and shows the value summary", () => {
    const panel = createDemoCardPanel(
      panelInput({ settled: { paramsJson: '{"count": 7, "title": "Hi"}' } }),
    );
    assert.equal(panel.querySelector(".content-card-demo-confirm"), null);
    assert.equal(
      panel.querySelector<HTMLInputElement>('input[type="text"]')!.disabled,
      true,
    );
    assert.equal(
      panel.querySelector<HTMLInputElement>('input[type="range"]')!.disabled,
      true,
    );
    assert.equal(
      panel.querySelector<HTMLButtonElement>(".content-card-demo-params-toggle")!
        .disabled,
      true,
    );
    assert.match(
      panel.querySelector(".content-card-demo-submitted")!.textContent!,
      /Submitted · count=7, title=Hi/,
    );
    assert.equal(panel.querySelector<HTMLInputElement>('input[type="range"]')!.value, "7");
    assert.equal(panel.querySelector<HTMLInputElement>('input[type="text"]')!.value, "Hi");
  });

  it("zero params mode keeps note + Confirm and hides the form", () => {
    const panel = createDemoCardPanel(panelInput({ params: [] }));
    assert.equal(panel.querySelector(".content-card-demo-params-toggle"), null);
    assert.ok(
      panel.querySelector(".content-card-demo-form")!.classList.contains(
        "is-empty",
      ),
    );
    assert.ok(panel.querySelector(".content-card-demo-note"));
    assert.ok(panel.querySelector(".content-card-demo-confirm-btn"));
  });

  it("an empty submitted number stays empty when reopened", () => {
    const panel = createDemoCardPanel(panelInput({ settled: { paramsJson: '{"speed":null}' } }));
    assert.equal(panel.querySelector<HTMLInputElement>('input[type="number"]')!.value, "");
  });

  it("form state survives a body re-render (collapse → expand)", () => {
    const state = { values: {}, note: "keep me" };
    const first = createDemoCardPanel(panelInput({ state }));
    const text = first.querySelector<HTMLInputElement>('input[type="text"]')!;
    text.value = "Edited";
    text.dispatchEvent(new dom.window.Event("input"));

    const second = createDemoCardPanel(panelInput({ state }));
    assert.equal(
      second.querySelector<HTMLInputElement>('input[type="text"]')!.value,
      "Edited",
    );
    assert.equal(
      second.querySelector<HTMLInputElement>(".content-card-demo-note")!.value,
      "keep me",
    );
  });

  it("a rejected Confirm preserves edits and notes, then Retry can succeed", async () => {
    let attempts = 0;
    const received: unknown[] = [];
    const panel = createDemoCardPanel(panelInput({
      onSubmitDemoParams: async (values, note) => {
        received.push({ values, note });
        if (++attempts === 1) throw new Error("Device offline");
        return { enqueued: true };
      },
    }));
    const range = panel.querySelector<HTMLInputElement>('input[type="range"]')!;
    range.value = "7";
    range.dispatchEvent(new dom.window.Event("input"));
    const note = panel.querySelector<HTMLInputElement>(".content-card-demo-note")!;
    note.value = "Keep my choice";
    note.dispatchEvent(new dom.window.Event("input"));
    panel.querySelector<HTMLButtonElement>(".content-card-demo-confirm-btn")!.click();
    assert.equal(panel.querySelector(".content-card-demo-confirm-btn")!.textContent, "Submitting…");
    assert.equal(panel.querySelector(".content-card-demo-submitted"), null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const retry = panel.querySelector<HTMLButtonElement>(".content-card-demo-confirm-btn")!;
    assert.equal(retry.textContent, "Retry");
    assert.equal(retry.disabled, false);
    assert.equal(range.disabled, false);
    assert.equal(note.value, "Keep my choice");
    assert.match(panel.querySelector('[role="alert"]')!.textContent!, /Device offline/);
    retry.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(attempts, 2);
    assert.deepEqual(received[0], received[1]);
    assert.match(panel.querySelector(".content-card-demo-submitted")!.textContent!, /^Queued/);
  });

  it("pending and acknowledged Confirm stay locked after body remount", async () => {
    let accept!: (value: { enqueued: boolean }) => void;
    const pending = new Promise<{ enqueued: boolean }>((resolve) => { accept = resolve; });
    const state = { values: {}, note: "" };
    let calls = 0;
    const input = panelInput({ state, onSubmitDemoParams: () => { calls += 1; return pending; } });
    const first = createDemoCardPanel(input);
    first.querySelector<HTMLButtonElement>(".content-card-demo-confirm-btn")!.click();
    const reopened = createDemoCardPanel(input);
    const busy = reopened.querySelector<HTMLButtonElement>(".content-card-demo-confirm-btn")!;
    assert.equal(busy.disabled, true);
    busy.dispatchEvent(new dom.window.Event("click"));
    assert.equal(calls, 1);
    accept({ enqueued: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(reopened.querySelector(".content-card-demo-submitted")!.textContent!, /^Queued/);
    const again = createDemoCardPanel(input);
    assert.equal(again.querySelector(".content-card-demo-confirm-btn"), null);
  });
});

describe("present_demo card mount strategy", () => {
  function cardInput(initiallyCollapsed: boolean) {
    return {
      id: "call_mount",
      name: "present_demo",
      status: "done" as const,
      arguments: { path: "/ws/demos/mount/index.html", params: [] },
      argumentsRaw: "",
      ...(initiallyCollapsed ? { initiallyCollapsed: true } : {}),
      result: {
        returnCode: 0,
        content: [{ type: "text", text: "Presented demo /ws/demos/mount/index.html." }],
      },
    };
  }

  it("new card is open with the iframe mounted", () => {
    const card = createToolInvocationCard(cardInput(false));
    assert.equal(card.tagName, "DETAILS");
    assert.equal((card as HTMLDetailsElement).open, true);
    assert.ok(card.querySelector("iframe"));
    assert.equal(
      card.querySelector("iframe")!.getAttribute("sandbox"),
      "allow-scripts",
    );
  });

  it("history card starts collapsed and mounts/unmounts the iframe on toggle", () => {
    const card = createToolInvocationCard(cardInput(true));
    const details = card as HTMLDetailsElement;
    assert.equal(details.open, false);
    assert.equal(details.querySelector("iframe"), null);

    details.open = true;
    details.dispatchEvent(new dom.window.Event("toggle"));
    assert.ok(details.querySelector("iframe"));

    details.open = false;
    details.dispatchEvent(new dom.window.Event("toggle"));
    assert.equal(details.querySelector("iframe"), null);
  });
});

describe("settled scan (transcript ∪ prompt queue)", () => {
  function ctxOptions(extra: Record<string, unknown> = {}) {
    return {
      revealLabel: "Reveal",
      onOpenFile: () => {},
      onRevealFile: () => {},
      ...extra,
    };
  }

  it("collects confirm markers from session messages and queued prompts", () => {
    const ctx = buildMessageRenderContext(
      [
        {
          role: "assistant",
          parts: [
            {
              type: "tool_call",
              id: "call_a",
              name: "present_demo",
              arguments: { path: "/ws/demos/a/index.html" },
              status: "done",
              argumentsRaw: "",
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              type: "text",
              text: buildDemoConfirmMessage({
                toolCallId: "call_a",
                paramsJson: '{"count": 2}',
              }),
            },
          ],
        },
      ],
      ctxOptions({
        queuedPrompts: [
          buildDemoConfirmMessage({
            toolCallId: "call_b",
            paramsJson: '{"x": 1}',
          }),
        ],
      }),
    );
    assert.equal(ctx.demoSettledByCallId?.get("call_a")?.paramsJson, '{"count": 2}');
    assert.equal(ctx.demoSettledByCallId?.get("call_b")?.paramsJson, '{"x": 1}');
  });

  it("collapses settled/older demo cards; newest unsettled stays open", () => {
    const ctx = buildMessageRenderContext(
      [
        {
          role: "assistant",
          parts: [
            {
              type: "tool_call",
              id: "call_old",
              name: "present_demo",
              arguments: {},
              status: "done",
              argumentsRaw: "",
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              type: "text",
              text: buildDemoConfirmMessage({
                toolCallId: "call_old",
                paramsJson: "{}",
              }),
            },
          ],
        },
        {
          role: "assistant",
          parts: [
            {
              type: "tool_call",
              id: "call_new",
              name: "present_demo",
              arguments: {},
              status: "done",
              argumentsRaw: "",
            },
          ],
        },
      ],
      ctxOptions(),
    );
    assert.ok(ctx.initiallyCollapsedToolCallIds?.has("call_old"));
    assert.equal(ctx.initiallyCollapsedToolCallIds?.has("call_new"), false);
  });

  it("collapses every demo card when all are settled", () => {
    const ctx = buildMessageRenderContext(
      [
        {
          role: "assistant",
          parts: [
            {
              type: "tool_call",
              id: "call_1",
              name: "present_demo",
              arguments: {},
              status: "done",
              argumentsRaw: "",
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              type: "text",
              text: buildDemoConfirmMessage({
                toolCallId: "call_1",
                paramsJson: "{}",
              }),
            },
          ],
        },
      ],
      ctxOptions(),
    );
    assert.ok(ctx.initiallyCollapsedToolCallIds?.has("call_1"));
  });
});
