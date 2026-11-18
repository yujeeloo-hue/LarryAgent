import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/navigation-selection.css";
import "./styles/windowChrome.css";
import { AppShellController } from "./shell/AppShellController.js";
import { AppShellView } from "./shell/AppShellView.js";
import { bootstrapComposerPrefsFromSettings } from "./state/bootstrapComposerPrefs.js";
import { bootstrapFullPermissionsFromSettings } from "./state/bootstrapFullPermissions.js";
import { bootstrapWorkspacesFromMain } from "./state/bootstrapWorkspaces.js";
import { bootstrapProvidersFromSettings } from "./ui/taskComposer/bindComposerProviders.js";
import { maybeShowStartupProviderWizard } from "./ui/providerWizardStandalone.js";
import { bootstrapThemeFromSettings } from "./state/bootstrapTheme.js";
import { bootstrapFontScaleFromSettings } from "./state/fontScale.js";
import { ConfettiOverlay } from "./ui/confettiOverlay.js";
import { showVcsAuthPrompt } from "./ui/VcsAuthPromptView.js";

window.addEventListener("error", (event) => {
  console.error("[renderer] uncaught error", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[renderer] unhandled rejection", event.reason);
});

for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (event) => {
    const types = event.dataTransfer?.types;
    if (types && Array.from(types).includes("Files")) {
      event.preventDefault();
    }
  });
}

document.documentElement.classList.add(
  `platform-${window.jellybot?.platform ?? "unknown"}`,
);

const host = document.querySelector("#app");
if (!(host instanceof HTMLElement)) {
  throw new Error("Missing #app mount point");
}

await bootstrapFullPermissionsFromSettings();
await bootstrapComposerPrefsFromSettings();
await bootstrapWorkspacesFromMain();
await bootstrapProvidersFromSettings();
window.jellybot?.onLlmProvidersChanged?.(() => {
  void bootstrapProvidersFromSettings();
});
await bootstrapThemeFromSettings();
await bootstrapFontScaleFromSettings();

const shell = new AppShellController(new AppShellView());
shell.mount(host);

void maybeShowStartupProviderWizard();

window.jellybot?.onWindowCloseRequest?.(() => {
  if (shell.consumeCloseShortcut()) return;
  void window.jellybot?.windowControls?.close();
});

const confetti = new ConfettiOverlay();
confetti.mount();

window.jellybot?.onVcsAuthRequest?.((payload) => {
  void showVcsAuthPrompt(payload).then((result) => {
    void window.jellybot
      ?.respondVcsAuth?.({
        requestId: result.requestId,
        credentials: result.credentials,
        remember: result.remember,
      })
      .catch(() => {});
  });
});
