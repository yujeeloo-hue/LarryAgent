import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { buttonPaletteTokens } from "./buttonPalette.js";
import {
  ACCENT_PRESETS,
  accentOverrideCss,
  contrastRatio,
  darkIslandCss,
  DEFAULT_THEME_ID,
  deriveOnAccent,
  resolveAccentHex,
  THEMES,
  getTheme,
  isThemeId,
  themeToCss,
  themeDefaultAccent,
  type ThemeId,
} from "./theme.js";

describe("theme model", () => {
  it("has unique ids and includes the default theme", () => {
    const ids = THEMES.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes(DEFAULT_THEME_ID));
  });

  it("keeps the same variable set across every theme", () => {
    const keys = Object.keys(THEMES[0]!.tokens).sort();
    for (const theme of THEMES) {
      assert.deepEqual(Object.keys(theme.tokens).sort(), keys);
    }
  });

  it("default theme mirrors tokens.css values", () => {
    const dark = getTheme("dark");
    assert.equal(dark.tokens["--bg"], "#141414");
    assert.equal(dark.tokens["--fg"], "#e8e8e8");
    assert.equal(dark.tokens["--accent"], "#00e5ff");
  });

  it("isThemeId accepts only known ids", () => {
    assert.ok(isThemeId("dark"));
    assert.ok(isThemeId("light"));
    // Removed theme: graphite no longer resolves (getTheme lands it on dark).
    assert.ok(!isThemeId("graphite"));
    assert.ok(!isThemeId("solar"));
    assert.ok(!isThemeId(undefined));
    assert.ok(!isThemeId(null));
  });

  it("settings picker lists exactly Dark and Light", () => {
    assert.deepEqual(
      THEMES.map((t) => t.id),
      ["dark", "light"],
    );
  });

  it("getTheme falls back to dark for unknown ids", () => {
    assert.equal(getTheme("solar").id, "dark");
    assert.equal(getTheme(undefined).id, "dark");
  });

  it("themeToCss serializes a scoped variable block", () => {
    const css = themeToCss(getTheme("light"));
    assert.match(css, /^:root\[data-theme="light"\]\{/);
    assert.ok(css.includes("--accent:#006bd6;"));
    assert.ok(css.endsWith("}"));
  });

  it("light theme flips surface polarity", () => {
    const light = getTheme("light");
    assert.equal(light.tokens["--tint-rgb"], "0, 0, 0");
    assert.equal(light.tokens["--fg"], "#17202b");
  });

  it("keeps the complete dark token set stable", () => {
    const entries = Object.entries(getTheme("dark").tokens).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const digest = createHash("sha256")
      .update(JSON.stringify(entries))
      .digest("hex");
    // 2026-10: +--shimmer-hi (status-line shimmer bright stop, B plan).
    // 2026-10-23: −--bubble-edit-* (mid-turn prompt editor removed — click
    // now stops the turn; the prompt returns via STOP-rollback).
    // 2026-10-30: default accent becomes cyan (#00e5ff).
    assert.equal(digest, "dac95e3f8044279f475b67859d1633878902adbe45a1ef70e091fa260af55c3e");
  });

  it("code surfaces stay dark in every theme", () => {
    for (const theme of THEMES) {
      assert.equal(theme.tokens["--code-fg"], "#e8e8e8");
      assert.equal(theme.tokens["--code-border"], "rgba(255, 255, 255, 0.08)");
    }
  });

  it("semantic token family lands with dark values and light variants", () => {
    const dark = getTheme("dark");
    const light = getTheme("light");
    assert.equal(dark.tokens["--accent-rgb"], "0, 229, 255");
    assert.equal(dark.tokens["--danger-text"], "#e5534b");
    assert.equal(dark.tokens["--surface-2"], "#1b1b1b");
    assert.equal(dark.tokens["--bubble-user-bg"], "rgba(20, 38, 42, 0.92)");
    assert.equal(light.tokens["--accent-rgb"], "0, 107, 214");
    assert.equal(light.tokens["--on-accent"], "#ffffff");
    assert.equal(light.tokens["--surface-2"], "#eef4fa");
    assert.equal(light.tokens["--danger-text"], "#b91c1c");
    assert.equal(light.tokens["--bubble-user-bg"], "#e5f1ff");
    // Gold fills (#e2b340 dark / #f59e0b light) both carry near-black text:
    // 9.4:1 / 8.5:1 (AA). Light's vivid fill supersedes the old white flip.
    assert.equal(dark.tokens["--on-gold"], "#1a1408");
    assert.equal(light.tokens["--on-gold"], "#1a1408");
    // Gold FILL surfaces get their own vivid token (MAX chip, gold pips);
    // --warn-text stays the AA-calibrated dark text hue.
    assert.equal(dark.tokens["--gold-fill"], "#e2b340");
    assert.equal(light.tokens["--gold-fill"], "#f59e0b");
  });
});

describe("theme ids stay in sync with settings", () => {
  it("settings accepts exactly the renderer theme ids", () => {
    // settings/types.ts declares the same literal union; keep it honest by
    // exercising the shared vocabulary.
    const settingsIds: ThemeId[] = ["dark", "light"];
    for (const id of settingsIds) {
      assert.ok(isThemeId(id));
    }
  });
});

describe("accent override (highlight color)", () => {
  it("theme-adapted presets clear AA as text", () => {
    for (const preset of ACCENT_PRESETS) {
      for (const surface of ["#141414", "#1b1b1b"]) {
        assert.ok(contrastRatio(preset.dark, surface) >= 4.5, preset.id);
      }
      assert.ok(contrastRatio(deriveOnAccent(preset.dark), preset.dark) >= 4.5, preset.id);
      const buttons = buttonPaletteTokens(preset.dark, false);
      for (const state of ["--button-primary-bg", "--button-primary-bg-hover", "--button-primary-bg-active"]) {
        assert.ok(contrastRatio(buttons["--button-primary-fg"]!, buttons[state]!) >= 4.5, `${preset.id} ${state}`);
      }
      assert.ok(contrastRatio(preset.light, "#ffffff") >= 4.5, preset.id);
    }
  });

  it("Blue adapts to dark surfaces while preserving Light's system blue", () => {
    const blue = themeDefaultAccent(getTheme("light"));
    assert.equal(blue, "#006bd6");
    assert.equal(resolveAccentHex("blue", "dark"), "#00e5ff");
    assert.equal(resolveAccentHex("blue", "light"), blue);
    assert.match(accentOverrideCss("blue", "dark"), /--button-primary-bg:#00e5ff;/);
    assert.match(accentOverrideCss("blue", "dark"), /--button-primary-fg:#111111;/);
  });

  it("resolveAccentHex: Auto → null, presets swap per theme, custom passes through", () => {
    assert.equal(resolveAccentHex(null, "dark"), null);
    assert.equal(resolveAccentHex(undefined, "light"), null);
    assert.equal(resolveAccentHex("violet", "dark"), "#b65cff");
    assert.equal(resolveAccentHex("violet", "light"), "#6d3fc4");
    assert.equal(resolveAccentHex("#A855F7", "light"), "#a855f7");
    assert.equal(resolveAccentHex("solar", "dark"), null);
  });

  it("deriveOnAccent splits by luminance like the theme defaults", () => {
    // Bright cyan → near-black text; deep blue → white (mirrors the
    // built-in dark/light --on-accent values).
    assert.equal(deriveOnAccent("#00e5ff"), "#111111");
    assert.equal(deriveOnAccent("#006bd6"), "#ffffff");
    // Mid violet (L≈0.38) reads 7:1 with near-black vs 2.4:1 with white.
    assert.equal(deriveOnAccent("#b695f5"), "#111111");
  });

  it("accentOverrideCss follows accent tokens, bubble and button colors, and omits when Auto", () => {
    assert.equal(accentOverrideCss(null, "dark"), "");
    assert.ok(accentOverrideCss("teal", "light").includes("--accent:#0e7d80;"));
    const css = accentOverrideCss("#a855f7", "light");
    assert.match(css, /^:root\[data-theme="light"\]\{/);
    assert.ok(css.includes("--accent:#a855f7;"));
    assert.ok(css.includes("--accent-rgb:168, 85, 247;"));
    // L≈0.215 sits just past the crossover — near-black reads slightly better.
    assert.ok(css.includes("--on-accent:#111111;"));
    assert.ok(!css.includes("--bg:"));
  });

  it("accent override re-hues the user prompt bubble in both themes", () => {
    // Dark: accent wash over a dark base keeps the 0.92 fill alpha.
    const dark = accentOverrideCss("violet", "dark");
    assert.ok(dark.includes("--bubble-user-bg:rgba(36, 31, 51, 0.92);"));
    assert.ok(dark.includes("--bubble-user-border:rgba(182, 92, 255, 0.35);"));
    // Light: pale accent wash over white, opaque like the shipped token.
    const light = accentOverrideCss("violet", "light");
    assert.ok(light.includes("--bubble-user-bg:#f2eefa;"));
    assert.ok(light.includes("--bubble-user-border:rgba(109, 63, 196, 0.26);"));
    // Auto emits no override, so the theme defaults (teal/blue family) stay.
    assert.equal(accentOverrideCss(null, "light"), "");
  });

  it("dark islands carry the accent-derived bubble too", () => {
    const css = darkIslandCss("light", "violet");
    assert.ok(css.includes("--bubble-user-bg:rgba(36, 31, 51, 0.92);"));
  });
});

describe("dark islands (graph editor keeps Dark under Light)", () => {
  it("emits nothing for the dark theme", () => {
    assert.equal(darkIslandCss("dark", null), "");
    assert.equal(darkIslandCss("dark", "blue"), "");
  });

  it("re-pins the full dark token set on [data-dark-island] under light", () => {
    const css = darkIslandCss("light", null);
    assert.match(css, /^:root\[data-theme="light"\] \[data-dark-island\]\{color-scheme:dark;color:var\(--fg\);/);
    // Surface polarity + neutrals flip back to the dark set.
    assert.ok(css.includes("--fg:#e8e8e8;"));
    assert.ok(css.includes("--bg-elevated:#141414;"));
    assert.ok(css.includes("--surface-2:#1b1b1b;"));
    assert.ok(css.includes("--tint-rgb:255, 255, 255;"));
    assert.ok(css.includes("--shade-rgb:0, 0, 0;"));
    assert.ok(css.includes("--danger-text:#e5534b;"));
    // Default accent (Auto) + the dark button palette ride along.
    assert.ok(css.includes("--accent:#00e5ff;"));
    assert.ok(css.includes("--button-primary-bg:#00e5ff;"));
    assert.ok(css.endsWith("}"));
  });

  it("islands use the dark accent variant under light", () => {
    const css = darkIslandCss("light", "blue");
    assert.ok(css.includes("--accent:#00e5ff;"));
    assert.ok(css.includes("--accent-rgb:0, 229, 255;"));
    assert.ok(css.includes("--button-primary-bg:#00e5ff;"));
    // Custom hexes apply verbatim on both sides.
    const custom = darkIslandCss("light", "#a855f7");
    assert.ok(custom.includes("--accent:#a855f7;"));
    assert.ok(custom.includes("--button-primary-bg:#a855f7;"));
  });
});
