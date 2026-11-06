import { bootstrapProvidersFromSettings } from "./taskComposer/bindComposerProviders.js";
import {
  providerDisplayName,
  showProviderWizard,
} from "./ProviderWizardView.js";

/**
 * Standalone provider-wizard flows (no Setting screen involved):
 * - startup onboarding: main-process `llm:hasUsableProvider` says nothing is
 *   usable (no key in store, no local baseUrl, no `.env JELLYBOT_API_KEY`)
 *   → open the wizard once per launch;
 * - send-failure error card: explicit "Open setup wizard" entry (s7).
 *
 * Persisting a pick appends one profile per model (wizard decision A),
 * stores the shared API key per profile (settings must be saved first —
 * `settings:setApiKey` requires the provider to exist), then re-runs the
 * boot-time provider bootstrap so composer switchers update live.
 */

/** Once-per-launch guard for the startup onboarding prompt. */
let startupPromptShown = false;

/**
 * Startup hook: open the setup wizard when no usable LLM provider exists.
 * Called from main.ts after the shell mounts. Esc-closing ends the prompt
 * for this launch; a completed wizard means later launches find a key.
 */
export async function maybeShowStartupProviderWizard(): Promise<void> {
  if (startupPromptShown) return;
  startupPromptShown = true;
  const bridge = window.jellybot;
  if (!bridge || typeof bridge.hasUsableLlmProvider !== "function") return;
  let usable = true;
  try {
    ({ usable } = await bridge.hasUsableLlmProvider());
  } catch {
    // Judge failed — never nag on a broken check.
    return;
  }
  if (usable) return;
  await runStandaloneProviderWizard({ setActiveFirst: true });
}

/**
 * Open a standalone wizard instance and persist the pick.
 * Returns true when profiles were added.
 */
export async function runStandaloneProviderWizard(
  options: { setActiveFirst?: boolean } = {},
): Promise<boolean> {
  const bridge = window.jellybot;
  if (!bridge || typeof bridge.saveWorkspaceSettings !== "function") {
    return false;
  }

  let providers: Array<{ id: string; name: string; baseUrl: string; modelId: string }> = [];
  let activeProviderId = "";
  try {
    const snap = await bridge.getSettingsSnapshot();
    providers = snap.settings.providers;
    activeProviderId = snap.settings.activeProviderId;
  } catch {
    // Snapshot failed — the wizard still runs; persisted list starts empty.
  }

  const pick = await showProviderWizard({
    existingProviders: providers.map((p) => ({
      baseUrl: p.baseUrl,
      modelId: p.modelId,
    })),
  });
  if (!pick) return false;

  const added = pick.models.map((modelId) => ({
    id: crypto.randomUUID(),
    name: providerDisplayName(modelId),
    baseUrl: pick.baseUrl,
    modelId,
    apiProtocol: pick.apiProtocol,
    ...(pick.rawEndpoint ? { rawEndpoint: true } : {}),
  }));
  const nextProviders = [...providers, ...added];
  const activeStillExists = nextProviders.some(
    (p) => p.id === activeProviderId,
  );
  // Startup onboarding (and any fallback with no valid active) points the
  // default provider at the first added profile — otherwise new tasks keep
  // targeting the keyless placeholder.
  const nextActive =
    options.setActiveFirst || !activeStillExists
      ? added[0]!.id
      : activeProviderId;

  try {
    await bridge.saveWorkspaceSettings({
      providers: nextProviders,
      activeProviderId: nextActive,
    });
  } catch (err) {
    console.error("[provider-wizard] save settings failed", err);
    return false;
  }

  if (pick.apiKey && typeof bridge.setApiKey === "function") {
    for (const provider of added) {
      try {
        await bridge.setApiKey({
          providerId: provider.id,
          apiKey: pick.apiKey,
        });
      } catch (err) {
        console.error(
          "[provider-wizard] store key failed",
          provider.id,
          err,
        );
      }
    }
  }

  // Refresh process state so composer switchers see the new profiles
  // without a restart (same code path as boot).
  await bootstrapProvidersFromSettings();
  return true;
}
