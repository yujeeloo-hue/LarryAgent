import { Undo2 } from "lucide";
import { createLucideIcon } from "./originalIcons.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The band silhouette path from `assets/coco/running/band-16.txt`.
 *
 * Inlined as a constant instead of a `?raw` import: `?raw` is a Vite-only
 * transform (tsx/node:test compiles the raw `.txt` as JS and crashes — the
 * reason no test ever imports `cocoIcon.ts`). Single-source discipline is
 * kept by `cocoMonoMark.test.ts`, which asserts this constant matches the
 * asset file byte-for-byte.
 */
export const COCO_BAND_PATH =
  "M8.235382907247958 2H15.764617092752042A6 6 0 0 1 20.960769515458672 11L17.196152422706632 17.52050807568877A6 6 0 0 1 6.803847577293368 17.52050807568877L3.039230484541326 11A6 6 0 0 1 8.235382907247958 2ZM9.2894757 7.7445807H14.7105243A0.8640000 0.8640000 0 0 1 15.4587703 9.0405807L12.7482459 13.7353465A0.8640000 0.8640000 0 0 1 11.2517541 13.7353465L8.5412297 9.0405807A0.8640000 0.8640000 0 0 1 9.2894757 7.7445807Z";

/**
 * Monochrome CoCo mark: the running band silhouette (single source
 * `assets/coco/running/band-16.txt`) filled with `currentColor`, including
 * the icon system's `translate(0 .74)` optical correction. No animation and
 * no palette layer — tint via CSS `color` so it follows the theme tokens.
 *
 * Kept separate from `cocoIcon.ts` so sidebar/DOM-test module graphs do not
 * pull the motion clock, palette bitmaps or motion.css.
 */
export function createCocoMonoMark(size: number): HTMLElement {
  const icon = document.createElement("span");
  icon.className = "coco-mono-mark";
  icon.setAttribute("aria-hidden", "true");
  icon.style.width = `${size}px`;
  icon.style.height = `${size}px`;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.style.width = "100%";
  svg.style.height = "100%";

  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("transform", "translate(0 .74)");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", COCO_BAND_PATH);
  path.setAttribute("fill", "currentColor");
  path.setAttribute("fill-rule", "evenodd");
  group.append(path);
  svg.append(group);

  icon.append(svg);
  return icon;
}

/** Take back control: a return arrow using the shell's shared icon styling. */
export function createCocoTakeBackMark(size: number): HTMLElement {
  const icon = document.createElement("span");
  icon.className = "coco-mono-mark coco-takeback-mark";
  icon.setAttribute("aria-hidden", "true");
  icon.style.width = `${size}px`;
  icon.style.height = `${size}px`;
  icon.append(createLucideIcon(Undo2, { size }));
  return icon;
}
