import "./debugIcons.css";
import "./debugBitmapIcons.css";

export type DebugPanelIconName =
  | "continue" | "pause" | "stop"
  | "step-over" | "step-in" | "step-out"
  | "threads" | "call-stack" | "variables" | "breakpoints";

/** Approved filled glyphs; colors follow the surrounding Light/Dark surface. */
export function createDebugPanelIcon(name: DebugPanelIconName): HTMLSpanElement {
  const icon = document.createElement("span");
  icon.className = "devmode-debug-icon";
  icon.dataset.debugIcon = name;
  icon.setAttribute("aria-hidden", "true");
  const detail = document.createElement("i");
  if (name === "variables") detail.textContent = "VAR";
  icon.append(detail);
  return icon;
}
