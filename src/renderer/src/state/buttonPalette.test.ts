import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buttonPaletteTokens } from "./buttonPalette.js";
import { ACCENT_PRESETS, accentOverrideCss, contrastRatio, getTheme, themeToCss } from "./theme.js";

describe("semantic button palette", () => {
  it("uses the approved system-blue and danger recipes", () => {
    const light = buttonPaletteTokens("#006bd6", true);
    const dark = buttonPaletteTokens("#7ec8c8", false);
    assert.equal(light["--button-primary-bg"], "#006bd6");
    assert.equal(light["--button-primary-fg"], "#ffffff");
    assert.equal(light["--button-danger-bg"], "#c93636");
    assert.equal(light["--button-danger-fg"], "#ffffff");
    assert.equal(dark["--button-primary-bg"], "#7ec8c8");
    assert.equal(dark["--button-primary-fg"], "#111111");
    assert.equal(dark["--button-danger-bg"], "rgba(248, 81, 73, 0.14)");
    assert.equal(dark["--button-danger-fg"], "#ff8580");
  });

  it("keeps primary text readable through every state for presets and custom hues", () => {
    const colors = new Set(ACCENT_PRESETS.flatMap((p) => [p.dark, p.light]));
    // A coarse RGB cube includes pale colors, saturated primaries, and the
    // middle-luminance crossover where near-black and white both fall short.
    for (let r = 0; r <= 255; r += 17) {
      for (let g = 0; g <= 255; g += 17) {
        for (let b = 0; b <= 255; b += 17) {
          colors.add("#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join(""));
        }
      }
    }
    for (const light of [true, false]) {
      for (const accent of colors) {
        const tokens = buttonPaletteTokens(accent, light);
        if (light) assert.equal(tokens["--button-primary-fg"], "#ffffff");
        for (const suffix of ["", "-hover", "-active"]) {
          const ratio = contrastRatio(tokens["--button-primary-fg"]!, tokens[`--button-primary-bg${suffix}`]!);
          assert.ok(ratio >= 4.5, `${accent} ${light ? "Light" : "Dark"} ${suffix}: ${ratio}`);
        }
      }
    }
  });

  it("keeps red text readable on dark danger fills over page and elevated surfaces", () => {
    const tokens = buttonPaletteTokens("#7ec8c8", false);
    for (const backdrop of [20, 27, 13]) {
      for (const suffix of ["", "-hover", "-active"]) {
        const rgba = tokens[`--button-danger-bg${suffix}`]!.match(/[\d.]+/g)!.map(Number);
        const alpha = rgba[3]!;
        const fill = "#" + rgba.slice(0, 3).map((channel) =>
          Math.round(channel * alpha + backdrop * (1 - alpha)).toString(16).padStart(2, "0"),
        ).join("");
        assert.ok(contrastRatio(tokens["--button-danger-fg"]!, fill) >= 4.5, `${backdrop} ${suffix}`);
      }
    }
    const light = buttonPaletteTokens("#006bd6", true);
    for (const suffix of ["", "-hover", "-active"]) {
      assert.ok(contrastRatio(light["--button-danger-fg"]!, light[`--button-danger-bg${suffix}`]!) >= 4.5);
    }
  });

  it("follows runtime accents in both appearances without changing the accent itself", () => {
    for (const theme of ["light", "dark"] as const) {
      assert.match(themeToCss(getTheme(theme)), /--button-primary-bg:/);
      const css = accentOverrideCss("#ffeeaa", theme);
      assert.ok(css.includes("--accent:#ffeeaa;"));
      assert.ok(css.includes(`--button-primary-bg:${buttonPaletteTokens("#ffeeaa", theme === "light")["--button-primary-bg"]};`));
      assert.ok(!css.includes("--bg:"));
      assert.equal(accentOverrideCss(null, theme), "");
    }
    assert.equal(buttonPaletteTokens("#ffeeaa", true)["--button-danger-bg"], "#c93636");
  });

  it("keeps list deletion translucent and readable without changing standalone or Dark danger", () => {
    const light = buttonPaletteTokens("#006bd6", true);
    const dark = buttonPaletteTokens("#7ec8c8", false);
    assert.equal(light["--button-danger-bg"], "#c93636");
    assert.equal(light["--button-danger-fg"], "#ffffff");
    for (const suffix of ["", "-hover", "-active"]) {
      assert.equal(dark[`--button-danger-list-bg${suffix}`], dark[`--button-danger-bg${suffix}`]);
      const rgba = light[`--button-danger-list-bg${suffix}`]!.match(/[\d.]+/g)!.map(Number);
      assert.ok(rgba[3]! > 0 && rgba[3]! < 0.3);
      for (const backdrop of ["#ffffff", "#f8fafc", "#eef4fa"]) {
        const base = backdrop.slice(1).match(/../g)!.map((value) => Number.parseInt(value, 16));
        const fill = "#" + rgba.slice(0, 3).map((channel, index) =>
          Math.round(channel * rgba[3]! + base[index]! * (1 - rgba[3]!)).toString(16).padStart(2, "0"),
        ).join("");
        assert.ok(contrastRatio(light["--button-danger-list-fg"]!, fill) >= 4.5, `${suffix} on ${backdrop}`);
      }
    }
    assert.equal(dark["--button-danger-list-fg"], dark["--button-danger-fg"]);
  });
});
