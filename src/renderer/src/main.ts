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

// OS file drag-and-drop: only the composer accepts drops (it stops
// propagation). Everywhere else, swallow the default — Chromium would
// otherwise navigate the window to the dropped file:// URL or paste the
// path as raw text into whatever is under the cursor.
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
// Token Hub can add or delete providers while this window is open. The
// composer list is process memory, so reload it when the device list changes.
window.jellybot?.onLlmProvidersChanged?.(() => {
  void bootstrapProvidersFromSettings();
});
await bootstrapThemeFromSettings();
await bootstrapFontScaleFromSettings();

const shell = new AppShellController(new AppShellView());
shell.mount(host);

// First-run onboarding: no usable LLM provider (no key in store, no local
// baseUrl, no .env fallback — judged by the main process as the single
// source of truth) → open the setup wizard. Once per launch at most;
// Esc-closing just ends the prompt for this launch.
void maybeShowStartupProviderWizard();

// Dev Mode close-tab chord: main parks ⌘W (macOS) / Ctrl+F4 (Windows); the
// shell closes one file tab per press. An empty tab bar — or no Dev Mode —
// falls through to the real window close.
window.jellybot?.onWindowCloseRequest?.(() => {
  if (shell.consumeCloseShortcut()) return;
  void window.jellybot?.windowControls?.close();
});

// Celebration confetti (task-done effect / F12 test hook).
const confetti = new ConfettiOverlay();
confetti.mount();

// VCS credential prompts (git push / svn annotate/update/commit auth
// failures). The main process broadcasts; we show a modal and answer.
// Stale requestId (another window answered first) is a harmless no-op.
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
