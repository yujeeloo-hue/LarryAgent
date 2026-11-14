import idle16 from "../assets/agent-nav/active/coco.svg?url";
import idle32 from "../assets/coco/logo.svg?url";
import band16 from "../assets/coco/running/band-16.txt?raw";
import band32 from "../assets/coco/running/band-32.txt?raw";
import fill160 from "../assets/coco/running/fill-16-0.png?url";
import fill161 from "../assets/coco/running/fill-16-1.png?url";
import fill162 from "../assets/coco/running/fill-16-2.png?url";
import fill163 from "../assets/coco/running/fill-16-3.png?url";
import fill164 from "../assets/coco/running/fill-16-4.png?url";
import fill165 from "../assets/coco/running/fill-16-5.png?url";
import fill166 from "../assets/coco/running/fill-16-6.png?url";
import fill167 from "../assets/coco/running/fill-16-7.png?url";
import fill320 from "../assets/coco/running/fill-32-0.png?url";
import fill321 from "../assets/coco/running/fill-32-1.png?url";
import fill322 from "../assets/coco/running/fill-32-2.png?url";
import fill323 from "../assets/coco/running/fill-32-3.png?url";
import fill324 from "../assets/coco/running/fill-32-4.png?url";
import fill325 from "../assets/coco/running/fill-32-5.png?url";
import fill326 from "../assets/coco/running/fill-32-6.png?url";
import fill327 from "../assets/coco/running/fill-32-7.png?url";
import { cocoIconAnimationTime, cocoIconMotionClock, type CocoIconRole } from "./cocoIconMotion.js";
import "../assets/coco/motion.css";
import "./cocoIcon.css";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Eight palette frames per size, in cycle order (see generate-motion.mjs). */
const ARTWORKS = {
  16: { band: band16.trim(), palettes: [fill160, fill161, fill162, fill163, fill164, fill165, fill166, fill167] },
  32: { band: band32.trim(), palettes: [fill320, fill321, fill322, fill323, fill324, fill325, fill326, fill327] },
};
let serial = 0;
/** Single source for the running-state spin (one turn = 3 tick beats × 120°, see cocoIcon.css). */
const SPIN_PERIOD_MS = 6000;
/** Preserve the small-size optics and each role's running or return phase. */
export function createCocoIcon(size: number, role: CocoIconRole, options: { alwaysAnimate?: boolean } = {}): HTMLElement {
  // Navigation at 17px keeps the optical corrections from the 16px artwork.
  const artworkSize = size <= 17 ? 16 : 32;
  const icon = document.createElement("span");
  icon.className = `coco-icon coco-icon--${role}`;
  // Activation artwork can animate before CoCo has any running activity.
  icon.classList.toggle("coco-icon--animated", options.alwaysAnimate === true);
  icon.dataset.cocoRole = role;
  icon.style.width = `${size}px`;
  icon.style.height = `${size}px`;
  const elapsed = options.alwaysAnimate ? cocoIconAnimationTime() : cocoIconMotionClock.elapsed(role);
  icon.style.setProperty("--coco-motion-delay", `${-(elapsed % 12800) / 1000}s`);
  icon.style.setProperty("--coco-spin-period", `${SPIN_PERIOD_MS / 1000}s`);
  icon.style.setProperty("--coco-spin-delay", `${-(elapsed % SPIN_PERIOD_MS) / 1000}s`);
  icon.setAttribute("aria-hidden", "true");
  const image = document.createElement("img");
  image.className = "coco-icon-idle";
  image.src = artworkSize === 16 ? idle16 : idle32;
  image.alt = "";
  image.width = size;
  image.height = size;
  image.draggable = false;
  icon.append(image, createRunning(ARTWORKS[artworkSize]));
  if (!options.alwaysAnimate) queueMicrotask(() => {
    if (!icon.isConnected) return;
    cocoIconMotionClock.track(icon, role, elapsed);
  });
  return icon;
}

/**
 * Running artwork: the vector clip silhouette spins (crisp anti-aliased edges at
 * every size) over a stationary field of pre-rendered palettes that crossfade on
 * top of the opaque first palette — a few cached bitmap draws per frame instead
 * of animating hundreds of gradient stops.
 */
function createRunning(art: { band: string; palettes: string[] }): SVGSVGElement {
  const el = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string>): SVGElementTagNameMap[K] => {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const clipId = `coco-band-${++serial}`;
  const svg = el("svg", { class: "coco-icon-running", viewBox: "0 0 24 24" });
  const clip = el("clipPath", { id: clipId });
  clip.append(el("path", { class: "coco-icon-shape", d: art.band, "clip-rule": "evenodd" }));
  const defs = el("defs", {});
  defs.append(clip);
  const group = el("g", { transform: "translate(0 .74)", "clip-path": `url(#${clipId})` });
  // Fields cover viewBox -12 -12 48 48 and already include the artwork's translate.
  // Layer 0 (emerald) is the resting frame; motion.css keyframes coco-fade-N.
  for (let i = 0; i <= art.palettes.length; i++) {
    const image = el("image", { href: art.palettes[i % art.palettes.length] ?? "", x: "-12", y: "-12.74", width: "48", height: "48", class: "coco-icon-palette" });
    image.style.animationName = `coco-fade-${i}`;
    group.append(image);
  }
  svg.append(defs, group);
  return svg;
}
