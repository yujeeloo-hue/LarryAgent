/**
 * DOM tests: Token Hub provider editor — Responses API options.
 *
 * Regression: providers copied from the desktop carried apiProtocol /
 * responsesStateful / responsesTools in the relay DB (api_options column),
 * but the hub editor had no UI for them — they were stored yet invisible
 * and uneditable. The editor must expose the protocol select, the Full
 * endpoint URL switch, the Responses-only block (Keep state + the three
 * hosted tool switches + Hosted tools JSON), and commit each through
 * updateProvider patches.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Module from "node:module";
import { parseHTML } from "linkedom";
import type { TokenHubController, TokenHubProvider } from "../src/TokenHubController.js";

// TokenHubView pulls the desktop modelBrand module, which imports .svg
// assets (vite-only). Stub asset extensions so node:test can load the view.
const originalLoad = Module._load;
(Module as unknown as { _load: typeof Module._load })._load = function (request, parent, isMain) {
  if (/\.svg(\?|$)/.test(request) || request.includes("?raw") || /\.css$/.test(request)) return "";
  return originalLoad.call(this, request, parent, isMain);
};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  // The wizard focuses its first field via rAF; linkedom has none.
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
});
// linkedom's <select>.value has a getter only — route it through the
// option selected attribute so protocol selects stay settable.
const selectProto = Object.getPrototypeOf(dom.document.createElement("select"));
Object.defineProperty(selectProto, "value", {
  configurable: true,
  get(this: HTMLSelectElement): string {
    return this.querySelector("option[selected]")?.getAttribute("value")
      ?? this.querySelector("option")?.getAttribute("value")
      ?? "";
  },
  set(this: HTMLSelectElement, value: string): void {
    for (const option of this.querySelectorAll("option")) {
      option.toggleAttribute("selected", option.getAttribute("value") === value);
    }
  },
});

const { openAddProviderWizard, renderTokenHubView } = await import("../src/TokenHubView.js");

function provider(overrides: Partial<TokenHubProvider> = {}): TokenHubProvider {
  return {
    id: "p1",
    name: "OpenAI",
    modelId: "gpt-5",
    baseUrl: "https://api.openai.com/v1",
    apiKeyConfigured: true,
    supportsMultimodal: false,
    multimodalSource: "manual",
    imageInput: "url",
    rawEndpoint: false,
    createdAt: 1,
    ...overrides,
  };
}

function stub(prov: TokenHubProvider) {
  const patches: Array<Record<string, unknown>> = [];
  const controller = {
    getSnapshot: () => ({
      status: "ready",
      statusDetail: null,
      providers: [prov],
      selectedProviderId: prov.id,
      deviceProviderIds: {},
    }),
    selectProvider: () => {},
    isProviderOrderSaving: () => false,
    subscribe: () => () => {},
    removeProvider: async () => {},
    updateProvider: async (_providerId: string, patch: Record<string, unknown>) => {
      patches.push(patch);
    },
  } as unknown as TokenHubController;
  return { controller, patches };
}

const change = (el: HTMLElement) => el.dispatchEvent(new window.Event("change"));

test("responses provider exposes protocol, keep-state and hosted tool switches", () => {
  const prov = provider({
    apiProtocol: "responses",
    responsesStateful: false,
    responsesTools: [{ type: "code_interpreter", container: { type: "auto" } }],
  });
  const { controller, patches } = stub(prov);
  const mount = () => {
    document.body.replaceChildren(renderTokenHubView(controller));
    return document.body;
  };
  // The real controller applies each patch and re-renders via notify;
  // mirror that so the next toggle reads the committed state.
  const applyAndRemount = () => {
    const patch = patches.at(-1)!;
    Object.assign(prov, patch);
    return mount();
  };
  let view = mount();

  const protocol = view.querySelector<HTMLSelectElement>('[aria-label="API protocol"]')!;
  assert.equal(protocol.value, "responses");
  const responses = [...view.querySelectorAll(".th-detail-capabilities")][1]!;
  assert.ok(responses, "responses options block exists");
  assert.ok(!responses.hasAttribute("hidden"), "responses block visible for a responses provider");

  // Switch states derive from responsesTools (code exec on, others off).
  const switchesOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLInputElement>(".th-switch input")];
  let switches = switchesOf(responses);
  assert.equal(switches.length, 4, "keep-state + three tool switches");
  assert.equal(switches[0]!.getAttribute("aria-label"), "Keep Responses conversation state for OpenAI");
  assert.deepEqual(switches.map((input) => input.checked), [false, false, true, false]);

  // Keep state commits immediately.
  switches[0]!.checked = true;
  change(switches[0]!);
  assert.deepEqual(patches[0], { responsesStateful: true });
  view = applyAndRemount();

  // Enabling web search keeps the configured code_interpreter definition.
  switches = switchesOf([...view.querySelectorAll(".th-detail-capabilities")][1]!);
  switches[1]!.checked = true;
  change(switches[1]!);
  assert.deepEqual(patches[1], {
    responsesTools: [
      { type: "code_interpreter", container: { type: "auto" } },
      { type: "web_search" },
    ],
  });
  view = applyAndRemount();

  // Disabling code execution drops exactly that family (reads committed state).
  switches = switchesOf([...view.querySelectorAll(".th-detail-capabilities")][1]!);
  assert.deepEqual(switches.map((input) => input.checked), [true, true, true, false]);
  switches[2]!.checked = false;
  change(switches[2]!);
  assert.deepEqual(patches[2], { responsesTools: [{ type: "web_search" }] });
});

test("protocol select and full-endpoint switch commit via updateProvider", () => {
  const { controller, patches } = stub(provider({}));
  const view = renderTokenHubView(controller);
  document.body.append(view);

  const protocol = view.querySelector<HTMLSelectElement>('[aria-label="API protocol"]')!;
  assert.equal(protocol.value, "auto", "unset protocol renders as auto");
  protocol.value = "chat_completions";
  change(protocol);
  assert.deepEqual(patches[0], { apiProtocol: "chat_completions" });

  const raw = view.querySelector<HTMLInputElement>('[aria-label="Full endpoint URL for OpenAI"]')!;
  assert.equal(raw.checked, false);
  raw.checked = true;
  change(raw);
  assert.deepEqual(patches[1], { rawEndpoint: true });
});

test("hosted tools JSON saves with the draft; invalid JSON blocks the save", () => {
  const prov = provider({ apiProtocol: "responses", responsesTools: [{ type: "web_search" }] });
  const { controller, patches } = stub(prov);
  const view = renderTokenHubView(controller);
  document.body.append(view);

  const tools = view.querySelector<HTMLTextAreaElement>('[aria-label="Hosted tools JSON"]')!;
  assert.equal(tools.value, JSON.stringify([{ type: "web_search" }], null, 2));
  const save = [...view.querySelectorAll<HTMLButtonElement>(".th-detail-save")][0]!;
  const status = view.querySelector<HTMLElement>(".th-detail-save-state")!;
  assert.equal(save.disabled, true, "no changes yet");

  // Invalid JSON → dirty + blocked with the reason in the status line.
  tools.value = "[{\"type\":";
  tools.dispatchEvent(new window.Event("input"));
  assert.equal(save.disabled, true);
  assert.match(status.textContent!, /valid JSON/i);

  // Valid edit rides the Save button with the other draft fields.
  tools.value = JSON.stringify([{ type: "web_search" }, { type: "file_search", vector_store_ids: ["vs-1"] }], null, 2);
  tools.dispatchEvent(new window.Event("input"));
  assert.equal(save.disabled, false, "valid tools edit is savable");
  const name = view.querySelector<HTMLInputElement>('[aria-label="Provider name"]')!;
  name.value = "OpenAI Relay";
  name.dispatchEvent(new window.Event("input"));
  save.click();
  assert.deepEqual(patches[0], {
    name: "OpenAI Relay",
    responsesTools: [{ type: "web_search" }, { type: "file_search", vector_store_ids: ["vs-1"] }],
  });
});

test("chat provider keeps the responses block hidden until the protocol says otherwise", () => {
  const { controller } = stub(provider({ baseUrl: "https://api.deepseek.com/v1" }));
  const view = renderTokenHubView(controller);
  document.body.append(view);

  const protocol = view.querySelector<HTMLSelectElement>('[aria-label="API protocol"]')!;
  const hint = [...view.querySelectorAll<HTMLElement>(".th-field-hint")]
    .find((el) => /Chat Completions|Responses API/.test(el.textContent ?? ""))!;
  assert.match(hint.textContent!, /Chat Completions/);

  // Auto + /responses URL implies Responses — the block opens without a PATCH.
  const url = view.querySelector<HTMLInputElement>('[aria-label="Base URL"]')!;
  url.value = "https://api.openai.com/v1/responses";
  url.dispatchEvent(new window.Event("input"));
  assert.match(hint.textContent!, /Responses API/);

  // Explicit protocol wins over the URL guess.
  protocol.value = "chat_completions";
  change(protocol);
  assert.match(hint.textContent!, /Chat Completions/);
});

test("unset keep-state displays the shared stateless default", () => {
  const { controller } = stub(provider({ apiProtocol: "responses" }));
  const view = renderTokenHubView(controller);
  document.body.append(view);
  const stateful = view.querySelector<HTMLInputElement>('[aria-label="Keep Responses conversation state for OpenAI"]')!;
  assert.equal(stateful.checked, false, "unset keep-state shows the default off");

  // URL edits re-resolve an unset keep-state: Kimi Coding flips it off.
  const url = view.querySelector<HTMLInputElement>('[aria-label="Base URL"]')!;
  url.value = "https://api.kimi.com/coding/v1/responses";
  url.dispatchEvent(new window.Event("input"));
  assert.equal(stateful.checked, false, "Kimi Coding profile defaults to stateless");

  // An explicit choice survives URL edits untouched.
  const { controller: explicitController, patches } = stub(provider({
    apiProtocol: "responses",
    responsesStateful: true,
    baseUrl: "https://api.kimi.com/coding/v1/responses",
  }));
  const explicitView = renderTokenHubView(explicitController);
  document.body.replaceChildren(explicitView);
  const explicitStateful = explicitView.querySelector<HTMLInputElement>('[aria-label="Keep Responses conversation state for OpenAI"]')!;
  assert.equal(explicitStateful.checked, true, "explicit true wins over the Kimi profile");
  const explicitUrl = explicitView.querySelector<HTMLInputElement>('[aria-label="Base URL"]')!;
  explicitUrl.value = "https://api.openai.com/v1";
  explicitUrl.dispatchEvent(new window.Event("input"));
  assert.equal(explicitStateful.checked, true, "explicit keep-state is never re-resolved");
  assert.equal(patches.length, 0, "display re-resolve must not PATCH");
});

test("add wizard exposes keep-state with the same default and sends it explicitly", async () => {
  const adds: Array<Record<string, unknown>> = [];
  const controller = {
    detectModels: async () => [{ id: "glm-4.7", supportsMultimodal: false }],
    addProviders: async (input: Record<string, unknown>) => { adds.push(input); },
  } as unknown as TokenHubController;
  openAddProviderWizard(controller);
  const overlay = document.querySelector<HTMLElement>(".th-overlay")!;
  try {
    const url = overlay.querySelector<HTMLInputElement>('[placeholder="https://api.openai.com/v1"]')!;
    const protocol = overlay.querySelector<HTMLSelectElement>('[aria-label="API protocol"]')!;
    const stateful = overlay.querySelector<HTMLInputElement>('[aria-label="Keep Responses conversation state"]')!;
    const row = stateful.closest(".th-detail-capability-row") as HTMLElement;
    assert.ok(row.hasAttribute("hidden"), "keep-state stays hidden for a non-Responses URL");

    // Auto + a Kimi Coding /responses URL opens the row on the stateless default.
    url.value = "https://api.kimi.com/coding/v1/responses";
    url.dispatchEvent(new window.Event("input"));
    assert.ok(!row.hasAttribute("hidden"), "keep-state row visible for a Responses URL");
    assert.equal(stateful.checked, false, "Kimi Coding defaults off in the wizard too");

    // An explicit Responses protocol keeps the row open regardless of URL.
    protocol.value = "responses";
    change(protocol);
    assert.ok(!row.hasAttribute("hidden"));

    // Untouched, the default keeps re-resolving from the URL.
    url.value = "https://open.bigmodel.cn/api/paas/v4";
    url.dispatchEvent(new window.Event("input"));
    assert.ok(!row.hasAttribute("hidden"), "explicit protocol keeps the row visible");
    assert.equal(stateful.checked, false, "non-Kimi URL keeps the same default off");

    // Once toggled, the choice is final for the wizard session.
    stateful.checked = false;
    change(stateful);
    url.value = "https://api.openai.com/v1";
    url.dispatchEvent(new window.Event("input"));
    assert.equal(stateful.checked, false, "a touched choice is never re-resolved");

    // The explicit value rides the add payload into the relay DB.
    const detect = [...overlay.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Detect models")!;
    detect.click();
    await new Promise((r) => setTimeout(r, 0));
    overlay.querySelector<HTMLElement>(".th-picker-row")!.click();
    const add = [...overlay.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => /Add 1 provider/.test(b.textContent ?? ""))!;
    assert.equal(add.disabled, false);
    add.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(adds.length, 1);
    assert.equal(adds[0]!.responsesStateful, false, "wizard sends an explicit keep-state");
  } finally {
    overlay.remove();
  }
});

test("detail keep-state probe automatically applies a stateless verdict", async () => {
  const prov = provider({ apiProtocol: "responses" });
  const patches: Array<Record<string, unknown>> = [];
  let probeResult: { ok: true; supported: boolean } | { ok: false; reason: string } = { ok: true, supported: false };
  const controller = {
    getSnapshot: () => ({
      status: "ready",
      statusDetail: null,
      providers: [prov],
      selectedProviderId: prov.id,
      deviceProviderIds: {},
    }),
    selectProvider: () => {},
    isProviderOrderSaving: () => false,
    subscribe: () => () => {},
    removeProvider: async () => {},
    updateProvider: async (_providerId: string, patch: Record<string, unknown>) => {
      patches.push(patch);
    },
    probeProviderState: async () => probeResult,
  } as unknown as TokenHubController;
  const view = renderTokenHubView(controller);
  document.body.replaceChildren(view);

  const testBtn = [...view.querySelectorAll<HTMLButtonElement>(".th-probe-btn")]
    .find((b) => b.textContent === "Test state support")!;
  assert.ok(testBtn, "probe button sits beside the keep-state switch");
  testBtn.click();
  await new Promise((r) => setTimeout(r, 0));

  const chip = view.querySelector<HTMLElement>(".th-probe-row .th-status")!;
  assert.match(chip.textContent ?? "", /Stateless/, "store-but-drop gateway reports stateless");
  assert.deepEqual(patches[0], { responsesStateful: false }, "a definitive failure persists false immediately");
  assert.equal([...view.querySelectorAll<HTMLButtonElement>(".th-probe-btn")]
    .some((b) => b.textContent === "Apply"), false, "no manual apply is needed for the safe default");

  // Transport failures stay unknown with the reason and do not change the setting.
  probeResult = { ok: false, reason: "http_429" };
  const retry = [...view.querySelectorAll<HTMLButtonElement>(".th-probe-btn")]
    .find((b) => b.textContent === "Test again")!;
  retry.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.match(view.querySelector<HTMLElement>(".th-probe-row .th-status")!.textContent ?? "", /Unknown/);
  assert.match(view.querySelector<HTMLElement>(".th-probe-row .th-field-hint")!.textContent ?? "", /http_429/);
  assert.equal([...view.querySelectorAll<HTMLButtonElement>(".th-probe-btn")]
    .some((b) => b.textContent === "Apply"), false);
  assert.equal(patches.length, 1, "unknown transport results never disable the setting");
});

test("wizard probe-on-add overrides the manual switch with the verdict", async () => {
  const adds: Array<Record<string, unknown>> = [];
  const probes: Array<Record<string, unknown>> = [];
  let failFirstAdd = true;
  const controller = {
    detectModels: async () => [{ id: "glm-4.7", supportsMultimodal: false }, { id: "glm-4.7-air", supportsMultimodal: false }],
    addProviders: async (input: Record<string, unknown>) => {
      adds.push(input);
      if (failFirstAdd) {
        failFirstAdd = false;
        throw new Error("gateway down");
      }
    },
    probeWizardState: async (input: Record<string, unknown>) => {
      probes.push(input);
      return { ok: true, supported: false };
    },
  } as unknown as TokenHubController;
  openAddProviderWizard(controller);
  const overlay = document.querySelector<HTMLElement>(".th-overlay")!;
  try {
    const url = overlay.querySelector<HTMLInputElement>('[placeholder="https://api.openai.com/v1"]')!;
    url.value = "https://open.bigmodel.cn/api/paas/v4";
    url.dispatchEvent(new window.Event("input"));
    const protocol = overlay.querySelector<HTMLSelectElement>('[aria-label="API protocol"]')!;
    protocol.value = "responses";
    change(protocol);
    const stateful = overlay.querySelector<HTMLInputElement>('[aria-label="Keep Responses conversation state"]')!;
    stateful.checked = true; // manual ON — the probe must override it
    change(stateful);

    const detect = [...overlay.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Detect models")!;
    detect.click();
    await new Promise((r) => setTimeout(r, 0));
    overlay.querySelector<HTMLElement>(".th-picker-row")!.click();

    // Without the checkbox the manual value ships as-is. The stub fails the
    // first add so the wizard stays open for the probe-on-add pass.
    const add = () => [...overlay.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => /Add 1 provider/.test(b.textContent ?? ""))!;
    add().click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(probes.length, 0);
    assert.equal(adds.at(-1)!.responsesStateful, true);

    // With the checkbox the verdict replaces the manual choice.
    overlay.querySelector<HTMLInputElement>(".th-probe-onadd input")!.checked = true;
    add()!.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(probes[0], { baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "", modelId: "glm-4.7" });
    assert.equal(adds.at(-1)!.responsesStateful, false, "probe verdict becomes the saved value");
  } finally {
    overlay.remove();
  }
});
