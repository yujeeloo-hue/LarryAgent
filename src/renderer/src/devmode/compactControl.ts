import { createLucideIcon } from "../ui/originalIcons.js";

export const DEVMODE_COMPACT_ICON_SIZE = 12;

export function compactControlIcon(
  icon: Parameters<typeof createLucideIcon>[0],
): SVGElement {
  return createLucideIcon(icon, { size: DEVMODE_COMPACT_ICON_SIZE });
}
