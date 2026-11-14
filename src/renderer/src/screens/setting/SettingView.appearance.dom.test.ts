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
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  Event: dom.window.Event,
  requestAnimationFrame: () => 0,
});
Object.assign(dom.window, { jellybot: { onRemoteStatus: () => () => {} } });
let SettingView: typeof import("./SettingView.js").SettingView;
let snapFontScale: typeof import("./SettingView.js").snapFontScale;
before(async () => {
  ({ SettingView, snapFontScale } = await import("./SettingView.js"));
});

test("appearance card carries the two text-size dropdowns", () => {
  const view = new SettingView();
  const card = view.root.querySelector('[data-card="appearance"]')!;
  assert.ok(card.querySelector(".setting-accent"), "accent picker present");
  assert.equal(card.querySelectorAll(".setting-field-row-2").length, 2);
  assert.ok(view.uiFontScaleSelect.el.closest("[data-card='appearance']"));
  assert.ok(view.chatFontScaleSelect.el.closest("[data-card='appearance']"));
  assert.deepEqual(
    Array.from(view.uiFontScaleSelect.el.querySelectorAll(".app-dropdown-option")).map(
      (row) => row.getAttribute("aria-selected"),
    ),
    ["false", "true", "false", "false"],
  );
  assert.equal(
    view.chatFontScaleSelect.el.querySelectorAll(".app-dropdown-option").length,
    5,
  );
});

test("getAppearanceValues returns numeric scales", () => {
  const view = new SettingView();
  assert.deepEqual(
    view.getAppearanceValues(),
    { themeId: "dark", accentColor: "auto", uiFontScale: 1, chatFontScale: 1 },
  );
  view.uiFontScaleSelect.value = "1.15";
  view.chatFontScaleSelect.value = "1.25";
  const values = view.getAppearanceValues();
  assert.equal(values.uiFontScale, 1.15);
  assert.equal(values.chatFontScale, 1.25);
});

test("snapFontScale maps persisted numbers to the nearest preset", () => {
  const options = [
    { value: "0.9" },
    { value: "1" },
    { value: "1.1" },
    { value: "1.25" },
    { value: "1.5" },
  ];
  assert.equal(snapFontScale(1, options), "1");
  assert.equal(snapFontScale(1.25, options), "1.25");
  assert.equal(snapFontScale(1.12, options), "1.1");
  assert.equal(snapFontScale(1.19, options), "1.25");
  assert.equal(snapFontScale(Number.NaN, options), "0.9");
  assert.equal(snapFontScale(99, options), "1.5");
});
