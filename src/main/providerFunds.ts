import { queryProviderBalance, type ProviderBalanceResult } from "../llm/balance/index.js";
import { readApiKeyFromStore } from "../llm/credentials.js";
import { collectUsageSnapshots, matchUsageProviderKey, resolveUsageAdapter } from "../llm/usage/registry.js";
import type { ProviderUsageSnapshot, UsageProviderKey } from "../llm/usage/types.js";
import { readWorkspaceSettings, resolveActiveProvider, withSettingsDefaults } from "../settings/index.js";

/**
 * Provider balance (src/llm/balance/) and subscription usage (src/llm/usage/)
 * shared by the renderer IPC handlers and CoCo's `coco_balance` tool.
 */

export type ProviderUsagePayload = {
  snapshots: ProviderUsageSnapshot[];
  activeKey: UsageProviderKey | null;
};

const PROVIDER_USAGE_CACHE_TTL_MS = 60_000;
const usageCache = new Map<string, { at: number; payload: ProviderUsagePayload }>();

async function loadProviders(root: string) {
  const settings = withSettingsDefaults(await readWorkspaceSettings(root));
  return { settings, providers: settings.providers };
}

async function readKey(providerId: string): Promise<string | null> {
  try {
    return (await readApiKeyFromStore(providerId))?.trim() || null;
  } catch {
    return null;
  }
}

/** Balance line for one provider (default: the settings default provider). */
export async function getProviderBalance(root: string, providerId?: string): Promise<ProviderBalanceResult> {
  const { settings, providers } = await loadProviders(root);
  const id = providerId?.trim() || settings.activeProviderId;
  const provider = providers.find((p) => p.id === id) ?? resolveActiveProvider(settings);
  const apiKey = await readKey(provider.id);
  if (!apiKey) return { providerId: provider.id, text: null };
  return queryProviderBalance({ id: provider.id, name: provider.name, baseUrl: provider.baseUrl, modelId: provider.modelId, apiKey });
}

/**
 * Usage snapshots for every configured & supported provider. 60s cache —
 * the tray popup must feel instant; `force` bypasses it.
 */
export async function getProviderUsage(root: string, options: { force?: boolean } = {}): Promise<ProviderUsagePayload> {
  const cached = usageCache.get(root);
  if (!options.force && cached && Date.now() - cached.at < PROVIDER_USAGE_CACHE_TTL_MS) return cached.payload;
  const { settings, providers } = await loadProviders(root);
  const profiles = providers.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, modelId: p.modelId }));
  // resolveUsageSources reads keys synchronously — pre-fetch the key store.
  const keyMap = new Map<string, string>();
  await Promise.all(profiles.map(async (profile) => {
    const key = await readKey(profile.id);
    if (key) keyMap.set(profile.id, key);
  }));
  const snapshots = await collectUsageSnapshots(profiles, (id) => keyMap.get(id) ?? null);
  const payload = { snapshots, activeKey: matchUsageProviderKey(resolveActiveProvider(settings).baseUrl) };
  usageCache.set(root, { at: Date.now(), payload });
  return payload;
}

export type ProviderFundsEntry = {
  providerId: string;
  name: string;
  modelId: string;
  isDefault: boolean;
  hasApiKey: boolean;
  /** Balance line, or null when the provider has no balance API / the query failed. */
  balance: string | null;
  /** Subscription usage section this provider maps to, when supported. */
  usageKey: UsageProviderKey | null;
};

/** Every configured provider with its balance, plus the deduped usage snapshots. */
export async function getProviderFunds(root: string, options: { force?: boolean } = {}): Promise<{ providers: ProviderFundsEntry[]; usage: ProviderUsageSnapshot[] }> {
  const { settings, providers } = await loadProviders(root);
  const [entries, usage] = await Promise.all([
    Promise.all(providers.map(async (p): Promise<ProviderFundsEntry> => {
      const apiKey = await readKey(p.id);
      const balance = apiKey
        ? (await queryProviderBalance({ id: p.id, name: p.name, baseUrl: p.baseUrl, modelId: p.modelId, apiKey }).catch(() => ({ text: null }))).text
        : null;
      return { providerId: p.id, name: p.name, modelId: p.modelId, isDefault: p.id === settings.activeProviderId, hasApiKey: Boolean(apiKey), balance, usageKey: resolveUsageAdapter(p)?.key ?? null };
    })),
    getProviderUsage(root, options),
  ]);
  return { providers: entries, usage: usage.snapshots };
}
