import "./styles/tokens.css";
import "./styles/windowChrome.css";
import "./screens/conversation/cards/content-cards.css";
import "./screens/reader/file-reader.css";
import { bootstrapThemeFromSettings } from "./state/bootstrapTheme.js";
import {
  applyFontScales,
  bootstrapFontScaleFromSettings,
} from "./state/fontScale.js";
import { applyTheme } from "./state/themeManager.js";
import { DEFAULT_THEME_ID, isThemeId } from "./state/theme.js";
import { FileReaderController } from "./screens/reader/FileReaderController.js";
import { createAppBrandIcon } from "./ui/appBrandIcon.js";
import { createWindowsCaptionGroup } from "./ui/windowsCaptionGroup.js";

// Same bootstrap as the main window: injects <html data-theme> + variable
// block (plus the highlight.js github-dark theme), so tokens resolve here.
await bootstrapThemeFromSettings();
await bootstrapFontScaleFromSettings();

window.addEventListener("error", (event) => {
  console.error("[file-reader] uncaught error", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[file-reader] unhandled rejection", event.reason);
});

const host = document.querySelector("#app");
if (!(host instanceof HTMLElement)) {
  throw new Error("Missing #app mount point");
}

document.documentElement.classList.add("file-reader-window");
document.body.classList.add("file-reader-window");

const bridge = window.jellybot;
if (bridge?.platform) {
  // data-platform drives traffic-light padding (mac hiddenInset); the
  // platform-* class drives the win32 dog-head/caption rules — same
  // convention as the main window.
  document.documentElement.dataset.platform = bridge.platform;
  document.documentElement.classList.add(`platform-${bridge.platform}`);
}

const controller = new FileReaderController();
controller.mount(host);

// Windows: the native title bar is hidden (it follows the OS theme, not the
// app theme, and has no dog-head brand). Paint our own instead — dog head
// at the titlebar's leading edge, min/max/close flush right.
const captionGroup = createWindowsCaptionGroup();
if (captionGroup) {
  controller.mountWindowsChrome(createAppBrandIcon(), captionGroup);
}

function documentPathFromLocation(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    return (params.get("path") ?? "").trim();
  } catch {
    return "";
  }
}

const initial = documentPathFromLocation();
if (initial) {
  controller.setDocument(initial);
}

// Follow appearance saves from the settings window live (theme/accent and
// the two font scales), same as the subagents window.
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

if (bridge?.onFileReaderDocument) {
  bridge.onFileReaderDocument((payload) => {
    const path =
      typeof payload?.path === "string" ? payload.path.trim() : "";
    if (path) controller.setDocument(path);
  });
}
