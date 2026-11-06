/**
 * Pluggable provider balance queries.
 * Each adapter matches a provider and returns English description text for the UI.
 */

export type ProviderBalanceProfile = {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
};

export type ProviderBalanceQueryInput = ProviderBalanceProfile & {
  apiKey: string;
};

export type ProviderBalanceAdapter = {
  /** Stable adapter id (e.g. deepseek). */
  id: string;
  matches: (provider: ProviderBalanceProfile) => boolean;
  /** English UI line, or null when unavailable / failed. */
  query: (input: ProviderBalanceQueryInput) => Promise<string | null>;
};

export type ProviderBalanceResult = {
  providerId: string;
  /** English description, or null when unsupported / failed. */
  text: string | null;
};
