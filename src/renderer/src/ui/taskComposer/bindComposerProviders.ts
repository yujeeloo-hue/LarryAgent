import {
  getProvidersState,
  setProvidersState,
  subscribeProviders,
  type ProvidersState,
} from "../../state/activeProviderState.js";
import type { TaskComposerView } from "./TaskComposerView.js";

const HEALTH_INTERVAL_MS = 60_000;

function requireBridge(): NonNullable<Window["jellybot"]> {
  const bridge = window.jellybot;
  if (!bridge) {
    throw new Error("jellybot bridge is unavailable");
  }
  return bridge;
}

export type BindComposerProvidersOptions = {
  getProviderId: () => string;
  onProviderSelect: (providerId: string) => void | Promise<void>;
  onSelectionMissing?: (fallbackId: string) => void;
  isLocked?: () => boolean;
};

export type ComposerProvidersBinding = {
  dispose: () => void;
  refresh: () => void;
};

export function bindComposerProviders(
  composer: TaskComposerView,
  options: BindComposerProvidersOptions,
): ComposerProvidersBinding {
  let disposed = false;
  let healthTimer: ReturnType<typeof setInterval> | undefined;

  const resolveSelectedId = (state: ProvidersState): string => {
    const requested = options.getProviderId().trim();
    if (requested && state.providers.some((p) => p.id === requested)) {
      return requested;
    }
    if (state.providers.some((p) => p.id === state.activeProviderId)) {
      return state.activeProviderId;
    }
    return state.providers[0]?.id ?? state.activeProviderId;
  };

  let adoptedKey = "";

  const adoptMissingSelection = (
    state: ProvidersState,
    fallbackId: string,
  ): void => {
    const requested = options.getProviderId().trim();
    if (!requested || state.providers.some((p) => p.id === requested)) {
      adoptedKey = "";
      return;
    }
    if (!fallbackId || fallbackId === requested || state.providers.length === 0) {
      return;
    }
    const key = `${requested}\0${fallbackId}`;
    if (adoptedKey === key) return;
    adoptedKey = key;
    options.onSelectionMissing?.(fallbackId);
  };

  const applyState = (state: ProvidersState): void => {
    const selectedId = resolveSelectedId(state);
    composer.setProviders(
      state.providers.map((p) => ({
        id: p.id,
        name: p.name,
        modelId: p.modelId,
        baseUrl: p.baseUrl,
      })),
      selectedId,
    );
    adoptMissingSelection(state, selectedId);
  };

  const probeHealth = async (): Promise<void> => {
    if (disposed) return;
    try {
      const providerId = resolveSelectedId(getProvidersState());
      const result = await requireBridge().checkLlmHealth({ providerId });
      if (!disposed) composer.setHealthOk(result.ok);
    } catch {
      if (!disposed) composer.setHealthOk(false);
    }
  };

  const refresh = (): void => {
    if (disposed) return;
    applyState(getProvidersState());
    void probeHealth();
  };

  const unsub = subscribeProviders((state) => {
    applyState(state);
    void probeHealth();
  });

  composer.setOnProviderSelect((providerId) => {
    if (options.isLocked?.()) return;
    void (async () => {
      try {
        await options.onProviderSelect(providerId);
        if (!disposed) refresh();
      } catch (err) {
        console.error("[composer] set session provider failed", err);
        if (!disposed) refresh();
      }
    })();
  });

  applyState(getProvidersState());
  void probeHealth();
  healthTimer = setInterval(() => {
    void probeHealth();
  }, HEALTH_INTERVAL_MS);

  return {
    dispose: () => {
      disposed = true;
      unsub();
      composer.setOnProviderSelect(null);
      if (healthTimer) clearInterval(healthTimer);
    },
    refresh,
  };
}

export async function bootstrapProvidersFromSettings(): Promise<void> {
  try {
    const snapshot = await window.jellybot?.getSettingsSnapshot?.();
    if (!snapshot) return;
    setProvidersState({
      providers: snapshot.settings.providers,
      activeProviderId: snapshot.settings.activeProviderId,
    });
  } catch (err) {
    console.error("[providers] bootstrap failed", err);
  }
}
