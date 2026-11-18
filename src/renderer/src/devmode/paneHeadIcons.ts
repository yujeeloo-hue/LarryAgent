import { createLucideIcon } from "../ui/originalIcons.js";

export const PANE_HEAD_ICON_SIZE = 14;

export function paneHeadIcon(
  icon: Parameters<typeof createLucideIcon>[0],
): SVGElement {
  return createLucideIcon(icon, { size: PANE_HEAD_ICON_SIZE });
}
