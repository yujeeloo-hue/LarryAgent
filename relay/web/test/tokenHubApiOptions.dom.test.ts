import assert from "node:assert/strict";
import test from "node:test";
import Module from "node:module";
import { parseHTML } from "linkedom";
import type { TokenHubController, TokenHubProvider } from "../src/TokenHubController.js";

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
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
});
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

  const switchesOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLInputElement>(".th-switch input")];
  let switches = switchesOf(responses);
  assert.equal(switches.length, 4, "keep-state + three tool switches");
  assert.equal(switches[0]!.getAttribute("aria-label"), "Keep Responses conversation state for OpenAI");
  assert.deepEqual(switches.map((input) => input.checked), [false, false, true, false]);

  switches[0]!.checked = true;
  change(switches[0]!);
  assert.deepEqual(patches[0], { responsesStateful: true });
  view = applyAndRemount();

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

  tools.value = "[{\"type\":";
  tools.dispatchEvent(new window.Event("input"));
  assert.equal(save.disabled, true);
  assert.match(status.textContent!, /valid JSON/i);

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

  const url = view.querySelector<HTMLInputElement>('[aria-label="Base URL"]')!;
  url.value = "https://api.openai.com/v1/responses";
  url.dispatchEvent(new window.Event("input"));
  assert.match(hint.textContent!, /Responses API/);

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

  const url = view.querySelector<HTMLInputElement>('[aria-label="Base URL"]')!;
  url.value = "https://api.kimi.com/coding/v1/responses";
  url.dispatchEvent(new window.Event("input"));
  assert.equal(stateful.checked, false, "Kimi Coding profile defaults to stateless");

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

    url.value = "https://api.kimi.com/coding/v1/responses";
    url.dispatchEvent(new window.Event("input"));
    assert.ok(!row.hasAttribute("hidden"), "keep-state row visible for a Responses URL");
    assert.equal(stateful.checked, false, "Kimi Coding defaults off in the wizard too");

    protocol.value = "responses";
    change(protocol);
    assert.ok(!row.hasAttribute("hidden"));

    url.value = "https://open.bigmodel.cn/api/paas/v4";
    url.dispatchEvent(new window.Event("input"));
    assert.ok(!row.hasAttribute("hidden"), "explicit protocol keeps the row visible");
    assert.equal(stateful.checked, false, "non-Kimi URL keeps the same default off");

    stateful.checked = false;
    change(stateful);
    url.value = "https://api.openai.com/v1";
    url.dispatchEvent(new window.Event("input"));
    assert.equal(stateful.checked, false, "a touched choice is never re-resolved");

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
    stateful.checked = true;
    change(stateful);

    const detect = [...overlay.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Detect models")!;
    detect.click();
    await new Promise((r) => setTimeout(r, 0));
    overlay.querySelector<HTMLElement>(".th-picker-row")!.click();

    const add = () => [...overlay.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => /Add 1 provider/.test(b.textContent ?? ""))!;
    add().click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(probes.length, 0);
    assert.equal(adds.at(-1)!.responsesStateful, true);

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
