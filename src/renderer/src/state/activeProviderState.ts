/**
 * Default LLM provider for **new** sessions (mirrors settings.activeProviderId).
 * Each existing session keeps its own providerId; composers bind that separately.
 */

export type ProviderSummary = {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
};

export type ProvidersState = {
  providers: ProviderSummary[];
  activeProviderId: string;
};

type Listener = (state: ProvidersState) => void;

let state: ProvidersState = {
  providers: [
    {
      id: "default",
      name: "Default",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4o-mini",
    },
  ],
  activeProviderId: "default",
};

const listeners = new Set<Listener>();

export function getProvidersState(): ProvidersState {
  return {
    providers: state.providers.map((p) => ({ ...p })),
    activeProviderId: state.activeProviderId,
  };
}

function emit(): void {
  const snapshot = getProvidersState();
  for (const listener of listeners) {
    listener(snapshot);
  }
}

export function setProvidersState(next: ProvidersState): void {
  state = {
    providers: next.providers.map((p) => ({ ...p })),
    activeProviderId: next.activeProviderId,
  };
  if (!state.providers.some((p) => p.id === state.activeProviderId)) {
    state.activeProviderId = state.providers[0]?.id ?? "default";
  }
  emit();
}

export function subscribeProviders(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
