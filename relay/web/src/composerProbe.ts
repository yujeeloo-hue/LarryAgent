/**
 * Composer capability probe + self-heal retry (web console).
 *
 * The console hides the Mac-parity composer controls until a device answers
 * `listComposerOptions`; anything unresolved renders the legacy
 * `.composer-row` fallback (plain textarea + accent send button). The probe
 * carries a SHORTER budget than regular requests (10s vs 25s), so a busy
 * device or a flaky phone network fails it while `getSession` still succeeds
 * — the conversation then opens on the wrong composer. This module retries
 * an unresolved probe with backoff and reports the settle so the caller can
 * repaint; known-legacy devices settle immediately and never retry.
 *
 * Extracted from main.ts (no DOM/client imports) so the retry ladder and
 * stop conditions are unit-testable — see test/composerProbe.test.ts.
 */
import type { ComposerOptions } from "./types.js";

export type ComposerProbe = "unknown" | "legacy" | "ok";

export interface ComposerCap {
  probe: ComposerProbe;
  /** Device version captured at probe time — re-probe when it changes. */
  version: string;
  options: ComposerOptions | null;
}

export interface ComposerProbeDeps {
  /** Device request transport (rejects on timeout / relay / device error). */
  request: (deviceId: string, timeoutMs: number) => Promise<ComposerOptions>;
  /** Current version string of the device ("" when absent). */
  deviceVersion: (deviceId: string) => string;
  /** Probe budget; shorter than the client default on purpose (see above). */
  probeTimeoutMs?: number;
  /** Injectable clock for tests — defaults to window.setTimeout. */
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (handle: number) => void;
  /** Backoff ladder for unresolved probes; the last step repeats forever. */
  retryDelaysMs?: number[];
}

export interface ComposerProbeStore {
  /** Options for a modern device; null → unresolved/legacy, hide controls. */
  capFor(deviceId: string | null): ComposerOptions | null;
  /** Cached probe state ("unknown" when never settled or transient-failed). */
  probeOf(deviceId: string): ComposerProbe;
  /**
   * Probe once. Returns true when the cached capability changed in a way
   * callers should repaint for. Transient failures stay "unknown"
   * (uncached) so later calls retry; "legacy" is sticky per version.
   * Concurrent calls for one device share a single probe.
   */
  ensure(deviceId: string): Promise<boolean>;
  /**
   * Drop the cached capability — the device says its provider list moved
   * (providers_changed push), so the next ensure() must hit the wire.
   */
  invalidate(deviceId: string): void;
  /**
   * Backoff-retry an unresolved probe — schedule after a render showed the
   * composer loading placeholder (probe unresolved on an online device).
   * Fires onSettled exactly once per schedule when the probe settles —
   * "ok" (placeholder → toolbar) or "legacy" (placeholder → plain
   * composer); both need the repaint. Stops on settle, on a scheduleRetry
   * for a different device, or whenever active() turns false — plain
   * navigation away is the escape hatch, nothing polls forever.
   */
  scheduleRetry(
    deviceId: string,
    onSettled: () => void,
    active: () => boolean,
  ): void;
  /** Drop any pending retry (device switch, teardown). */
  stopRetry(): void;
}

export function createComposerProbeStore(deps: ComposerProbeDeps): ComposerProbeStore {
  const caps = new Map<string, ComposerCap>();
  const probeTimeoutMs = deps.probeTimeoutMs ?? 10000;
  const schedule = deps.schedule ?? ((fn, ms) => window.setTimeout(fn, ms));
  const cancel = deps.cancel ?? ((handle) => window.clearTimeout(handle));
  const ladder = deps.retryDelaysMs?.length ? [...deps.retryDelaysMs] : [3000, 8000, 15000];
  /** Ladder is non-empty by construction; index access with a safe fallback. */
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
      // Transient failures stay "unknown" (uncached) — retried later.
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

  // One probe on the wire per device even when callers race (menu open +
  // providers_changed push landing together).
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
    if (settled !== "unknown") return; // ok → nothing to heal; legacy → fallback is correct
    if (retry?.deviceId === deviceId) return; // already pending for this device
    stopRetry();
    const state = { deviceId, step: 0, timer: 0 };
    retry = state;
    const tick = (): void => {
      state.timer = schedule(() => {
        void (async () => {
          if (retry !== state) return; // superseded or stopped meanwhile
          if (!active()) {
            stopRetry();
            return;
          }
          // The capability may have settled through another path (e.g. the
          // conversation's own loadSession probe) while this retry waited —
          // stop without the repaint then.
          const hadCap = capFor(deviceId) != null;
          await ensure(deviceId);
          if (retry !== state) return;
          const probe = probeOf(deviceId);
          if (probe !== "unknown") {
            retry = null; // settled — the already-fired timer needs no cancel
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
