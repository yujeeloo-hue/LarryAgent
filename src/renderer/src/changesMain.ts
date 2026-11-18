import "./styles/tokens.css";
import "./styles/windowChrome.css";
import { bootstrapThemeFromSettings } from "./state/bootstrapTheme.js";
import {
  applyFontScales,
  bootstrapFontScaleFromSettings,
} from "./state/fontScale.js";
import { applyTheme } from "./state/themeManager.js";
import { DEFAULT_THEME_ID, isThemeId } from "./state/theme.js";
import { WorkspaceChangesController } from "./screens/conversation/WorkspaceChangesController.js";
import { createAppBrandIcon } from "./ui/appBrandIcon.js";
import { createWindowsCaptionGroup } from "./ui/windowsCaptionGroup.js";

await bootstrapThemeFromSettings();
await bootstrapFontScaleFromSettings();

window.addEventListener("error", (event) => {
  console.error("[changes] uncaught error", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[changes] unhandled rejection", event.reason);
});

const host = document.querySelector("#app");
if (!(host instanceof HTMLElement)) {
  throw new Error("Missing #app mount point");
}

document.documentElement.classList.add("workspace-changes-window");
document.body.classList.add("workspace-changes-window");

const controller = new WorkspaceChangesController();
controller.mount(host);

const bridgePlatform = window.jellybot?.platform ?? "";
if (bridgePlatform) {
  document.documentElement.classList.add(`platform-${bridgePlatform}`);
}

const captionGroup = createWindowsCaptionGroup();
if (captionGroup) {
  const brand = document.createElement("div");
  const brandLabel = document.createElement("span");
  brandLabel.className = "workspace-changes-brand-label";
  brandLabel.textContent = "Changes";
  brand.append(createAppBrandIcon(), brandLabel);
  controller.mountWindowsChrome(brand, captionGroup);
}

function workspacePathFromLocation(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    return (params.get("workspacePath") ?? "").trim();
  } catch {
    return "";
  }
}

const initial = workspacePathFromLocation();
if (initial) {
  controller.setWorkspacePath(initial);
}

const bridge = window.jellybot;
if (bridge?.onAppearanceChanged) {
  bridge.onAppearanceChanged(
    ({ themeId, accentColor, uiFontScale, chatFontScale }) => {
      applyTheme(
        isThemeId(themeId) ? themeId : DEFAULT_THEME_ID,
        accentColor === "auto" ? null : accentColor,
      );
      applyFontScales({ ui: uiFontScale ?? 1, chat: chatFontScale ?? 1 });
    },
  );
}
if (bridge?.onWorkspaceChangesPath) {
  bridge.onWorkspaceChangesPath((payload) => {
    const path =
      typeof payload?.workspacePath === "string"
        ? payload.workspacePath.trim()
        : "";
    if (path) controller.setWorkspacePath(path);
  });
}
