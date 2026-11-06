/** main → renderer: parked F12 — Go to Definition (DevTools stays blocked). */
export const EDITOR_GO_TO_DEFINITION_CHANNEL = "editor:goToDefinition";
export const EDITOR_FIND_USAGES_CHANNEL = "editor:findUsages";

export type F12ShortcutAction = "goto-definition" | "find-usages";

/**
 * F12 is parked in main so Chromium never opens DevTools.
 * Plain F12 → editor Go to Definition (same as Ctrl/Cmd+click).
 * Shift+F12 → Find Usages.
 */
export function classifyF12Shortcut(input: {
  type: string;
  key: string;
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
}): F12ShortcutAction | null {
  if (input.type !== "keyDown") return null;
  if (input.key !== "F12" && input.key !== "f12") return null;
  if (input.control || input.alt || input.meta) return null;
  return input.shift ? "find-usages" : "goto-definition";
}
