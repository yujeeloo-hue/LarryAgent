import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  COMPOSER_MODE_COLORS,
  DEFAULT_CUSTOM_GRAPH_COLOR,
  composerAccentColor,
  normalizeHexColor,
} from "./composerAccent.js";

describe("composerAccent", () => {
  it("builtin modes: Ask reads blue, Plan reads amber, Auto keeps the app tint", () => {
    assert.equal(composerAccentColor("ask"), COMPOSER_MODE_COLORS.ask);
    assert.equal(composerAccentColor("plan"), COMPOSER_MODE_COLORS.plan);
    assert.equal(composerAccentColor("agent"), null);
  });

  it("custom graphs use the stored color, falling back to violet", () => {
    assert.equal(composerAccentColor("custom", "#ff8800"), "#ff8800");
    assert.equal(
      composerAccentColor("custom", null),
      DEFAULT_CUSTOM_GRAPH_COLOR,
    );
    assert.equal(composerAccentColor("custom"), DEFAULT_CUSTOM_GRAPH_COLOR);
    // Invalid stored colors must not leak into the border.
    assert.equal(
      composerAccentColor("custom", "rgb(1, 2, 3)"),
      DEFAULT_CUSTOM_GRAPH_COLOR,
    );
    assert.equal(
      composerAccentColor("custom", "#xyz123"),
      DEFAULT_CUSTOM_GRAPH_COLOR,
    );
  });

  it("normalizes hex casing/whitespace and rejects malformed values", () => {
    assert.equal(normalizeHexColor("  #A78BFA  "), "#a78bfa");
    assert.equal(normalizeHexColor("#A78BFA"), "#a78bfa");
    assert.equal(normalizeHexColor("#a78bf"), null);
    assert.equal(normalizeHexColor("rgb(1,2,3)"), null);
    assert.equal(normalizeHexColor(""), null);
    assert.equal(normalizeHexColor(null), null);
    assert.equal(normalizeHexColor(123 as unknown as string), null);
  });

  it("CSS: the accent border is gated on focus — resting frame keeps the default color", () => {
    const css = readFileSync(
      new URL("./task-composer.css", import.meta.url),
      "utf8",
    );
    // Accent tint applies only while the composer holds focus…
    assert.match(css, /\.task-composer\.has-accent:focus-within\s*{/);
    assert.match(
      css,
      /\.task-composer\.has-accent:not\(\.is-file-drag\):focus-within\s*{/,
    );
    // …and there is no unconditional has-accent border rule left that would
    // recolor the resting (unfocused) frame.
    assert.doesNotMatch(css, /\.task-composer\.has-accent\s*{/);
    assert.doesNotMatch(
      css,
      /\.task-composer\.has-accent:not\(\.is-file-drag\)\s*{/,
    );
  });
});
