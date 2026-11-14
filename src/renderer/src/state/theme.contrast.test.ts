import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACCENT_PRESETS, bubbleUserTokens, THEMES } from "./theme.js";

/*
 * WCAG AA contrast gate for the light theme (docs/theme-contrast.md).
 * Every pair the calibration table covers must keep clearing its threshold
 * so token tweaks cannot silently reintroduce a low-contrast regression.
 * Re-generate the human table with: node --import tsx scripts/contrast-report.mjs
 */

const hex = (h: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  assert.ok(m, "not a #rrggbb literal: " + h);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const chan = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const luminance = (rgb: readonly number[]): number =>
  0.2126 * chan(rgb[0]!) + 0.7152 * chan(rgb[1]!) + 0.0722 * chan(rgb[2]!);
const ratio = (a: readonly number[], b: readonly number[]): number => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

type Rgb = [number, number, number];
const resolve = (tokens: Record<string, string>, name: string): Rgb => {
  const v = tokens[name]!;
  if (v.startsWith("#")) return hex(v);
  const m =
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(
      v,
    );
  assert.ok(m, "unresolvable token " + name + " = " + v);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const over = (fg: readonly number[], base: readonly number[]): Rgb => {
  const a = fg[3] ?? 1;
  return [0, 1, 2].map((i) =>
    Math.round(fg[i]! * a + base[i]! * (1 - a)),
  ) as Rgb;
};

/** [label, fgToken | #rrggbb, bgToken | #rrggbb, threshold] */
const PAIRS: readonly (readonly [string, string, string, number])[] = [
  ["body text / page", "--fg", "--bg", 4.5],
  ["body text / elevated", "--fg", "--bg-elevated", 4.5],
  ["body text / surface-2", "--fg", "--surface-2", 4.5],
  ["body text / user bubble", "--fg", "--bubble-user-bg", 4.5],
  ["muted text / page", "--fg-muted", "--bg", 4.5],
  ["muted text / elevated", "--fg-muted", "--bg-elevated", 4.5],
  ["muted text / surface-2", "--fg-muted", "--surface-2", 4.5],
  ["dim text / page", "--fg-dim", "--bg", 4.5],
  ["dim text / surface-2", "--fg-dim", "--surface-2", 4.5],
  ["accent text / page", "--accent", "--bg", 4.5],
  ["accent text / elevated", "--accent", "--bg-elevated", 4.5],
  ["accent text / surface-2", "--accent", "--surface-2", 4.5],
  ["on-accent / accent fill", "--on-accent", "--accent", 4.5],
  ["on-gold / gold fill", "--on-gold", "--gold-fill", 4.5],
  ["danger text / page", "--danger-text", "--bg", 4.5],
  ["danger text / elevated", "--danger-text", "--bg-elevated", 4.5],
  ["danger muted / page", "--danger-muted", "--bg", 4.5],
  ["danger solid / page", "--danger", "--bg", 4.5],
  ["success text / page", "--success-text", "--bg", 4.5],
  ["success text / elevated", "--success-text", "--bg-elevated", 4.5],
  ["success fill pip / page", "--success", "--bg", 4.5],
  ["warn text / page", "--warn-text", "--bg", 4.5],
  ["warn text / elevated", "--warn-text", "--bg-elevated", 4.5],
  ["link / page", "--link", "--bg", 4.5],
  ["unread / page", "--unread", "--bg", 4.5],
  ["vcs added / elevated", "--vcs-added", "--bg-elevated", 4.5],
  ["vcs modified / elevated", "--vcs-modified", "--bg-elevated", 4.5],
  ["vcs deleted / elevated", "--vcs-deleted", "--bg-elevated", 4.5],
  ["vcs untracked / elevated", "--vcs-untracked", "--bg-elevated", 4.5],
  ["vcs renamed / elevated", "--vcs-renamed", "--bg-elevated", 4.5],
  ["log debug / elevated", "--log-debug", "--bg-elevated", 4.5],
  ["log info / elevated", "--log-info", "--bg-elevated", 4.5],
  ["log warn / elevated", "--log-warn", "--bg-elevated", 4.5],
  ["log error / elevated", "--log-error", "--bg-elevated", 4.5],
  ["focus ring / page (UI 3:1)", "--focus-border", "--bg", 3],
  ["gold badge / terminal island (UI 3:1)", "--badge-gold", "--code-surface", 3],
  ["gold badge / graph canvas (UI 3:1)", "--badge-gold", "#101010", 3],
  ["send glyph / light glass mist (UI 3:1)", "--send-icon", "#e5effc", 3],
  /* EffortSeg MAX label: plain --on-gold (#1a1408) on the solid gold-fill
     thumb — on-thumb pair above; vs-page pairs kept as belt-and-braces. */
  ["effort MAX label / page", "#1a1408", "--bg", 4.5],
  ["effort MAX label / elevated", "#1a1408", "--bg-elevated", 4.5],
  ["effort MAX label / surface-2", "#1a1408", "--surface-2", 4.5],
  /* Send glyph: white on the gradient family mids (idle blue / amber /
     violet→rose) — precomputed against the lightest mid. */
  ["send glyph / gradient mid (UI 3:1)", "#ffffff", "#dd7209", 3],
];

describe("light theme WCAG AA contrast gate", () => {
  const light = THEMES.find((t) => t.id === "light")!;
  const page = resolve(light.tokens, "--bg");

  it("clears every calibrated pair in docs/theme-contrast.md", () => {
    const failures: string[] = [];
    for (const [label, fgRef, bgRef, min] of PAIRS) {
      const fgRaw = fgRef.startsWith("#") ? hex(fgRef) : resolve(light.tokens, fgRef);
      const bgRaw = bgRef.startsWith("#") ? hex(bgRef) : resolve(light.tokens, bgRef);
      const fg = fgRaw.length === 4 ? over(fgRaw, page) : fgRaw;
      const bg = bgRaw.length === 4 ? over(bgRaw, page) : bgRaw;
      const r = ratio(fg, bg);
      if (r < min) {
        failures.push(`${label}: ${r.toFixed(2)} < ${min} (${fgRef} on ${bgRef})`);
      }
    }
    assert.deepEqual(failures, [], "AA contrast regressions:\n" + failures.join("\n"));
  });

  it("covers exactly the documented 42 pairs", () => {
    // 2026-10-23: −edit-bubble pair (mid-turn prompt editor removed).
    assert.equal(PAIRS.length, 42);
  });
});

describe("accent-derived user bubble WCAG AA gate", () => {
  // The bubble re-hues to the Settings accent; every preset (and the
  // extreme custom hexes) must keep body text readable on the derived
  // fill, composited over the theme page background like the shipped
  // rgba fill (see "body text / user bubble" in the table above).
  const cases: [string, string, "dark" | "light"][] = [
    ...ACCENT_PRESETS.flatMap((p): [string, string, "dark" | "light"][] => [
      [p.id, p.dark, "dark"],
      [p.id, p.light, "light"],
    ]),
    ["custom white", "#ffffff", "dark"],
    ["custom white", "#ffffff", "light"],
    ["custom black", "#000000", "dark"],
    ["custom black", "#000000", "light"],
  ];

  it("keeps --fg ≥ 4.5:1 on the derived bubble fill for every accent", () => {
    const failures: string[] = [];
    for (const [name, hexValue, themeId] of cases) {
      const theme = THEMES.find((t) => t.id === themeId)!;
      const page = resolve(theme.tokens, "--bg");
      const fg = resolve(theme.tokens, "--fg");
      const bubble = bubbleUserTokens(hexValue, themeId === "light");
      const raw = resolve({ "--b": bubble["--bubble-user-bg"] }, "--b");
      const fill = raw.length === 4 ? over(raw, page) : raw;
      const r = ratio(fg, fill);
      if (r < 4.5) {
        failures.push(`${name}/${themeId}: ${r.toFixed(2)} on ${bubble["--bubble-user-bg"]}`);
      }
    }
    assert.deepEqual(failures, [], "accent bubble AA regressions:\n" + failures.join("\n"));
  });
});
