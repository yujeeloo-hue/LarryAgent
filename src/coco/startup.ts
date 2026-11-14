type StartupPorts = {
  verify(signal: AbortSignal): Promise<{ ok: boolean; message?: string }>;
  blocked(message?: string): void;
  start(): void;
};

/** Startup-only recovery; never clears runtime ownership/budget/execution errors. */
export class CocoStartup {
  private abort = new AbortController();
  private pending: Promise<void> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  constructor(private ports: StartupPorts, private retryMs = 2000) {}
  run(): Promise<void> {
    if (this.abort.signal.aborted || this.started) return Promise.resolve();
    if (this.pending) return this.pending;
    clearTimeout(this.retry); this.retry = undefined;
    this.pending = this.attempt().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async attempt(): Promise<void> {
    let result: { ok: boolean; message?: string };
    try { result = await this.ports.verify(this.abort.signal); }
    catch (error) { result = { ok: false, message: `Cannot verify the previous scheduler: ${String(error)}. CoCo will check again automatically.` }; }
    if (this.abort.signal.aborted) return;
    if (result.ok) {
      this.ports.blocked(undefined);
      // Hand over once. A migration/runtime failure is not a reason to bypass
      // the runtime's block or repeatedly rerun its startup normalization.
      this.started = true;
      try { this.ports.start(); } catch (error) { this.ports.blocked(`CoCo could not initialize: ${String(error)}`); }
    } else {
      this.ports.blocked(result.message ?? "Waiting for the previous scheduler to stop. CoCo will check again automatically.");
      this.retry = setTimeout(() => { this.retry = undefined; void this.run(); }, this.retryMs);
      this.retry.unref();
    }
  }
  stop(): void { this.abort.abort(); clearTimeout(this.retry); this.retry = undefined; }
}
