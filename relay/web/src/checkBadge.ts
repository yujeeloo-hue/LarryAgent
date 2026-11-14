/**
 * Green disc with a white check — shared success mark across the console
 * (port of the desktop ui/checkBadge.ts). Styles live in style.css under
 * `.check-badge`.
 */
import { el } from "./render.js";

export function checkBadge(size = 14): HTMLElement {
  const badge = el("span", { class: "check-badge", "aria-hidden": "true" });
  badge.style.setProperty("--check-badge-size", `${size}px`);
  const svg = document.createElement("template");
  svg.innerHTML = `<svg width="${Math.max(8, Math.round(size * 0.7))}" height="${Math.max(8, Math.round(size * 0.7))}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.25" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
  badge.append(svg.content);
  return badge;
}
