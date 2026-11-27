import assert from "node:assert/strict";
import Module from "node:module";
import { before, describe, it } from "node:test";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const originalLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request.includes("?raw")) return "";
  if (request.includes("?url")) return request.slice(0, request.indexOf("?url"));
  return originalLoad.call(this, request, parent, isMain);
};
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  Event: dom.window.Event,
  requestAnimationFrame: () => 0,
});
Object.assign(dom.window, {
  jellybot: {
    onRemoteStatus: () => () => {},
    getUpdateState: async () => ({ currentVersion: "1.0.0", platform: "win32 x64", maintenance: null, check: null }),
    onUpdateState: () => () => {},
  },
});

type Saved = { name: string; baseUrl: string; modelId: string; id: string } | null;

let SettingView: typeof import("./SettingView.js").SettingView;
let JevModelSettingsController: typeof import("./JevModelSettingsController.js").JevModelSettingsController;
before(async () => {
  ({ SettingView } = await import("./SettingView.js"));
  ({ JevModelSettingsController } = await import("./JevModelSettingsController.js"));
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function fakeBridge(initial: Saved = null, keyConfigured = false) {
  const state = { saved: initial, keyConfigured, writes: [] as Array<Record<string, unknown>>, keys: [] as Array<Record<string, unknown>> };
  const bridge = {
    getSettingsSnapshot: async () => ({
      settings: { jevProvider: state.saved },
      apiKeyConfiguredByProviderId: { jev: state.keyConfigured },
    }),
    saveWorkspaceSettings: async (patch: Record<string, unknown>) => {
      state.writes.push(patch);
      state.saved = (patch.jevProvider as Saved) ?? null;
      return { jevProvider: state.saved };
    },
    setApiKey: async (req: Record<string, unknown>) => {
      state.keys.push(req);
      state.keyConfigured = req.clear !== true;
      return { apiKeyConfigured: state.keyConfigured };
    },
    testJevModel: async () => ({ ok: true, message: "Connected — typesafe/jev-1.14 answered in 300 ms" }),
  };
  return { state, bridge: bridge as never };
}

function card(view: InstanceType<typeof SettingView>): HTMLElement {
  return view.root.querySelector<HTMLElement>('[data-card="jev"]')!;
}

describe("Jev model settings card", () => {
  it("sits in Models as the Decision model card and starts empty with only the add button", async () => {
    const view = new SettingView();
    const { bridge } = fakeBridge();
    const controller = new JevModelSettingsController(view.jevModel, () => bridge);
    await controller.refresh();
    const jev = card(view);
    assert.equal(jev.closest("[role=tabpanel]")?.getAttribute("data-category"), "models");
    assert.equal(jev.querySelector(".setting-card-title")?.textContent, "Decision model");
    assert.equal(jev.querySelector(".setting-card-icon > .app-mono-icon")?.getAttribute("data-functional-icon"), "DecisionModel");
    assert.match(jev.textContent!, /No decision model configured/);
    assert.equal(view.jevModel.addButton.disabled, false);
    assert.equal(view.jevModel.nameInput.closest(".setting-provider-detail")!.hasAttribute("hidden"), true);
    controller.destroy();
  });

  it("adds a profile with defaults, stores the key separately, and tests it", async () => {
    const view = new SettingView();
    const { state, bridge } = fakeBridge();
    const controller = new JevModelSettingsController(view.jevModel, () => bridge);
    await controller.refresh();
    view.jevModel.addButton.click();
    await flush();
    assert.deepEqual(state.writes[0], {
      jevProvider: { id: "jev", name: "Jev", baseUrl: "https://openrouter.ai/api", modelId: "typesafe/jev-1.14" },
    });
    assert.equal(view.jevModel.addButton.disabled, true);

    view.jevModel.apiKeyInput.value = "sk-or-v1-secret";
    view.jevModel.apiKeyInput.dispatchEvent(new dom.window.Event("blur"));
    await flush();
    assert.deepEqual(state.keys.at(-1), { providerId: "jev", apiKey: "sk-or-v1-secret" });
    assert.equal(view.jevModel.apiKeyInput.value, "");
    assert.equal(JSON.stringify(state.writes).includes("secret"), false);

    view.jevModel.testButton.click();
    await flush();
    assert.match(card(view).querySelector(".setting-card-status")!.textContent!, /Connected/);
    controller.destroy();
  });

  it("takes a decision model picked in the provider wizard, replacing the current one", async () => {
    const view = new SettingView();
    const { state, bridge } = fakeBridge({ id: "jev", name: "Jev", baseUrl: "https://openrouter.ai/api", modelId: "typesafe/jev-1.13" }, false);
    const controller = new JevModelSettingsController(view.jevModel, () => bridge);
    await controller.refresh();
    controller.applyDetected({ name: "d1.2", baseUrl: "https://openrouter.ai/api/v1", modelId: "liquid/d1.2", apiKey: "sk-or-wizard" });
    await flush();
    assert.deepEqual(state.writes.at(-1), {
      jevProvider: { id: "jev", name: "d1.2", baseUrl: "https://openrouter.ai/api/v1", modelId: "liquid/d1.2" },
    });
    assert.deepEqual(state.keys.at(-1), { providerId: "jev", apiKey: "sk-or-wizard" });
    assert.deepEqual(controller.currentModel(), { baseUrl: "https://openrouter.ai/api/v1", modelId: "liquid/d1.2" });
    assert.match(card(view).querySelector(".setting-card-status")!.textContent!, /replaced typesafe\/jev-1\.13/);
    controller.destroy();
  });

  it("removes the profile and its key", async () => {
    const view = new SettingView();
    const { state, bridge } = fakeBridge({ id: "jev", name: "Jev", baseUrl: "https://openrouter.ai/api", modelId: "typesafe/jev-1.14" }, true);
    const controller = new JevModelSettingsController(view.jevModel, () => bridge);
    await controller.refresh();
    view.jevModel.deleteButton.click();
    await flush();
    assert.deepEqual(state.writes.at(-1), { jevProvider: null });
    assert.deepEqual(state.keys.at(-1), { providerId: "jev", clear: true });
    assert.match(card(view).textContent!, /No decision model configured/);
    controller.destroy();
  });
});
