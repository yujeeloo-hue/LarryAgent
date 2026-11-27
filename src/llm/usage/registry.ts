import { deepseekUsageAdapter } from "./deepseek.js";
import { glmCodeUsageAdapter } from "./glmCode.js";
import { kimiCodeUsageAdapter } from "./kimiCode.js";
import { kimiUsageAdapter } from "./kimi.js";
import { openrouterUsageAdapter } from "./openrouter.js";
import { qwenCodeUsageAdapter } from "./qwenCode.js";
import type {
  ProviderUsageAdapter,
  ProviderUsageProfile,
  ProviderUsageSnapshot,
  UsageProviderKey,
} from "./types.js";

const USAGE_ADAPTERS: readonly ProviderUsageAdapter[] = [
  kimiCodeUsageAdapter,
  glmCodeUsageAdapter,
  kimiUsageAdapter,
  deepseekUsageAdapter,
  openrouterUsageAdapter,
  qwenCodeUsageAdapter,
];

export function resolveUsageAdapter(
  provider: ProviderUsageProfile,
): ProviderUsageAdapter | null {
  return USAGE_ADAPTERS.find((adapter) => adapter.matches(provider)) ?? null;
}

export function matchUsageProviderKey(baseUrl: string): UsageProviderKey | null {
  const adapter = resolveUsageAdapter({
    id: "",
    name: "",
    baseUrl,
  });
  return adapter ? adapter.key : null;
}

export type UsageQuerySource = {
  adapter: ProviderUsageAdapter;
  profile: ProviderUsageProfile;
  apiKey: string;
};

export function resolveUsageSources(
  providers: readonly ProviderUsageProfile[],
  readApiKey: (providerId: string) => string | null,
): UsageQuerySource[] {
  const seen = new Set<UsageProviderKey>();
  const sources: UsageQuerySource[] = [];
  for (const provider of providers) {
    const adapter = resolveUsageAdapter(provider);
    if (!adapter || seen.has(adapter.key)) continue;
    const apiKey = readApiKey(provider.id)?.trim() ?? "";
    if (!apiKey) continue;
    seen.add(adapter.key);
    sources.push({ adapter, profile: provider, apiKey });
  }
  return sources;
}

export async function collectUsageSnapshots(
  providers: readonly ProviderUsageProfile[],
  readApiKey: (providerId: string) => string | null,
): Promise<ProviderUsageSnapshot[]> {
  const sources = resolveUsageSources(providers, readApiKey);
  return Promise.all(
    sources.map((source) =>
      source.adapter.query({ ...source.profile, apiKey: source.apiKey }),
    ),
  );
}
