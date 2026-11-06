import { execShellProcess, type ShellExecInput, type ShellExecResult } from "../tools/shellExec.js";

/** Uses Larry Agent's Shell executor; only lifetime is owned by CoCo. */
export class CocoToolRuntime {
  private active = new Map<AbortController, Promise<ShellExecResult>>();
  private stopped = false;
  shell(input: ShellExecInput, excludedPaths: string[]): Promise<ShellExecResult> {
    if (this.stopped) return Promise.reject(new Error("CoCo is stopping"));
    const abort = new AbortController();
    const signal = input.signal ? AbortSignal.any([abort.signal, input.signal]) : abort.signal;
    const pending = execShellProcess({ ...input, signal, managed: true, excludedPaths }).finally(() => this.active.delete(abort));
    this.active.set(abort, pending); return pending;
  }
  async close(): Promise<void> { this.stopped = true; const active = [...this.active]; active.forEach(([abort]) => abort.abort()); await Promise.allSettled(active.map(([,pending]) => pending)); }
}
