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
    getUpdateState: async () => ({
      currentVersion: "1.5.10",
      platform: "darwin arm64",
      maintenance: null,
      check: null,
    }),
    checkForUpdate: async () => ({
      ok: true,
      entry: {
        version: "1.5.11",
        url: "https://example.invalid/jellybot.zip",
        sha256: "a".repeat(64),
      },
      checkedAt: Date.now(),
      currentVersion: "1.5.10",
      upToDate: false,
    }),
    runUpdate: async () => ({ ok: true }),
    onUpdateState: () => () => {},
  },
});

let SettingView: typeof import("./SettingView.js").SettingView;
before(async () => {
  ({ SettingView } = await import("./SettingView.js"));
});

const flushAsync = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const cursorToggle = (view: InstanceType<typeof SettingView>): HTMLInputElement =>
  view.root.querySelector<HTMLInputElement>('input[name="virtualCursorEnabled"]')!;

describe("SettingView virtual cursor toggle", () => {
  it("lives in Computer Use, without an icon or hint beside the switch, and defaults on", async () => {
    const view = new SettingView();
    await flushAsync();
    const toggle = cursorToggle(view);
    assert.ok(toggle);
    const row = toggle.closest(".setting-toggle-row")!;
    assert.equal(row.closest("[role=tabpanel]")?.getAttribute("data-category"), "computer-use");
    assert.equal(row.children.length, 2);
    assert.equal(row.querySelector("svg, .setting-field-hint"), null);
    assert.match(row.textContent!, /Virtual cursor/);
    assert.equal(toggle.checked, true);
    assert.equal(toggle.getAttribute("aria-checked"), "true");
  });

  it("updates the switch state independently of agent values", async () => {
    const view = new SettingView();
    await flushAsync();
    assert.ok(!("virtualCursorEnabled" in view.getAgentValues()));
    const toggle = cursorToggle(view);
    toggle.checked = false;
    toggle.dispatchEvent(new dom.window.Event("change"));
    assert.equal(toggle.getAttribute("aria-checked"), "false");
  });

  it("does not disable the switch when saving the Agent card", async () => {
    const view = new SettingView();
    await flushAsync();
    const toggle = cursorToggle(view);
    view.setBusy("agent");
    assert.equal(toggle.disabled, false);
    view.setBusy("pointer");
    assert.equal(toggle.disabled, true);
    view.setBusy(null);
    assert.equal(toggle.disabled, false);
  });
});
