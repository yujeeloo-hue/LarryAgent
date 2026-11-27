import assert from "node:assert/strict";
import Module from "node:module";
import { before, beforeEach, describe, it } from "node:test";
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
  KeyboardEvent: dom.window.Event,
  requestAnimationFrame: (callback: () => void) => {
    callback();
    return 0;
  },
});
Object.assign(dom.window, {
  jellybot: {
    probeLlmModels: async () => ({
      ok: true,
      models: ["liquid/d1.2", "openai/gpt-5", "typesafe/jev-1.14"],
      decisionModels: ["liquid/d1.2", "typesafe/jev-1.14"],
    }),
  },
});

let showProviderWizard: typeof import("./ProviderWizardView.js").showProviderWizard;
before(async () => {
  ({ showProviderWizard } = await import("./ProviderWizardView.js"));
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function rowFor(model: string): HTMLElement {
  const name = Array.from(document.querySelectorAll<HTMLElement>(".pw-row .pw-model")).find((n) => n.textContent?.startsWith(model));
  const row = name?.closest<HTMLElement>(".pw-row");
  assert.ok(row, `row for ${model}`);
  return row;
}

function button(label: RegExp): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => label.test(b.textContent ?? ""));
  assert.ok(found, `button ${label}`);
  return found;
}

describe("provider wizard decision models", () => {
  beforeEach(() => document.body.replaceChildren());

  it("groups decision models, allows one, and returns it apart from chat models", async () => {
    const result = showProviderWizard({ existingDecisionModel: null });
    const inputs = document.querySelectorAll<HTMLInputElement>("input");
    inputs[0]!.value = "https://openrouter.ai/api/v1";
    Array.from(inputs).find((i) => i.type === "password")!.value = "sk-or-test";
    button(/Detect models/).click();
    await flush();

    const header = document.querySelector(".pw-group-static");
    assert.match(header?.textContent ?? "", /Decision models \(2\)/);
    assert.match(rowFor("typesafe/jev-1.14").textContent ?? "", /decision model/);

    rowFor("liquid/d1.2").click();
    rowFor("typesafe/jev-1.14").click();
    assert.equal(rowFor("liquid/d1.2").getAttribute("aria-checked"), "false");
    assert.equal(rowFor("typesafe/jev-1.14").getAttribute("aria-checked"), "true");
    assert.equal(button(/^Add /).textContent, "Add decision model");

    rowFor("openai/gpt-5").click();
    assert.equal(button(/^Add /).textContent, "Add 1 provider + decision model");
    button(/^Add /).click();
    const pick = await result;
    assert.deepEqual(pick?.models, ["openai/gpt-5"]);
    assert.equal(pick?.decisionModel, "typesafe/jev-1.14");
    assert.equal(pick?.baseUrl, "https://openrouter.ai/api/v1");
  });

  it("keeps decision models out of Select all", async () => {
    const result = showProviderWizard();
    const inputs = document.querySelectorAll<HTMLInputElement>("input");
    inputs[0]!.value = "https://openrouter.ai/api/v1";
    Array.from(inputs).find((i) => i.type === "password")!.value = "sk-or-test";
    button(/Detect models/).click();
    await flush();
    button(/Select all/).click();
    button(/^Add /).click();
    const pick = await result;
    assert.deepEqual(pick?.models, ["openai/gpt-5"]);
    assert.equal(pick?.decisionModel, undefined);
  });
});
