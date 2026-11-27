
import {
  isLlmEndpointRecentlyActive,

} from "../llm/healthActivity.js";

export type LlmProbeResult = { ok: boolean; reason?: string };

export const DEFAULT_RECENT_ACTIVITY_WINDOW_MS = 60_000;
const DEFAULT_PROBE_RESULT_TTL_MS = 10_000;

type SettledProbe = { at: number; result: LlmProbeResult };

const inFlightProbes = new Map<string, Promise<LlmProbeResult>>();
const settledProbes = new Map<string, SettledProbe>();

export type CheckLlmHealthGatedOptions = {
  identity: string;
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

  if (
    options.force !== true &&
    isLlmEndpointRecentlyActive(options.identity, windowMs)
  ) {
    return { ok: true, reason: "recent_activity" };
  }

  if (options.force !== true) {
    const settled = settledProbes.get(options.identity);
    if (settled && Date.now() - settled.at < ttlMs) {
      return settled.result;
    }
  }

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

export function resetLlmHealthGateForTests(): void {
  inFlightProbes.clear();
  settledProbes.clear();
}
