/** Pure migration barrier; tests never load/stop a real LaunchAgent. */
export type LegacySchedulerStatus = {
  loaded: boolean;
  availability: "loaded" | "absent" | "unknown";
  pid: number | null;
  plistExists: boolean;
  lastError: string | null;
};
export type RetirementResult = { ok: boolean; message?: string };
type Ports = {
  status(): Promise<LegacySchedulerStatus>;
  uninstall(): Promise<RetirementResult>;
  processAlive(pid: number): boolean;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

/** Recognize a missing service, never a missing executable, domain or denied query. */
export function isMissingLaunchctlService(error: { code?: string | number | undefined; stderr?: string | undefined; killed?: boolean | undefined; signal?: string | null | undefined }): boolean {
  return typeof error.code === "number" && error.code > 0 && !error.killed && !error.signal && /\bcould not find (?:specified )?service\b/i.test(error.stderr ?? "");
}

/** Remember observed PIDs across retries: unloading a service does not prove its process exited. */
export function createLegacyRetirement(ports: Ports) {
  const observedPids = new Set<number>();
  return async (signal?: AbortSignal): Promise<RetirementResult> => {
    signal?.throwIfAborted();
    const before = await ports.status();
    if (before.pid && Number.isSafeInteger(before.pid) && before.pid > 0) observedPids.add(before.pid);
    if (before.availability === "unknown") return { ok: false, message: `Cannot verify legacy scheduler state: ${before.lastError ?? "unknown"}. Coco will check again automatically.` };
    if (before.loaded || before.plistExists) {
      signal?.throwIfAborted();
      const removed = await ports.uninstall();
      if (!removed.ok) return { ok: false, message: `${removed.message ?? "Could not retire the legacy scheduler"}. Coco will check again automatically.` };
    }
    // The old LaunchAgent declares ExitTimeOut=30. Allow that graceful exit,
    // then continue automatic retries without forgetting its process identity.
    const deadline = ports.now() + 35000;
    let last = before;
    while (true) {
      signal?.throwIfAborted();
      let processUnknown = false;
      for (const pid of observedPids) {
        try { if (!ports.processAlive(pid)) observedPids.delete(pid); }
        catch { processUnknown = true; }
      }
      if (last.availability === "absent" && !last.loaded && !last.plistExists && !observedPids.size && !processUnknown) return { ok: true };
      if (ports.now() >= deadline) {
        const detail = last.availability === "unknown" ? `State query failed: ${last.lastError ?? "unknown"}.` : last.plistExists ? "The old startup configuration is still present." : last.loaded ? "The legacy service has not unloaded yet." : "The previous scheduler process has not exited yet.";
        return { ok: false, message: `${detail} Coco is waiting to prevent two executors and will check again automatically.` };
      }
      await ports.sleep(250, signal);
      last = await ports.status();
      if (last.pid && Number.isSafeInteger(last.pid) && last.pid > 0) observedPids.add(last.pid);
    }
  };
}
