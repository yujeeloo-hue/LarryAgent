import { deepseekBalanceAdapter } from "./deepseek.js";
import { glmBalanceAdapter } from "./glm.js";
import { kimiBalanceAdapter } from "./kimi.js";
import type {
  ProviderBalanceAdapter,
  ProviderBalanceProfile,
  ProviderBalanceQueryInput,
  ProviderBalanceResult,
} from "./types.js";

/** Ordered adapters — first match wins. Add new providers here. */
const BALANCE_ADAPTERS: readonly ProviderBalanceAdapter[] = [
  deepseekBalanceAdapter,
  glmBalanceAdapter,
  kimiBalanceAdapter,
];

export function resolveBalanceAdapter(
  provider: ProviderBalanceProfile,
): ProviderBalanceAdapter | null {
  return BALANCE_ADAPTERS.find((adapter) => adapter.matches(provider)) ?? null;
}

/**
 * Query the matching provider balance adapter.
 * Unsupported providers / failures → `{ text: null }` (UI shows nothing).
 */
export async function queryProviderBalance(
  input: ProviderBalanceQueryInput,
): Promise<ProviderBalanceResult> {
  const adapter = resolveBalanceAdapter(input);
  if (!adapter) {
    return { providerId: input.id, text: null };
  }
  const text = await adapter.query(input);
  return { providerId: input.id, text };
}
