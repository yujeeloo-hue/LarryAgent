import type { TrayHostDeps } from "./usagePopup.js";

export type TrayLeftClickAction =
  | "open-window"
  | "usage-popup"
  | "focus-window";

export type TrayLeftClickRouteDeps = Pick<
  TrayHostDeps,
  "isMainWindowOpen" | "isMainWindowForeground"
> & {
  isUsagePopupOpen: () => boolean;
};

export function resolveTrayLeftClickAction(
  deps: TrayLeftClickRouteDeps,
): TrayLeftClickAction {
  if (!deps.isMainWindowOpen()) return "open-window";
  if (deps.isUsagePopupOpen()) return "usage-popup";
  if (!deps.isMainWindowForeground()) return "focus-window";
  return "usage-popup";
}
