import assert from "node:assert/strict";
import Module from "node:module";
import { before, test } from "node:test";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.includes("?raw")) return "";
  // Vite `?url` asset imports (e.g. cocoIcon svg urls) exist only after the
  // build pipeline resolves them; stub them like ?raw so node:test can load
  // the module graph. The value is only ever used as an <img src> string.
  if (request.includes("?url")) return request.slice(0, request.indexOf("?url"));
  return originalLoad.call(this, request, parent, isMain);
};
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document: dom.document, window: dom.window, Event: dom.window.Event, requestAnimationFrame: () => 0 });
Object.assign(dom.window, { jellybot: { onRemoteStatus: () => () => {} } });
const textareaProto = Object.getPrototypeOf(dom.document.createElement("textarea"));
Object.assign(textareaProto, { setCustomValidity: () => {}, reportValidity: () => true });
const selectProto = Object.getPrototypeOf(dom.document.createElement("select"));
Object.defineProperty(selectProto, "value", {
  configurable: true,
  get(this: HTMLSelectElement) { return this.querySelector("option[selected]")?.getAttribute("value") ?? this.querySelector("option")?.getAttribute("value") ?? ""; },
  set(this: HTMLSelectElement, value: string) { for (const option of this.querySelectorAll("option")) option.toggleAttribute("selected", option.value === value); },
});
let SettingView: typeof import("./SettingView.js").SettingView;
let showProviderWizard: typeof import("../../ui/ProviderWizardView.js").showProviderWizard;
before(async () => {
  ({ SettingView } = await import("./SettingView.js"));
  ({ showProviderWizard } = await import("../../ui/ProviderWizardView.js"));
});

test("editing unrelated provider fields preserves explicit protocol and hosted options", () => {
  const provider = { id: "p", name: "P", baseUrl: "https://example.com/v1", modelId: "m", supportsMultimodal: false, imageInput: "url" as const, rawEndpoint: false, apiProtocol: "responses" as const, responsesTools: [{ type: "web_search" }], responsesStateful: false };
  const tools = dom.document.createElement("textarea");
  tools.value = JSON.stringify(provider.responsesTools);
  Object.assign(tools, { setCustomValidity: () => {} });
  const protocol = dom.document.createElement("select");
  protocol.innerHTML = '<option value="responses">Responses</option>';
  const image = dom.document.createElement("select");
  image.innerHTML = '<option value="url">URL</option>';
  const view = Object.assign(Object.create(SettingView.prototype), {
    providers: [provider], selectedProviderId: "p",
    nameInput: { value: "Renamed" }, baseUrlInput: { value: "https://api.openai.com/v1/chat/completions" }, modelIdInput: { value: "new-model" },
    multimodalToggle: { checked: true }, toolRoleImagesToggle: { checked: false, disabled: false }, imageInputSelect: image, rawEndpointToggle: { checked: true },
    apiProtocolSelect: protocol, responsesToolsInput: tools, responsesStatefulToggle: { checked: false },
    apiProtocolHint: dom.document.createElement("span"), responsesOptionsBlock: dom.document.createElement("div"),
  }) as InstanceType<typeof SettingView>;
  view.commitSelectedDetailToModel();
  assert.equal(provider.apiProtocol, "responses");
  assert.deepEqual(provider.responsesTools, [{ type: "web_search" }]);
  assert.equal(provider.responsesStateful, false);
  assert.equal(provider.name, "Renamed");
  (view as unknown as { refreshApiProtocol(): void }).refreshApiProtocol();
  assert.match(view.apiProtocolHint.textContent!, /Selected: Responses/);
  assert.match(view.apiProtocolHint.textContent!, /chat\/completions$/);
});

test("manual wizard choices survive URL changes and reach the selected profile", async () => {
  const result = showProviderWizard();
  const click = (text: string): void => {
    const button = [...dom.document.querySelectorAll("button")].find((item) => item.textContent === text)!;
    button.dispatchEvent(new dom.window.Event("click"));
  };
  const protocols = dom.document.querySelectorAll("select");
  protocols[0]!.value = "chat_completions";
  protocols[0]!.dispatchEvent(new dom.window.Event("change"));
  click("Manual add…");
  const manual = dom.document.querySelectorAll(".pw-page")[2]!;
  const inputs = manual.querySelectorAll('input[type="text"]');
  inputs[0]!.value = "https://api.openai.com/v1/responses/?tenant=org/";
  inputs[0]!.dispatchEvent(new dom.window.Event("input"));
  inputs[1]!.value = "model-example";
  assert.equal(protocols[1]!.value, "chat_completions");
  assert.match(manual.textContent!, /Selected: Chat Completions/);
  click("Add provider");
  const picked = await result;
  assert.equal(picked!.apiProtocol, "chat_completions");
  assert.equal(picked!.baseUrl, "https://api.openai.com/v1/responses?tenant=org/");
});

test("wizard full endpoint mode preserves the exact path slash and query", async () => {
  const result = showProviderWizard();
  [...dom.document.querySelectorAll("button")].find((button) => button.textContent === "Manual add…")!.dispatchEvent(new dom.window.Event("click"));
  const manual = dom.document.querySelectorAll(".pw-page")[2]!;
  const raw = manual.querySelector('input[type="checkbox"]') as HTMLInputElement;
  raw.checked = true;
  raw.dispatchEvent(new dom.window.Event("change"));
  const inputs = manual.querySelectorAll('input[type="text"]');
  inputs[0]!.value = " https://signed.example/invoke/?tenant=x/&sig=abc/ ";
  inputs[1]!.value = "native";
  [...manual.querySelectorAll("button")].find((button) => button.textContent === "Add provider")!.dispatchEvent(new dom.window.Event("click"));
  const picked = await result;
  assert.equal(picked!.rawEndpoint, true);
  assert.equal(picked!.baseUrl, "https://signed.example/invoke/?tenant=x/&sig=abc/");
});

test("hosted tool switches save defaults and preserve advanced tools across provider changes", () => {
  const view = new SettingView();
  const customTools = [
    { type: "web_search", filters: { allowed_domains: ["example.com"] }, search_context_size: "low" },
    { type: "code_interpreter", container: { type: "auto", file_ids: ["file-existing"] } },
    { type: "file_search", vector_store_ids: ["vs-existing"] },
    { type: "mcp", server_label: "workspace", server_url: "https://mcp.example" },
  ];
  const base = { baseUrl: "https://api.openai.com/v1", modelId: "model-example", supportsMultimodal: false, imageInput: "url" as const, rawEndpoint: false, apiProtocol: "responses" as const };
  view.setProvidersLocal([
    { ...base, id: "p1", name: "First", responsesTools: customTools },
    { ...base, id: "p2", name: "Second", responsesTools: [{ type: "image_generation", quality: "high" }] },
  ], "p1", "p1");
  assert.equal(view.responsesWebSearchToggle.checked, true);
  assert.equal(view.responsesCodeExecutionToggle.checked, true);
  assert.equal(view.responsesImageGenerationToggle.checked, false);
  assert.equal(view.responsesToolsInput.closest("details")!.hasAttribute("open"), false);
  let saved: import("./SettingView.js").SettingProviderForm[] = [];
  view.responsesToolsInput.addEventListener("input", () => { saved = JSON.parse(JSON.stringify(view.getProvidersDraft())); });
  const toggle = (input: HTMLInputElement, enabled: boolean): void => {
    input.checked = enabled;
    input.dispatchEvent(new dom.window.Event("change"));
  };
  toggle(view.responsesImageGenerationToggle, true);
  assert.deepEqual(saved[0]!.responsesTools, [...customTools, { type: "image_generation" }]);
  view.providerListEl.querySelectorAll(".setting-provider-row")[1]!.dispatchEvent(new dom.window.Event("click"));
  assert.equal(view.getSelectedProviderId(), "p2");
  assert.equal(view.responsesWebSearchToggle.checked, false);
  assert.equal(view.responsesCodeExecutionToggle.checked, false);
  assert.equal(view.responsesImageGenerationToggle.checked, true);
  toggle(view.responsesCodeExecutionToggle, true);
  assert.deepEqual(saved[1]!.responsesTools, [{ type: "image_generation", quality: "high" }, { type: "code_interpreter", container: { type: "auto" } }]);
  toggle(view.responsesWebSearchToggle, true);
  assert.deepEqual(saved[1]!.responsesTools!.at(-1), { type: "web_search" });
  toggle(view.responsesImageGenerationToggle, false);
  assert.deepEqual(saved[1]!.responsesTools, [{ type: "code_interpreter", container: { type: "auto" } }, { type: "web_search" }]);
  // Simulate the saved settings returning from main, then select the first profile.
  view.setProvidersLocal(saved, "p2", "p1");
  view.providerListEl.querySelectorAll(".setting-provider-row")[0]!.dispatchEvent(new dom.window.Event("click"));
  assert.equal(view.getSelectedProviderId(), "p1");
  assert.deepEqual(JSON.parse(view.responsesToolsInput.value), [...customTools, { type: "image_generation" }]);
  assert.equal(view.responsesWebSearchToggle.checked, true);
  assert.equal(view.responsesCodeExecutionToggle.checked, true);
  assert.equal(view.responsesImageGenerationToggle.checked, true);
});

test("advanced JSON edits update native switches without replacing configured options", () => {
  const view = new SettingView();
  view.setProvidersLocal([{ id: "p", name: "P", baseUrl: "https://api.openai.com/v1", modelId: "m", supportsMultimodal: false, imageInput: "url", rawEndpoint: false }], "p", "p");
  const tools = [{ type: "web_search_preview", search_context_size: "high" }, { type: "image_generation", background: "transparent" }, { type: "mcp", server_label: "keep" }];
  view.responsesToolsInput.value = JSON.stringify(tools);
  view.responsesToolsInput.dispatchEvent(new dom.window.Event("input"));
  assert.equal(view.responsesWebSearchToggle.checked, true);
  assert.equal(view.responsesImageGenerationToggle.checked, true);
  assert.equal(view.responsesCodeExecutionToggle.checked, false);
  // Enabling an already configured family preserves its exact advanced definition.
  view.responsesWebSearchToggle.dispatchEvent(new dom.window.Event("change"));
  assert.deepEqual(JSON.parse(view.responsesToolsInput.value), tools);
  view.responsesWebSearchToggle.checked = false;
  view.responsesWebSearchToggle.dispatchEvent(new dom.window.Event("change"));
  assert.deepEqual(view.getProvidersDraft()[0]!.responsesTools, tools.slice(1));
});

test("state retention defaults off and stays implicit until explicitly changed", () => {
  const view = new SettingView();
  const base = { modelId: "kimi-for-coding", supportsMultimodal: false, imageInput: "url" as const, rawEndpoint: false };
  view.setProvidersLocal([
    { ...base, id: "kimi", name: "Kimi", baseUrl: "https://api.kimi.com/coding/v1?tenant=one/" },
    { ...base, id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
    { ...base, id: "explicit", name: "Explicit Kimi", baseUrl: "https://api.kimi.com/coding/v1/responses", responsesStateful: true },
  ], "kimi", "kimi");
  assert.match(view.apiProtocolHint.textContent!, /Auto: Responses/);
  assert.equal(view.responsesStatefulToggle.checked, false);
  view.nameInput.value = "Renamed Kimi";
  assert.equal("responsesStateful" in view.getProvidersDraft()[0]!, false, "editing another setting must not turn a default into an explicit override");

  view.baseUrlInput.value = "https://unknown.example/v1/responses";
  view.baseUrlInput.dispatchEvent(new dom.window.Event("input"));
  assert.equal(view.responsesStatefulToggle.checked, false);
  view.baseUrlInput.value = "https://api.kimi.com/coding/v1";
  view.baseUrlInput.dispatchEvent(new dom.window.Event("input"));
  assert.equal(view.responsesStatefulToggle.checked, false);
  assert.equal("responsesStateful" in view.getProvidersDraft()[0]!, false);

  view.responsesStatefulToggle.checked = true;
  view.responsesStatefulToggle.dispatchEvent(new dom.window.Event("change"));
  const saved = JSON.parse(JSON.stringify(view.getProvidersDraft())) as import("./SettingView.js").SettingProviderForm[];
  assert.equal(saved[0]!.responsesStateful, true);
  view.setProvidersLocal(saved, "kimi", "kimi");
  assert.equal(view.responsesStatefulToggle.checked, true, "an explicit override must survive a settings round trip");
  view.providerListEl.querySelectorAll(".setting-provider-row")[1]!.dispatchEvent(new dom.window.Event("click"));
  assert.equal(view.responsesStatefulToggle.checked, false, "OpenAI uses the same stateless default");
  view.providerListEl.querySelectorAll(".setting-provider-row")[2]!.dispatchEvent(new dom.window.Event("click"));
  assert.equal(view.responsesStatefulToggle.checked, true, "Kimi's explicit choice takes precedence over its profile default");
});
