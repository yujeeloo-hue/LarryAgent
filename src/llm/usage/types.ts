
export type UsageProviderKey =
  | "kimi-code"
  | "glm-code"
  | "kimi"
  | "deepseek"
  | "openrouter"
  | "qwen-code";

export type UsageBar = {
  label: string;
  percent: number;
  detail?: string;
};

export type ProviderUsageSnapshot = {
  key: UsageProviderKey;
  title: string;
  badge?: string;
  bars: UsageBar[];
  lines: string[];
  error?: string;
  fetchedAt: number;
};

export type ProviderUsageProfile = {
  id: string;
  name: string;
  baseUrl: string;
  modelId?: string;
};

export type ProviderUsageQueryInput = ProviderUsageProfile & {
  apiKey: string;
};

export type ProviderUsageAdapter = {
  key: UsageProviderKey;
  matches: (provider: ProviderUsageProfile) => boolean;
  query: (input: ProviderUsageQueryInput) => Promise<ProviderUsageSnapshot>;
};
