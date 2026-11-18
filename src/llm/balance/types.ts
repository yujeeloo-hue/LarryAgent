
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
  id: string;
  matches: (provider: ProviderBalanceProfile) => boolean;
  query: (input: ProviderBalanceQueryInput) => Promise<string | null>;
};

export type ProviderBalanceResult = {
  providerId: string;
  text: string | null;
};
