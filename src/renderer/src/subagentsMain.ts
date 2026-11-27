import "./styles/tokens.css";
import "./styles/windowChrome.css";
import "./screens/conversation/conversation.css";
import "./screens/conversation/cards/content-cards.css";
import { bootstrapThemeFromSettings } from "./state/bootstrapTheme.js";
import {
  applyFontScales,
  bootstrapFontScaleFromSettings,
} from "./state/fontScale.js";
import { applyTheme } from "./state/themeManager.js";
import { DEFAULT_THEME_ID, isThemeId } from "./state/theme.js";
import { SubagentsWindowController } from "./screens/subagents/SubagentsWindowController.js";
import { createAppBrandIcon } from "./ui/appBrandIcon.js";
import { createWindowsCaptionGroup } from "./ui/windowsCaptionGroup.js";

await bootstrapThemeFromSettings();
await bootstrapFontScaleFromSettings();

window.addEventListener("error", (event) => {
  console.error("[subagents] uncaught error", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[subagents] unhandled rejection", event.reason);
});

const host = document.querySelector("#app");
if (!(host instanceof HTMLElement)) {
  throw new Error("Missing #app mount point");
}

document.documentElement.classList.add("subagents-window");
document.body.classList.add("subagents-window");

const bridge = window.jellybot;
if (bridge?.platform) {
  document.documentElement.dataset.platform = bridge.platform;
  document.documentElement.classList.add(`platform-${bridge.platform}`);
}

const controller = new SubagentsWindowController();
controller.mount(host);

const captionGroup = createWindowsCaptionGroup();
if (captionGroup) {
  const brand = document.createElement("div");
  brand.className = "subagents-brand";
  const brandLabel = document.createElement("span");
  brandLabel.className = "subagents-brand-label";
  brandLabel.textContent = "Subagents";
  brand.append(createAppBrandIcon(), brandLabel);
  controller.mountWindowsChrome(brand, captionGroup);
}

function sessionIdFromLocation(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    return (params.get("sessionId") ?? "").trim();
  } catch {
    return "";
  }
}

const initial = sessionIdFromLocation();
if (initial) {
  controller.setSession(initial);
}

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

if (bridge?.onSubagentsWindowSession) {
  bridge.onSubagentsWindowSession((payload) => {
    const sessionId =
      typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
    if (sessionId) controller.setSession(sessionId);
  });
}
