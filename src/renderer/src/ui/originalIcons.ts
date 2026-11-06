/** Original artwork for Dev Mode and conversation tool/Thinking cards. */
import { createElement, type IconNode } from "lucide";
export * from "./icons.js";
export { Rocket } from "lucide";

const DEFAULT_SIZE = 16;
const DEFAULT_STROKE = 1.75;

/** Create a Lucide SVG element with shared sizing for the shell UI. */
export function createLucideIcon(
  icon: IconNode,
  options?: { size?: number; strokeWidth?: number },
): SVGElement {
  const size = options?.size ?? DEFAULT_SIZE;
  const strokeWidth = options?.strokeWidth ?? DEFAULT_STROKE;
  return createElement(icon, {
    width: size,
    height: size,
    "stroke-width": strokeWidth,
    "aria-hidden": "true",
  });
}

/* ---- Two-tone manila folder (Dev Mode file tree) ------------------------
 * Fill-only, no stroke. Fixed color pair in both themes (no theme CSS
 * involved → Dark stays drift-free). Shapes demo-approved in
 * folder-icon-demo.html: darker back panel + lighter front panel.
 * Drawn to a near-full 24-unit footprint (x1–23, y1.8–21.8) so the folder
 * optically matches the full-bleed 14px language badges next to it. */
const FOLDER_BACK_D =
  "M1.25 3.32c0-0.84 0.67-1.52 1.5-1.52h5.06c0.7 0 1.36 0.33 1.78 0.89l1.2 1.57c0.31 0.4 0.79 0.65 1.3 0.65h8.4c1.25 0 2.26 1.02 2.26 2.28v3.23H1.25V3.32z";
const FOLDER_FRONT_D =
  "M1 7.5h22v11.77c0 1.39-1.12 2.54-2.5 2.54H3.5c-1.37 0-2.5-1.13-2.5-2.54V7.5z";
const FOLDER_OPEN_BACK_D =
  "M1 3.26c0-0.8 0.66-1.46 1.45-1.46h4.89c0.68 0 1.32 0.32 1.72 0.85l1.16 1.51c0.31 0.39 0.76 0.62 1.26 0.62h8.12c1.2 0 2.18 0.99 2.18 2.2v4.33c0 0.8-0.66 1.46-1.45 1.46h-10.26L6.01 20.09c-0.2 0.71-0.85 1.2-1.57 1.2H2.45c-0.79 0-1.45-0.66-1.45-1.46V3.26z";
const FOLDER_OPEN_FLAP_D =
  "M4.14 21.43c-0.96 0-1.66-0.93-1.38-1.87l2.05-7.48c0.18-0.63 0.75-1.07 1.41-1.07h15.76c0.93 0 1.61 0.9 1.34 1.83l-1.85 6.74a2.18 2.2 0 0 1-2.1 1.84H4.14z";

/** Closed manila folder — #d19a15 back + #f5c94e front, fill-only. */
export const FolderFill: IconNode = [
  ["path", { d: FOLDER_BACK_D, fill: "#d19a15", stroke: "none" }],
  ["path", { d: FOLDER_FRONT_D, fill: "#f5c94e", stroke: "none" }],
];

/** Open manila folder — same pair, front flap folded down-right. */
export const FolderOpenFill: IconNode = [
  ["path", { d: FOLDER_OPEN_BACK_D, fill: "#d19a15", stroke: "none" }],
  ["path", { d: FOLDER_OPEN_FLAP_D, fill: "#f5c94e", stroke: "none" }],
];

