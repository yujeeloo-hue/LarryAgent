import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { computerUseCacheDir } from "./cache.js";
import type { ComputerUsePlatform } from "./types.js";

/** First start on Windows compiles the C# worker (cached afterwards), so allow a generous handshake. */
const READY_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL_CHARS = 4_000;

export type WorkerRequestOptions = { timeoutMs?: number; signal?: AbortSignal };

export interface ComputerUseBackend {
  readonly platform: ComputerUsePlatform;
  request<T = Record<string, unknown>>(
    cmd: string,
    args?: Record<string, unknown>,
    options?: WorkerRequestOptions,
  ): Promise<T>;
}

export class ComputerUseError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ComputerUseError";
  }
}

export function computerUsePlatform(
  platform: NodeJS.Platform = process.platform,
): ComputerUsePlatform | null {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return null;
}

export function computerUseHelperPath(platform: ComputerUsePlatform): string {
  const override = process.env.JELLYBOT_COMPUTER_USE_HELPER?.trim();
  if (override) return resolve(override);
  const relative =
    platform === "windows"
      ? { packaged: ["computer-use", "windows-worker.ps1"], dev: ["resources", "computer-use", "windows-worker.ps1"] }
      : { packaged: ["helpers", "macos-computer-use"], dev: ["build", "helpers", "macos-computer-use"] };
  const candidates = [
    ...(typeof process.resourcesPath === "string" && process.resourcesPath
      ? [join(process.resourcesPath, ...relative.packaged)]
      : []),
    join(process.cwd(), ...relative.dev),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[candidates.length - 1]!;
}

function powershellExecutable(): string {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const full = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(full) ? full : "powershell.exe";
}

// The worker script is loaded through a ScriptBlock so machine execution policies cannot block it.
export function windowsWorkerCommand(scriptPath: string): { command: string; args: string[] } {
  const literal = scriptPath.replace(/'/g, "''");
  const bootstrap = `& ([ScriptBlock]::Create([IO.File]::ReadAllText('${literal}', [Text.Encoding]::UTF8)))`;
  return {
    command: powershellExecutable(),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(bootstrap, "utf16le").toString("base64"),
    ],
  };
}

/** ASCII-only JSON so neither side depends on console code pages. */
export function encodeRequestLine(payload: unknown): string {
  return `${JSON.stringify(payload).replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function abortError(): Error {
  const error = new Error("Cancelled");
  error.name = "AbortError";
  return error;
}

export class ComputerUseWorker implements ComputerUseBackend {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrTail = "";
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly platform: ComputerUsePlatform) {}

  request<T = Record<string, unknown>>(
    cmd: string,
    args: Record<string, unknown> = {},
    options: WorkerRequestOptions = {},
  ): Promise<T> {
    const run = this.queue.then(() => this.send<T>(cmd, args, options));
    this.queue = run.catch(() => undefined);
    return run;
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (child && child.exitCode === null) child.kill();
  }

  private async send<T>(cmd: string, args: Record<string, unknown>, options: WorkerRequestOptions): Promise<T> {
    if (options.signal?.aborted) throw abortError();
    await this.ensureStarted();
    const child = this.child;
    if (!child) throw new ComputerUseError("Computer use helper is not running.", "helper_failed");

    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<T>((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        fn();
      };
      const onAbort = () => finish(() => rejectPromise(abortError()));
      const timer = setTimeout(() => {
        finish(() => rejectPromise(new ComputerUseError(`Computer use helper timed out on ${cmd} after ${Math.round(timeoutMs / 1000)}s.`, "timeout")));
        // A stuck worker would block every later request; restart it on next use.
        this.dispose();
      }, timeoutMs);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => finish(() => resolvePromise(value as T)),
        reject: (error) => finish(() => rejectPromise(error)),
      });
      child.stdin.write(encodeRequestLine({ id, cmd, args }));
    });
  }

  private ensureStarted(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.ready) return this.ready;
    const helper = computerUseHelperPath(this.platform);
    if (!existsSync(helper)) {
      return Promise.reject(
        new ComputerUseError(
          this.platform === "macos"
            ? `The macOS computer use helper is missing at ${helper}. Rebuild the app (npm run build) and try again.`
            : `The Windows computer use worker script is missing at ${helper}. Reinstall the app and try again.`,
          "helper_missing",
        ),
      );
    }
    const { command, args } =
      this.platform === "windows"
        ? windowsWorkerCommand(helper)
        : { command: helper, args: [] as string[] };

    this.stdoutBuffer = "";
    this.stderrTail = "";
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        JELLYBOT_COMPUTER_USE_CACHE: computerUseCacheDir(),
      },
    });
    this.child = child;

    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      let handshake = false;
      const timer = setTimeout(() => {
        rejectReady(new ComputerUseError(`Computer use helper did not start within ${READY_TIMEOUT_MS / 1000}s.${this.stderrSuffix()}`, "helper_failed"));
        if (this.child === child) this.dispose();
      }, READY_TIMEOUT_MS);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        this.stdoutBuffer += chunk;
        let newline = this.stdoutBuffer.indexOf("\n");
        while (newline >= 0) {
          const line = this.stdoutBuffer.slice(0, newline).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
          newline = this.stdoutBuffer.indexOf("\n");
          if (!line) continue;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line) as Record<string, unknown>;
          } catch {
            this.appendStderr(`${line}\n`);
            continue;
          }
          if (message.ready === true) {
            handshake = true;
            clearTimeout(timer);
            resolveReady();
            continue;
          }
          this.dispatch(message);
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => this.appendStderr(chunk));
      const onGone = (error?: Error) => {
        clearTimeout(timer);
        const detail = error ? ` ${error.message}` : this.stderrSuffix();
        const failure = new ComputerUseError(
          handshake ? `Computer use helper exited unexpectedly.${detail}` : `Computer use helper failed to start.${detail}`,
          "helper_failed",
        );
        if (!handshake) rejectReady(failure);
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
        for (const pending of [...this.pending.values()]) pending.reject(failure);
      };
      child.on("error", (error) => onGone(error));
      child.on("exit", () => onGone());
    });
    // The handshake rejection is surfaced to the caller; avoid an unhandled rejection here.
    this.ready.catch(() => undefined);
    return this.ready;
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = typeof message.id === "number" ? message.id : Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    if (message.ok === true) {
      pending.resolve(message.result ?? {});
    } else {
      pending.reject(
        new ComputerUseError(
          typeof message.error === "string" && message.error ? message.error : "Computer use helper reported an error.",
          typeof message.code === "string" && message.code ? message.code : "native_error",
        ),
      );
    }
  }

  private appendStderr(chunk: string): void {
    this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  }

  private stderrSuffix(): string {
    const tail = this.stderrTail.trim();
    return tail ? ` ${tail.split(/\r?\n/).slice(-6).join(" ")}` : "";
  }
}

let sharedWorker: ComputerUseWorker | null = null;
let macosFallback: ComputerUseWorker | null = null;
let macosBackend: ComputerUseBackend | null = null;
let backendOverride: ComputerUseBackend | null = null;

export type NativeComputerUseModule = { dispatch: (request: string) => Promise<string> };

export function computerUseNativeModulePath(): string {
  const override = process.env.JELLYBOT_COMPUTER_USE_NATIVE_MODULE?.trim();
  if (override) return resolve(override);
  const relative = {
    packaged: ["helpers", "macos-computer-use.node"],
    dev: ["build", "helpers", "macos-computer-use.node"],
  };
  const candidates = [
    ...(typeof process.resourcesPath === "string" && process.resourcesPath
      ? [join(process.resourcesPath, ...relative.packaged)]
      : []),
    join(process.cwd(), ...relative.dev),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[candidates.length - 1]!;
}

export function createNativeComputerUseBackend(module: NativeComputerUseModule): ComputerUseBackend {
  let nextId = 1;
  return {
    platform: "macos",
    request<T>(cmd: string, args: Record<string, unknown> = {}, options: WorkerRequestOptions = {}): Promise<T> {
      if (options.signal?.aborted) return Promise.reject(abortError());
      const payload = JSON.stringify({ id: nextId++, cmd, args });
      const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      return new Promise<T>((resolvePromise, rejectPromise) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          fn();
        };
        const onAbort = () => finish(() => rejectPromise(abortError()));
        const timer = setTimeout(() => {
          finish(() => rejectPromise(new ComputerUseError(`Computer use native module timed out on ${cmd} after ${Math.round(timeoutMs / 1000)}s.`, "timeout")));
        }, timeoutMs);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        Promise.resolve()
          .then(() => module.dispatch(payload))
          .then(
            (raw) => {
              let message: Record<string, unknown>;
              try {
                message = JSON.parse(raw) as Record<string, unknown>;
              } catch {
                finish(() => rejectPromise(new ComputerUseError("Computer use helper returned an invalid response.", "helper_failed")));
                return;
              }
              if (message.ok === true) {
                finish(() => resolvePromise((message.result ?? {}) as T));
                return;
              }
              const code = typeof message.code === "string" ? message.code : "helper_failed";
              const error = typeof message.error === "string" && message.error ? message.error : "Computer use helper reported an error.";
              finish(() => rejectPromise(new ComputerUseError(error, code)));
            },
            (error: unknown) => {
              finish(() => rejectPromise(error instanceof ComputerUseError
                ? error
                : new ComputerUseError(error instanceof Error ? error.message : String(error), "helper_failed")));
            },
          );
      });
    },
  };
}

function macosBackendForApp(): ComputerUseBackend {
  if (macosBackend) return macosBackend;
  if (process.env.JELLYBOT_COMPUTER_USE_FORCE_HELPER === "1") {
    return macosFallback ??= new ComputerUseWorker("macos");
  }
  const modulePath = computerUseNativeModulePath();
  if (!existsSync(modulePath)) return macosFallback ??= new ComputerUseWorker("macos");
  try {
    const loaded = createRequire(import.meta.url)(modulePath) as Partial<NativeComputerUseModule>;
    if (typeof loaded.dispatch !== "function") throw new Error("module does not export dispatch");
    macosBackend = createNativeComputerUseBackend({ dispatch: loaded.dispatch.bind(loaded) });
    return macosBackend;
  } catch (error) {
    throw new ComputerUseError(
      `Could not load the macOS computer use native module at ${modulePath}: ${error instanceof Error ? error.message : String(error)}`,
      "helper_failed",
    );
  }
}

export function getComputerUseBackend(): ComputerUseBackend {
  if (backendOverride) return backendOverride;
  const platform = computerUsePlatform();
  if (!platform) {
    throw new ComputerUseError("Computer use is available only on macOS and Windows.", "unsupported_platform");
  }
  if (platform === "macos") return macosBackendForApp();
  if (!sharedWorker) {
    sharedWorker = new ComputerUseWorker(platform);
    process.once("exit", () => sharedWorker?.dispose());
  }
  return sharedWorker;
}

export function setComputerUseBackendForTests(backend: ComputerUseBackend | null): void {
  backendOverride = backend;
}
