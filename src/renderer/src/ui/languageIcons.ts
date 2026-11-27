
import { FileText, createLucideIcon } from "./icons.js";

export type LanguageIconKey =
  | "csharp"
  | "cpp"
  | "python"
  | "swift"
  | "lua"
  | "typescript"
  | "javascript"
  | "css"
  | "html"
  | "xml"
  | "json"
  | "markdown"
  | "txt"
  | "text";

const GLYPHS: Record<Exclude<LanguageIconKey, "text">, string> = {
  csharp: "C#",
  cpp: "C+",
  python: "PY",
  swift: "SW",
  lua: "LU",
  typescript: "TS",
  javascript: "JS",
  css: "CS",
  html: "H5",
  xml: "XM",
  json: "{}",
  markdown: "MD",
  txt: "TX",
};

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
