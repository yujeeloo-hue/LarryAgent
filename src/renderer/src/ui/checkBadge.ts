import { Check } from "lucide";
import { createLucideIcon } from "./icons.js";
import "./check-badge.css";

export function createCheckBadge(options?: {
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
