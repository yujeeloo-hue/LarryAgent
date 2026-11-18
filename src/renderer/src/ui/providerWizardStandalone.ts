import { bootstrapProvidersFromSettings } from "./taskComposer/bindComposerProviders.js";
import {
  providerDisplayName,
  showProviderWizard,
} from "./ProviderWizardView.js";


let startupPromptShown = false;

export async function maybeShowStartupProviderWizard(): Promise<void> {
  if (startupPromptShown) return;
  startupPromptShown = true;
  const bridge = window.jellybot;
  if (!bridge || typeof bridge.hasUsableLlmProvider !== "function") return;
  let usable = true;
  try {
    ({ usable } = await bridge.hasUsableLlmProvider());
  } catch {
    return;
  }
  if (usable) return;
  await runStandaloneProviderWizard({ setActiveFirst: true });
}

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

  await bootstrapProvidersFromSettings();
  return true;
}
