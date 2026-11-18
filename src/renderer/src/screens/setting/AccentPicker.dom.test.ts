import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { AccentPicker } from "./AccentPicker.js";
import {
  deriveOnAccent, getTheme, themeDefaultAccent, type ThemeId,
} from "../../state/theme.js";

describe("AccentPicker color resolution", () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  before(() => {
    const dom = parseHTML("<!doctype html><html><body></body></html>");
    Object.assign(globalThis, { document: dom.document });
  });
  after(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  });

  for (const themeId of ["dark", "light"] satisfies ThemeId[]) {
    it(`renders Auto, preset and custom colors for the ${themeId} theme`, () => {
      document.documentElement.dataset.theme = themeId;
      const picker = new AccentPicker();
      for (const [value, expectedHex] of [
        ["auto", themeDefaultAccent(getTheme(themeId))],
        ["teal", themeId === "light" ? "#0e7d80" : "#c8ff00"],
        ["violet", themeId === "light" ? "#6d3fc4" : "#b65cff"],
        ["blue", themeId === "light" ? "#006bd6" : "#00e5ff"],
        ["#A855F7", "#a855f7"],
        ["unknown-color", themeDefaultAccent(getTheme(themeId))],
      ]) {
        picker.value = value!;
        assert.equal(
          picker.el.querySelector<HTMLElement>(".setting-swatch-split")!.style.background,
          `linear-gradient(135deg, ${themeDefaultAccent(getTheme("dark"))} 0 50%, ${themeDefaultAccent(getTheme("light"))} 50% 100%)`,
        );
        assert.equal(picker.el.querySelector(".setting-accent-hex")!.textContent, expectedHex);
        assert.doesNotMatch(picker.el.querySelector(".setting-accent-meta")!.textContent!, /NaN/);
        const check = picker.el.querySelector<HTMLElement>(".setting-swatch.is-selected .setting-swatch-check")!;
        assert.equal(check.style.color, deriveOnAccent(expectedHex!));
      }
      assert.equal(picker.value, "auto");
    });
  }
});
