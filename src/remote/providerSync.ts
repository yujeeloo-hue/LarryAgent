/**
 * Cross-platform LLM provider sync for Relay Token Provider Hub.
 * Desktop (macOS/Windows) and agentd (Raspberry Pi) share this module —
 * settings via patchWorkspaceSettings / credentials via llm-api-keys store.
 */
import {
  readApiKeyFromStore,
  writeApiKeyToStore,
  deleteApiKeyFromStore,
  hasApiKeyInStore,
} from "../llm/credentials.js";
import { newProviderId, readWorkspaceSettings } from "../settings/readWorkspaceSettings.js";
import { patchWorkspaceSettings } from "../settings/patchWorkspaceSettings.js";
import {
  isMoonshotProviderBaseUrl,
  withSettingsDefaults,
  type LlmProvider,
} from "../settings/types.js";
import { resolveToolRoleImageSupport } from "../settings/toolRoleImageDefaults.js";
import { normalizeLlmBaseUrl, normalizeLlmProviderOptions, type LlmProviderApiOptions } from "../llm/apiProtocol.js";

export type SyncImageInput = "url" | "base64" | "file";

export type SyncProviderPublic = LlmProviderApiOptions & {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  supportsMultimodal: boolean;
  imageInput: SyncImageInput;
  /** Effective tool-role image support (verified list + explicit override). */
  toolRoleImages: boolean;
  rawEndpoint: boolean;
  apiKeyConfigured: boolean;
};

export type SyncProviderTransfer = LlmProviderApiOptions & {
  name: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  supportsMultimodal: boolean;
  imageInput: SyncImageInput;
  /** Optional explicit override; omit to keep the receiving device's value. */
  toolRoleImages?: boolean;
  rawEndpoint: boolean;
};

export function normalizeProviderBaseUrl(baseUrl: string, rawEndpoint = false): string {
  return normalizeLlmBaseUrl(baseUrl, rawEndpoint);
}

export function providerMatchKey(baseUrl: string, modelId: string): string {
  return `${normalizeProviderBaseUrl(baseUrl).toLowerCase()}\0${modelId.trim()}`;
}

export function normalizeSyncImageInput(
  value: unknown,
  baseUrl: string,
): SyncImageInput {
  if (isMoonshotProviderBaseUrl(baseUrl)) {
    return value === "file" || value === "base64" ? value : "base64";
  }
  return value === "base64" || value === "url" ? value : "url";
}

function toPublic(provider: LlmProvider, apiKeyConfigured: boolean): SyncProviderPublic {
  const baseUrl = normalizeProviderBaseUrl(provider.baseUrl, provider.rawEndpoint === true);
  return {
    ...normalizeLlmProviderOptions(provider),
    id: provider.id,
    name: provider.name,
    baseUrl,
    modelId: provider.modelId,
    supportsMultimodal: provider.supportsMultimodal === true,
    imageInput: normalizeSyncImageInput(provider.imageInput, baseUrl),
    toolRoleImages: resolveToolRoleImageSupport(provider).enabled,
    rawEndpoint: provider.rawEndpoint === true,
    apiKeyConfigured,
  };
}

function findByMatch(providers: LlmProvider[], baseUrl: string, modelId: string): LlmProvider | undefined {
  const key = providerMatchKey(baseUrl, modelId);
  return providers.find((p) => providerMatchKey(p.baseUrl, p.modelId) === key);
}

export async function listSyncProviders(appDataRoot: string): Promise<SyncProviderPublic[]> {
  const settings = withSettingsDefaults(await readWorkspaceSettings(appDataRoot));
  const out: SyncProviderPublic[] = [];
  for (const provider of settings.providers) {
    out.push(toPublic(provider, await hasApiKeyInStore(provider.id)));
  }
  return out;
}

export async function exportSyncProvider(
  appDataRoot: string,
  providerId: string,
): Promise<SyncProviderTransfer & { id: string }> {
  const settings = withSettingsDefaults(await readWorkspaceSettings(appDataRoot));
  const provider = settings.providers.find((p) => p.id === providerId);
  if (!provider) throw new Error("Provider not found.");
  const baseUrl = normalizeProviderBaseUrl(provider.baseUrl, provider.rawEndpoint === true);
  const apiKey = (await readApiKeyFromStore(provider.id)) ?? "";
  return {
    ...normalizeLlmProviderOptions(provider),
    id: provider.id,
    name: provider.name,
    baseUrl,
    modelId: provider.modelId,
    apiKey,
    supportsMultimodal: provider.supportsMultimodal === true,
    imageInput: normalizeSyncImageInput(provider.imageInput, baseUrl),
    ...(typeof provider.toolRoleImages === "boolean"
      ? { toolRoleImages: provider.toolRoleImages }
      : {}),
    rawEndpoint: provider.rawEndpoint === true,
  };
}

export async function upsertSyncProvider(
  appDataRoot: string,
  transfer: SyncProviderTransfer,
): Promise<{ id: string; action: "added" | "overwritten" }> {
  const name = transfer.name.trim();
  const modelId = transfer.modelId.trim();
  const baseUrl = normalizeProviderBaseUrl(transfer.baseUrl, transfer.rawEndpoint === true);
  const apiKey = transfer.apiKey.trim();
  if (!name) throw new Error("Provider name is required.");
  if (!modelId) throw new Error("Model ID is required.");
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    throw new Error("Enter a valid http(s) base URL.");
  }
  const imageInput = normalizeSyncImageInput(transfer.imageInput, baseUrl);
  const settings = withSettingsDefaults(await readWorkspaceSettings(appDataRoot));
  const existing = findByMatch(settings.providers, baseUrl, modelId);
  const nextProvider: LlmProvider = {
    ...normalizeLlmProviderOptions(existing),
    ...normalizeLlmProviderOptions(transfer),
    id: existing?.id ?? newProviderId(),
    name,
    baseUrl,
    modelId,
    ...(transfer.supportsMultimodal ? { supportsMultimodal: true } : {}),
    ...(transfer.rawEndpoint ? { rawEndpoint: true } : {}),
    ...(imageInput === "base64" || imageInput === "file" ? { imageInput } : {}),
    ...(transfer.toolRoleImages === true
      ? { toolRoleImages: true }
      : transfer.toolRoleImages === false
        ? { toolRoleImages: false }
        : typeof existing?.toolRoleImages === "boolean"
          ? { toolRoleImages: existing.toolRoleImages }
          : {}),
  };
  const providers = existing
    ? settings.providers.map((p) => (p.id === existing.id ? nextProvider : p))
    : [...settings.providers, nextProvider];
  await patchWorkspaceSettings(appDataRoot, {
    providers,
    activeProviderId: settings.activeProviderId,
  });
  if (apiKey) {
    await writeApiKeyToStore(apiKey, nextProvider.id);
  }
  return {
    id: nextProvider.id,
    action: existing ? "overwritten" : "added",
  };
}

export async function removeSyncProvider(
  appDataRoot: string,
  baseUrl: string,
  modelId: string,
): Promise<{ removed: boolean; id?: string }> {
  return removeProvider(appDataRoot, (providers) => findByMatch(providers, baseUrl, modelId));
}

/** Delete the selected device row even when another row has the same endpoint/model. */
export async function removeSyncProviderById(
  appDataRoot: string,
  providerId: string,
): Promise<{ removed: boolean; id?: string }> {
  const id = providerId.trim();
  if (!id) throw new Error("Provider ID is required.");
  return removeProvider(appDataRoot, (providers) => providers.find((provider) => provider.id === id));
}

async function removeProvider(
  appDataRoot: string,
  find: (providers: LlmProvider[]) => LlmProvider | undefined,
): Promise<{ removed: boolean; id?: string }> {
  const settings = withSettingsDefaults(await readWorkspaceSettings(appDataRoot));
  const existing = find(settings.providers);
  if (!existing) return { removed: false };
  if (settings.providers.length <= 1) {
    throw new Error("Cannot remove the last LLM provider on this device.");
  }
  const providers = settings.providers.filter((p) => p.id !== existing.id);
  const activeProviderId =
    settings.activeProviderId === existing.id
      ? providers[0]!.id
      : settings.activeProviderId;
  await patchWorkspaceSettings(appDataRoot, { providers, activeProviderId });
  await deleteApiKeyFromStore(existing.id);
  return { removed: true, id: existing.id };
}
