import { Check } from "lucide";
import { createLucideIcon } from "./icons.js";
import "./check-badge.css";

/** Green disc with a white check — shared success mark across the app. */
export function createCheckBadge(options?: {
  /** Outer circle diameter in px (defaults to 14, matching Lucide status icons). */
  size?: number;
}, renderIcon = createLucideIcon): HTMLSpanElement {
  const size = options?.size ?? 14;
  const badge = document.createElement("span");
  badge.className = "check-badge";
  badge.style.setProperty("--check-badge-size", `${size}px`);
  badge.setAttribute("aria-hidden", "true");
  badge.append(
    renderIcon(Check, {
      size: Math.max(8, Math.round(size * 0.7)),
      strokeWidth: 3.25,
    }),
  );
  return badge;
}
