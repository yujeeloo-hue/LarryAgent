import type { ComposerOptions } from "./types.js";

export type ComposerProbe = "unknown" | "legacy" | "ok";

export interface ComposerCap {
  probe: ComposerProbe;
  version: string;
  options: ComposerOptions | null;
}

export interface ComposerProbeDeps {
  request: (deviceId: string, timeoutMs: number) => Promise<ComposerOptions>;
  deviceVersion: (deviceId: string) => string;
  probeTimeoutMs?: number;
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (handle: number) => void;
  retryDelaysMs?: number[];
}

export interface ComposerProbeStore {
  capFor(deviceId: string | null): ComposerOptions | null;
  probeOf(deviceId: string): ComposerProbe;
  ensure(deviceId: string): Promise<boolean>;
  invalidate(deviceId: string): void;
  scheduleRetry(
    deviceId: string,
    onSettled: () => void,
    active: () => boolean,
  ): void;
  stopRetry(): void;
}

export function createComposerProbeStore(deps: ComposerProbeDeps): ComposerProbeStore {
  const caps = new Map<string, ComposerCap>();
  const probeTimeoutMs = deps.probeTimeoutMs ?? 10000;
  const schedule = deps.schedule ?? ((fn, ms) => window.setTimeout(fn, ms));
  const cancel = deps.cancel ?? ((handle) => window.clearTimeout(handle));
  const ladder = deps.retryDelaysMs?.length ? [...deps.retryDelaysMs] : [3000, 8000, 15000];
  const delayFor = (step: number): number => ladder[Math.min(step, ladder.length - 1)] ?? 3000;

  const probeOf = (deviceId: string): ComposerProbe => caps.get(deviceId)?.probe ?? "unknown";

  const capFor = (deviceId: string | null): ComposerOptions | null => {
    if (!deviceId) return null;
    const cap = caps.get(deviceId);
    return cap && cap.probe === "ok" ? cap.options : null;
  };

  const invalidate = (deviceId: string): void => {
    caps.delete(deviceId);
  };

  const probeOnce = async (deviceId: string): Promise<boolean> => {
    const version = deps.deviceVersion(deviceId);
    const cached = caps.get(deviceId);
    if (cached && cached.version === version && cached.probe !== "unknown") return false;
    let cap: ComposerCap;
    try {
      const options = await deps.request(deviceId, probeTimeoutMs);
      cap = { probe: "ok", version, options };
    } catch (err) {
      const legacy = /unknown action/i.test((err as Error).message ?? "");
      cap = { probe: legacy ? "legacy" : "unknown", version, options: null };
    }
    const changed =
      !cached ||
      cached.probe !== cap.probe ||
      cached.version !== cap.version ||
      JSON.stringify(cached.options) !== JSON.stringify(cap.options);
    if (cap.probe !== "unknown") caps.set(deviceId, cap);
    return changed;
  };

  const inflight = new Map<string, Promise<boolean>>();

  const ensure = (deviceId: string): Promise<boolean> => {
    const existing = inflight.get(deviceId);
    if (existing) return existing;
    const run = probeOnce(deviceId).finally(() => {
      inflight.delete(deviceId);
    });
    inflight.set(deviceId, run);
    return run;
  };

  let retry: { deviceId: string; step: number; timer: number } | null = null;

  const stopRetry = (): void => {
    if (!retry) return;
    cancel(retry.timer);
    retry = null;
  };

  const scheduleRetry = (deviceId: string, onSettled: () => void, active: () => boolean): void => {
    const settled = probeOf(deviceId);
    if (settled !== "unknown") return;
    if (retry?.deviceId === deviceId) return;
    stopRetry();
    const state = { deviceId, step: 0, timer: 0 };
    retry = state;
    const tick = (): void => {
      state.timer = schedule(() => {
        void (async () => {
          if (retry !== state) return;
          if (!active()) {
            stopRetry();
            return;
          }
          const hadCap = capFor(deviceId) != null;
          await ensure(deviceId);
          if (retry !== state) return;
          const probe = probeOf(deviceId);
          if (probe !== "unknown") {
            retry = null;
            if (!hadCap) onSettled();
          } else {
            state.step = Math.min(state.step + 1, ladder.length - 1);
            tick();
          }
        })();
      }, delayFor(state.step));
    };
    tick();
  };

  return { capFor, probeOf, ensure, invalidate, scheduleRetry, stopRetry };
}
