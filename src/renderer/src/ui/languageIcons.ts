/**
 * Language icon for editor tabs — rounded badge with the language's brand
 * color and a 1–2 glyph tag (TS / PY / C+ / …), rendered as inline SVG per
 * the app-wide SVG icon rule (no emoji, no icon fonts).
 *
 * Theming: colors ride on the `--libg` (badge fill) / `--lifg` (glyph fill)
 * custom properties, defined per `data-lang` in devmode.css. Dark uses the
 * bright brand colors; Light overrides with deeper variants so white glyphs
 * keep ≥3:1 contrast on a white tab strip.
 *
 * Glyph font: the SVG <text> follows the app-wide `--font-mono` stack
 * (tokens.css) so every platform renders the same face as the editors —
 * the bundled JetBrains Mono webfont on Windows. A hard-coded mac-only
 * stack here used to fall through to Courier New on Windows, whose thin
 * strokes and small caps made the 6.5px glyphs look fuzzy and mis-sized.
 */

import { FileText, createLucideIcon } from "./icons.js";

/** Icon keys mirror devmode/languages.ts FileIconKey. */
export type LanguageIconKey =
  | "csharp"
  | "cpp"
  | "python"
  | "swift"
  | "typescript"
  | "javascript"
  | "css"
  | "html"
  | "xml"
  | "json"
  | "markdown"
  | "txt"
  | "text";

/** Badge glyph per language (kept ≤2 chars for 14px legibility). */
const GLYPHS: Record<Exclude<LanguageIconKey, "text">, string> = {
  csharp: "C#",
  cpp: "C+",
  python: "PY",
  swift: "SW",
  typescript: "TS",
  javascript: "JS",
  css: "CS",
  html: "H5",
  xml: "XM",
  json: "{}",
  markdown: "MD",
  txt: "TX",
};

/**
 * Build the tab icon for a language key. `text` (and unknown keys) fall
 * back to the lucide FileText glyph so plain files stay quiet.
 */
export function createLanguageIcon(key: LanguageIconKey, renderIcon = createLucideIcon): HTMLElement {
  if (key === "text" || !(key in GLYPHS)) {
    const wrap = document.createElement("span");
    wrap.className = "devmode-tab-icon is-plain";
    wrap.setAttribute("aria-hidden", "true");
    wrap.append(renderIcon(FileText, { size: 13 }));
    return wrap;
  }

  const glyph = GLYPHS[key];
  const wrap = document.createElement("span");
  wrap.className = "devmode-tab-icon";
  wrap.dataset.lang = key;
  wrap.setAttribute("aria-hidden", "true");
  wrap.innerHTML =
    `<svg viewBox="0 0 14 14" width="14" height="14" focusable="false">` +
    `<rect width="14" height="14" rx="3.5" fill="var(--libg, currentColor)"/>` +
    `<text x="7" y="7.5" text-anchor="middle" dominant-baseline="middle" ` +
    `font-family="var(--font-mono, ui-monospace, 'SF Mono', Menlo, monospace)" ` +
    `font-size="${glyph.length > 1 ? 6.5 : 8}" font-weight="700" ` +
    `fill="var(--lifg, #ffffff)">${glyph}</text>` +
    `</svg>`;
  return wrap;
}
