/**
 * Health-probe gate shared by every renderer caller of `llm:checkHealth`
 * (main process singleton state).
 *
 * Layers, cheapest first:
 * 1. Recent real LLM interaction on this exact endpoint+model+credential →
 *    healthy without any network request ("interaction is the probe").
 * 2. A finished probe younger than `probeResultTtlMs` → reuse it, so the two
 *    composers' 60s timers never double-fire a probe.
 * 3. In-flight probes are shared — concurrent callers await one request.
 *
 * Everything is keyed by the caller-computed identity string; the gate itself
 * knows nothing about providers.
 */

import {
  isLlmEndpointRecentlyActive,

} from "../llm/healthActivity.js";

export type LlmProbeResult = { ok: boolean; reason?: string };

export const DEFAULT_RECENT_ACTIVITY_WINDOW_MS = 60_000;
/** Short reuse window that only absorbs simultaneous composer ticks. */
const DEFAULT_PROBE_RESULT_TTL_MS = 10_000;

type SettledProbe = { at: number; result: LlmProbeResult };

const inFlightProbes = new Map<string, Promise<LlmProbeResult>>();
const settledProbes = new Map<string, SettledProbe>();

export type CheckLlmHealthGatedOptions = {
  identity: string;
  /** Skip both the activity gate and result reuse (user-requested test). */
  force?: boolean;
  recentActivityWindowMs?: number;
  probeResultTtlMs?: number;
};

export async function checkLlmHealthGated(
  options: CheckLlmHealthGatedOptions,
  deps: { probe: () => Promise<LlmProbeResult> },
): Promise<LlmProbeResult> {
  const windowMs =
    options.recentActivityWindowMs ?? DEFAULT_RECENT_ACTIVITY_WINDOW_MS;
  const ttlMs = options.probeResultTtlMs ?? DEFAULT_PROBE_RESULT_TTL_MS;

  // 1. Recent real traffic already proves liveness.
  if (
    options.force !== true &&
    isLlmEndpointRecentlyActive(options.identity, windowMs)
  ) {
    return { ok: true, reason: "recent_activity" };
  }

  // 2. Fresh finished probe absorbs staggered duplicates.
  if (options.force !== true) {
    const settled = settledProbes.get(options.identity);
    if (settled && Date.now() - settled.at < ttlMs) {
      return settled.result;
    }
  }

  // 3. Share an in-flight probe.
  const existing = inFlightProbes.get(options.identity);
  if (existing) return existing;

  const run = deps
    .probe()
    .then((result) => {
      settledProbes.set(options.identity, { at: Date.now(), result });
      return result;
    })
    .finally(() => {
      inFlightProbes.delete(options.identity);
    });
  inFlightProbes.set(options.identity, run);
  return run;
}

/** Test isolation only. */
export function resetLlmHealthGateForTests(): void {
  inFlightProbes.clear();
  settledProbes.clear();
}
