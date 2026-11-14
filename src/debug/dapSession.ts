/**
 * Minimal debug session: spawn lldb-dap, set breakpoints, inspect stack/locals.
 */
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename, dirname, delimiter } from "node:path";
import { DapClient, isDapNotStopped } from "./dapClient.js";
import type { DapEvent } from "./dapFraming.js";
import {
  frameModuleKeys,
  frameModuleLabel,
  frameSourceFile,
  moduleKeysOf,
} from "./frameSource.js";
import type {
  DapEvaluateBody,
  DapInitializeBody,
  DapLoadModuleSymbolsBody,
  DapScope,
  DapScopesBody,
  DapSetBreakpointsBody,
  DapStackFrame,
  DapStackTraceBody,
  DapStoppedEvent,
  DapThread,
  DapVariable,
  DapVariablesBody,
} from "./dapTypes.js";

/**
 * One Debug Console row. Contents are what the debug target and the debugger
 * say — program output, LLDB command results, adapter errors — not DAP wire
 * traffic.
 */
export type DebugConsoleEntry = {
  timestamp: number;
  /** `send` = command issued to the debugger; `receive` = its output. */
  direction: "send" | "receive" | "error";
  text: string;
};

export type LineBreakpoint = {
  line: number;
  /** DAP `condition` expression; omit or blank = always break. */
  condition?: string;
};

export type SourceBreakpoint = LineBreakpoint & {
  path: string;
};

/** DAP `setBreakpoints.breakpoints` — blank conditions are omitted. */
export function toDapBreakpoints(
  breakpoints: LineBreakpoint[],
): Array<{ line: number; condition?: string }> {
  return breakpoints.map((bp) => {
    const condition = bp.condition?.trim();
    return condition ? { line: bp.line, condition } : { line: bp.line };
  });
}

const LLDB_INIT_COMMANDS = [
  // Stock lldb-dap uses LLDB command syntax directly. A leading `?` is a
  // CodeLLDB extension and makes these commands invalid in stock LLVM.
  "settings set symbols.load-on-demand true",
  "settings set target.preload-symbols false",
  "settings set symbols.enable-external-lookup false",
  "settings set target.process.stop-on-sharedlibrary-events false",
  "settings set symbols.enable-lldb-index-cache true",
  // JITLoaderGDB plants a breakpoint on `__jit_debug_register_code`, which GPU
  // drivers' shader JITs call per compiled PSO; each hit is a full stop plus a
  // single-step over the site, which freezes the editor during PSO warm-up.
  "settings set plugin.jit-loader.gdb.enable off",
];

/** Unreal attach loads hundreds of PDBs before `initialized`. */
const LLDB_PROCESS_TIMEOUT_SEC = 300;

/** Windows PDB reader is not a setting on Apple/Linux LLDB. */
export function lldbInitCommands(os: NodeJS.Platform = process.platform): string[] {
  if (os !== "win32") return [...LLDB_INIT_COMMANDS];
  const commands = [...LLDB_INIT_COMMANDS];
  commands.splice(commands.length - 1, 0, "settings set plugin.symbol-file.pdb.reader native");
  return commands;
}

/** Attach/launch arguments shared by the Larry PDB adapter and stock lldb-dap. */
export function lldbAttachArguments(input: {
  attachPid: number;
  pdbModuleAllowlist?: string[];
  /** False omits `pdbModuleAllowlist`. Stock lldb-dap has no such field. */
  usePdbAllowlist?: boolean;
  os?: NodeJS.Platform;
}): Record<string, unknown> {
  const args: Record<string, unknown> = {
    name: "Larry Agent",
    pid: input.attachPid,
    stopOnEntry: false,
    timeout: LLDB_PROCESS_TIMEOUT_SEC,
    // lldb-dap runs initCommands before creating the target, which is
    // required for symbols.load-on-demand to wrap each SymbolFile.
    initCommands: lldbInitCommands(input.os),
  };
  if (input.usePdbAllowlist !== false) {
    args.pdbModuleAllowlist = input.pdbModuleAllowlist?.filter((name) => name.trim()) ?? [];
  }
  return args;
}

const INITIALIZED_TIMEOUT_MS = 600_000;
const START_REQUEST_TIMEOUT_MS = 720_000;
const CONFIGURATION_DONE_TIMEOUT_MS = 180_000;

export function quoteLldbArg(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Read the values out of `settings show <array setting>`:
 *
 * ```text
 * target.pdb-module-allowlist (array of strings) =
 *   [0]: "UnrealEditor-NF-Win64-DebugGame.dll"
 * ```
 */
export function parseLldbStringList(output: string): string[] {
  const values: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const raw = /^\s*\[\d+\]:\s*(.*)$/.exec(line)?.[1]?.trim();
    if (!raw) continue;
    values.push(raw.replace(/^"(.*)"$/, "$1"));
  }
  return values;
}

/** File:line breakpoint limited to game modules — avoids hydrating every Unreal PDB. */
export function buildShlibBreakpointCommand(input: {
  file: string;
  line: number;
  shlibs: string[];
  condition?: string;
}): string {
  const parts = [
    "breakpoint set",
    "--file",
    quoteLldbArg(input.file),
    "--line",
    String(input.line),
  ];
  for (const shlib of input.shlibs) {
    parts.push("--shlib", quoteLldbArg(shlib));
  }
  const condition = input.condition?.trim();
  if (condition) parts.push("--condition", quoteLldbArg(condition));
  return parts.join(" ");
}

export type LaunchDebugSessionInput = {
  protocol?: "lldb" | "coreclr";
  adapterPath: string;
  /** Extra argv after the adapter executable. */
  adapterArgs?: string[];
  program: string;
  cwd?: string;
  args?: string[];
  breakpoints: SourceBreakpoint[];
  /** Wait for the first stopped event. Default 30s. */
  stopTimeoutMs?: number;
  /** Tests/CLI wait for a breakpoint; UI sessions return once launched. */
  waitForStop?: boolean;
  /** Attach to an already-running process instead of DAP `launch`. */
  attachPid?: number;
  /** Extra process to kill on dispose (the GUI debuggee we spawned). */
  debuggee?: ChildProcess | null;
  /**
   * Restrict file:line breakpoints to these module basenames (`--shlib`).
   * Omit to use DAP setBreakpoints (searches every loaded module).
   */
  shlibs?: string[];
  /**
   * Custom Larry lldb-dap attach capability. Disallowed module basenames stay
   * mapped but cannot locate or open a PDB. Stock lldb-dap leaves this false
   * and relies on `symbols.load-on-demand`.
   */
  pdbModuleAllowlist?: string[];
  /** Default true. False omits `pdbModuleAllowlist` (stock lldb-dap). */
  usePdbAllowlist?: boolean;
  onProgress?: (text: string) => void;
  onConsole?: (entry: DebugConsoleEntry) => void;
};

/** DAP `output` categories that represent a failure rather than program text. */
const ERROR_OUTPUT_CATEGORIES = new Set(["stderr", "important"]);

/** `Breakpoint 3: where = NF.dll\`AFoo::Tick + 32 at Foo.cpp:12` */
export function parseLldbBreakpointId(result: string): number | null {
  const match = /^Breakpoint\s+(\d+):/m.exec(result);
  const id = match?.[1] ? Number(match[1]) : NaN;
  return Number.isInteger(id) ? id : null;
}

/** LLDB reports an unbound breakpoint as "no locations (pending)". */
export function isUnresolvedBreakpointResult(result: string): boolean {
  return /no locations/i.test(result);
}

export class DebugSession {
  ended = false;
  private protocol: "lldb" | "coreclr" = "lldb";
  private ownsDapLaunch = false;
  private lastStopped: DapStoppedEvent | null = null;
  private stderr = "";
  private shlibs: string[] = [];
  private usePdbAllowlist = true;
  private onConsole: ((entry: DebugConsoleEntry) => void) | undefined;
  /** LLDB ids of the breakpoints this session planted. */
  private readonly ownBreakpointIds = new Set<number>();
  /** Engine/module PDBs explicitly hydrated after a call-stack click. */
  private readonly onDemandSymbolModules = new Set<string>();
  private readonly breakpointsByPath = new Map<string, LineBreakpoint[]>();
  private readonly offStopped: () => void;

  private constructor(
    readonly client: DapClient,
    private readonly child: ChildProcessWithoutNullStreams | null,
    private readonly debuggee: ChildProcess | null = null,
  ) {
    client.onEvent("terminated", () => { this.ended = true; });
    client.onEvent("exited", () => { this.ended = true; });
    this.offStopped = client.onEvent("stopped", (ev) => {
      this.lastStopped = (ev.body ?? {}) as DapStoppedEvent;
    });
  }

  static async launch(input: LaunchDebugSessionInput): Promise<DebugSession> {
    const child = spawnAdapter(input.adapterPath, input.adapterArgs ?? []);
    const session = new DebugSession(
      new DapClient({
        readable: child.stdout,
        writable: child.stdin,
        timeoutMs: 20_000,
        ...(input.onConsole
          ? {
              onDiagnostic: (text) =>
                input.onConsole?.({
                  timestamp: Date.now(),
                  direction: "error",
                  text,
                }),
            }
          : {}),
      }),
      child,
      input.debuggee ?? null,
    );
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      session.stderr += text;
      input.onConsole?.({
        timestamp: Date.now(),
        direction: "error",
        text: `lldb-dap stderr ${text.trimEnd()}`,
      });
    });
    try {
      await session.configureAndLaunch(input);
      return session;
    } catch (err) {
      await session.dispose();
      const extra = session.stderr.trim();
      if (!extra) throw err;
      const wrapped = new Error(
        `${err instanceof Error ? err.message : String(err)}\nAdapter stderr:\n${extra}`,
      );
      throw wrapped;
    }
  }

  /** In-process streams (tests) — skips spawn. */
  static fromClient(client: DapClient): DebugSession {
    return new DebugSession(client, null);
  }

  /** The debug target's own output is what the Debug Console is for. */
  private pipeOutputEvents(): void {
    if (!this.onConsole) return;
    this.client.onEvent("output", (ev) => {
      const body = ev.body as
        | { category?: string; output?: string }
        | undefined;
      const category = body?.category ?? "console";
      const direction = ERROR_OUTPUT_CATEGORIES.has(category)
        ? "error"
        : "receive";
      for (const line of String(body?.output ?? "").split(/\r?\n/)) {
        const text = line.trimEnd();
        if (text) this.emitConsole(direction, text);
      }
    });
  }

  private emitConsole(
    direction: DebugConsoleEntry["direction"],
    text: string,
  ): void {
    this.onConsole?.({ timestamp: Date.now(), direction, text });
  }

  get stopped(): DapStoppedEvent | null {
    return this.lastStopped;
  }

  get adapterStderr(): string {
    return this.stderr;
  }

  get adapterPid(): number | undefined {
    return this.child?.pid;
  }

  /**
   * Did this stop come from a breakpoint we planted? Matching ids is exact;
   * comparing the frame's source path against the editor's path is not —
   * LLDB reports the compile-time path, so a genuine hit can look foreign
   * and get resumed.
   */
  isOwnBreakpointStop(stopped: DapStoppedEvent): boolean {
    const hit = stopped.hitBreakpointIds ?? [];
    return hit.some((id) => this.ownBreakpointIds.has(id));
  }

  async threads(): Promise<DapThread[]> {
    const body = await this.client.request<{ threads?: DapThread[] }>(
      "threads",
      {},
      10_000,
    );
    return body.threads ?? [];
  }

  async stack(threadId = this.requireThread()): Promise<DapStackFrame[]> {
    const body = await this.client.request<DapStackTraceBody>("stackTrace", {
      threadId,
      startFrame: 0,
      levels: 32,
    });
    return body.stackFrames ?? [];
  }

  /**
   * Load exactly one skipped module PDB for a source-less stack frame.
   *
   * Larry's attach allowlist prevents Engine PDB discovery by default. The
   * adapter's `larry/loadModuleSymbols` request widens that list (with
   * `settings set -g`) and hydrates one module. Reloading is skipped: LLDB
   * parks every previous symbol file in `m_old_symfiles` and never frees it.
   */
  async loadSymbolsForFrame(frame: DapStackFrame): Promise<boolean> {
    if (this.protocol === "coreclr" || !this.usePdbAllowlist) return false;
    if (frameSourceFile(frame) && frame.line > 0) return false;

    const cacheKeys = [
      frame.moduleId === undefined ? "" : String(frame.moduleId).toLowerCase(),
      ...frameModuleKeys(frame),
    ].filter(Boolean);
    if (cacheKeys.some((key) => this.onDemandSymbolModules.has(key))) {
      return true;
    }

    const moduleName = frameModuleLabel(frame);
    const label = moduleName ?? `frame ${frame.id}`;
    this.emitConsole("send", `Loading symbols on demand for ${label}`);

    const body = await this.client.request<DapLoadModuleSymbolsBody>(
      "larry/loadModuleSymbols",
      {
        frameId: frame.id,
        ...(frame.moduleId === undefined
          ? {}
          : { moduleId: String(frame.moduleId) }),
        ...(moduleName ? { moduleName } : {}),
      },
      180_000,
    );

    if (body.loaded || body.alreadyLoaded) {
      for (const key of cacheKeys) this.onDemandSymbolModules.add(key);
      if (body.moduleName) {
        for (const key of moduleKeysOf(body.moduleName)) {
          this.onDemandSymbolModules.add(key);
        }
      }
      this.emitConsole(
        "receive",
        body.alreadyLoaded
          ? `Symbols already loaded for ${body.moduleName || label}`
          : `Loaded symbols for ${body.moduleName || label}${
              body.symbolFilePath ? ` (${body.symbolFilePath})` : ""
            }`,
      );
      return true;
    }

    throw new Error(
      body.symbolStatus?.trim() || `Could not load symbols for ${label}`,
    );
  }

  async scopes(frameId?: number): Promise<DapScope[]> {
    const resolvedFrameId = frameId ?? (await this.stack())[0]?.id;
    if (typeof resolvedFrameId !== "number") return [];
    const body = await this.client.request<DapScopesBody>("scopes", {
      frameId: resolvedFrameId,
    });
    return body.scopes ?? [];
  }

  /** Locals (or the first non-expensive scope) of the top frame. */
  async locals(frameId?: number): Promise<DapVariable[]> {
    const scopes = await this.scopes(frameId);
    const locals =
      scopes.find((s) => /local/i.test(s.name)) ??
      scopes.find((s) => s.variablesReference > 0);
    if (!locals || locals.variablesReference <= 0) return [];
    return this.variables(locals.variablesReference);
  }

  /** Resolve one lazy DAP variable node. Children may expose more references. */
  async variables(variablesReference: number): Promise<DapVariable[]> {
    if (!this.lastStopped) throw new Error("Process is not paused");
    if (!Number.isInteger(variablesReference) || variablesReference <= 0) {
      return [];
    }
    const body = await this.client.request<DapVariablesBody>(
      "variables",
      { variablesReference },
      10_000,
    );
    return body.variables ?? [];
  }

  /** Evaluate a source expression in a suspended stack frame for editor hover. */
  async evaluateHover(
    expression: string,
    frameId: number,
  ): Promise<DapEvaluateBody> {
    if (!this.lastStopped) {
      throw new Error("Process is not paused");
    }
    return this.client.request<DapEvaluateBody>(
      "evaluate",
      { expression, frameId, context: "hover" },
      10_000,
    );
  }

  async continue(): Promise<void> {
    const threadId = this.lastStopped?.threadId ?? (await this.firstThreadId());
    if (typeof threadId !== "number") {
      throw new Error("No stopped thread — process is not paused");
    }
    await this.client.request("continue", { threadId, singleThread: false });
    this.lastStopped = null;
  }

  /** Ask DAP to suspend the process. */
  async pauseMainThread(): Promise<void> {
    const threadId = await this.pauseThreadId();
    try {
      await this.client.request("pause", { threadId }, 10_000);
    } catch (err) {
      // lldb-dap: a concrete thread id while running is `notStopped`;
      // threadId 0 pauses every thread (Unreal e2e path).
      if (threadId !== 0 && isDapNotStopped(err)) {
        await this.client.request("pause", { threadId: 0 }, 10_000);
        return;
      }
      throw err;
    }
  }

  /**
   * Prefer GameThread / main when the adapter will list them. lldb-dap
   * refuses `threads` while running (`notStopped`) — then pause-all (0).
   */
  private async pauseThreadId(): Promise<number> {
    try {
      const threads = await this.threads();
      const thread =
        threads.find((item) =>
          /^(?:main|main thread|game\s*thread)$/i.test(item.name),
        ) ??
        threads.find((item) => /main|game\s*thread/i.test(item.name)) ??
        threads[0];
      if (thread) return thread.id;
    } catch (err) {
      if (!isDapNotStopped(err)) throw err;
    }
    return 0;
  }

  /** Resume every thread. Safe if the process is already running. */
  async resumeAll(): Promise<void> {
    await this.resumeAllThreads();
  }

  /**
   * Resume a stop the UI does not surface with a single `continue`. The whole
   * debuggee stays suspended until then, and `resumeAll` costs three round
   * trips (`process continue`, `threads`, `continue`) per stop.
   */
  async resumeFromStop(stopped: DapStoppedEvent): Promise<void> {
    if (typeof stopped.threadId === "number") {
      try {
        await this.client.request(
          "continue",
          { threadId: stopped.threadId, singleThread: false },
          10_000,
        );
        this.lastStopped = null;
        return;
      } catch {
        /* thread gone or adapter refused — fall back to the full resume */
      }
    }
    await this.resumeAllThreads();
  }

  /**
   * Poll LLDB until the process is running (or timeout). Keeps sending continue
   * — Windows attach often stays suspended after a successful DAP continue.
   */
  async ensureRunning(timeoutMs = 20_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let stoppedStreak = 0;
    while (Date.now() < deadline) {
      await this.resumeAllThreads();
      const stopped = await this.isProcessStopped();
      if (stopped === false) return true;
      if (stopped === true) {
        stoppedStreak += 1;
        // Continue succeeded in DAP but LLDB still reports stopped.
        if (stoppedStreak >= 4) return false;
      } else {
        stoppedStreak = 0;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    const stopped = await this.isProcessStopped();
    return stopped === false;
  }

  /**
   * Detach without killing the GUI. Use when attach left Unreal suspended.
   */
  async detachKeepAlive(): Promise<void> {
    try {
      await this.runLldb("process detach --keep-stopped false");
    } catch {
      /* already detached */
    }
    this.offStopped();
    try {
      await this.client.request(
        "disconnect",
        { terminateDebuggee: false },
        5_000,
      );
    } catch {
      /* adapter may already have exited */
    }
    this.client.dispose();
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
  }

  async next(): Promise<DapStoppedEvent> {
    const threadId = this.requireThread();
    const stopped = this.client.waitForEvent("stopped", { timeoutMs: 20_000 });
    await this.client.request("next", { threadId });
    return ((await stopped).body ?? {}) as DapStoppedEvent;
  }

  async stepIn(): Promise<DapStoppedEvent> {
    const threadId = this.requireThread();
    const stopped = this.client.waitForEvent("stopped", { timeoutMs: 20_000 });
    await this.client.request("stepIn", { threadId });
    return ((await stopped).body ?? {}) as DapStoppedEvent;
  }

  async stepOut(): Promise<DapStoppedEvent> {
    const threadId = this.requireThread();
    const stopped = this.client.waitForEvent("stopped", { timeoutMs: 20_000 });
    await this.client.request("stepOut", { threadId });
    return ((await stopped).body ?? {}) as DapStoppedEvent;
  }

  async setBreakpoints(breakpoints: SourceBreakpoint[]): Promise<void> {
    this.breakpointsByPath.clear();
    for (const bp of breakpoints) {
      const lines = this.breakpointsByPath.get(bp.path) ?? [];
      lines.push(
        bp.condition
          ? { line: bp.line, condition: bp.condition }
          : { line: bp.line },
      );
      this.breakpointsByPath.set(bp.path, lines);
    }
    if (this.shlibs.length > 0) {
      await this.applyShlibBreakpoints();
      return;
    }
    for (const [path, lines] of this.breakpointsByPath) {
      await this.replaceDapBreakpoints(path, lines);
    }
  }

  async replaceBreakpoints(
    path: string,
    breakpoints: LineBreakpoint[],
  ): Promise<void> {
    if (breakpoints.length === 0) this.breakpointsByPath.delete(path);
    else this.breakpointsByPath.set(path, breakpoints);
    if (this.shlibs.length > 0) {
      await this.applyShlibBreakpoints();
      return;
    }
    await this.replaceDapBreakpoints(path, breakpoints);
  }

  private async replaceDapBreakpoints(
    path: string,
    breakpoints: LineBreakpoint[],
  ): Promise<void> {
    const body = await this.client.request<DapSetBreakpointsBody>(
      "setBreakpoints",
      {
        source: { path },
        breakpoints: toDapBreakpoints(breakpoints),
      },
    );
    for (const bp of body?.breakpoints ?? []) {
      if (typeof bp.id === "number") this.ownBreakpointIds.add(bp.id);
      if (bp.verified === false) {
        this.emitConsole(
          "error",
          `Breakpoint at ${basename(path)}:${bp.line ?? "?"} did not bind`,
        );
      }
    }
  }

  private async applyShlibBreakpoints(): Promise<void> {
    await this.runLldb("breakpoint delete --force");
    this.ownBreakpointIds.clear();
    for (const [path, lines] of this.breakpointsByPath) {
      const file = basename(path);
      for (const bp of lines) {
        const result = await this.runLldb(
          buildShlibBreakpointCommand({
            file,
            line: bp.line,
            shlibs: this.shlibs,
            ...(bp.condition ? { condition: bp.condition } : {}),
          }),
        );
        const id = parseLldbBreakpointId(result);
        if (id !== null) this.ownBreakpointIds.add(id);
        if (id === null || isUnresolvedBreakpointResult(result)) {
          this.emitConsole(
            "error",
            `Breakpoint at ${file}:${bp.line} did not bind — the module may be missing from the PDB allowlist`,
          );
        }
      }
    }
  }

  /**
   * `silent` covers the resume polling loop, which repeats the same command
   * several times a second and would bury real output.
   */
  private async runLldb(
    expression: string,
    opts?: { silent?: boolean; frameId?: number },
  ): Promise<string> {
    if (!opts?.silent) this.emitConsole("send", expression);
    // NativePDB can legitimately spend over 20s resolving a large game PDB
    // when the first file:line breakpoint is planted.
    const body = await this.client.request<{ result?: string }>(
      "evaluate",
      {
        expression,
        context: "repl",
        // Commands like `target symbols add --frame` act on the selected
        // frame, so the clicked frame has to travel with the request.
        ...(typeof opts?.frameId === "number" ? { frameId: opts.frameId } : {}),
      },
      180_000,
    );
    const result = String(body?.result ?? "");
    if (opts?.silent) return result;
    for (const line of result.split(/\r?\n/)) {
      const text = line.trimEnd();
      if (text) this.emitConsole("receive", text);
    }
    return result;
  }

  async dispose(): Promise<void> {
    this.offStopped();
    try {
      await this.client.request(
        "disconnect",
        { terminateDebuggee: Boolean(this.debuggee) || this.ownsDapLaunch },
        5_000,
      );
    } catch {
      /* adapter may already have exited */
    }
    this.client.dispose();
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    if (this.debuggee && !this.debuggee.killed) {
      this.debuggee.kill();
    }
  }

  async configureAndLaunch(input: LaunchDebugSessionInput): Promise<void> {
    this.protocol = input.protocol ?? "lldb";
    this.ownsDapLaunch = !input.attachPid;
    this.usePdbAllowlist = input.usePdbAllowlist !== false;
    this.shlibs = input.shlibs?.filter((name) => name.trim()) ?? [];
    this.onConsole = input.onConsole;
    this.pipeOutputEvents();
    await this.client.request<DapInitializeBody>("initialize", {
      clientID: "larry-agent",
      clientName: "Larry Agent",
      adapterID: this.protocol === "coreclr" ? "coreclr" : "lldb-dap",
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
      supportsVariableType: true,
    });

    let modules = 0;
    const seenModules = new Set<string>();
    this.client.onAnyEvent((ev) => {
      if (!input.onProgress) return;
      if (ev.event === "module") {
        const body = ev.body as
          | {
              reason?: string;
              module?: { id?: string | number; path?: string; name?: string };
            }
          | undefined;
        if (body?.reason === "removed") return;
        const key = String(
          body?.module?.path || body?.module?.id || body?.module?.name || "",
        );
        if (key) {
          if (seenModules.has(key)) return;
          seenModules.add(key);
        }
        modules += 1;
        input.onProgress(`Discovering modules (${modules})…`);
      }
    });

    // lldb-dap emits `initialized` after attach/launch starts.
    // Unreal PDB load can take several minutes.
    const initialized = this.client.waitForEvent("initialized", {
      timeoutMs: INITIALIZED_TIMEOUT_MS,
    });
    const startCommand = input.attachPid ? "attach" : "launch";
    const startArgs = this.startArguments(input);
    const launchDone = this.client.request(
      startCommand,
      startArgs,
      START_REQUEST_TIMEOUT_MS,
    );
    launchDone.catch(() => undefined);
    await initialized;

    // Attach freezes every Windows thread. Do not plant breakpoints here —
    // PDB work while suspended leaves Unreal stuck after "Debugger attached".
    // Custom attachCommands (without DAP pid) also lied about "running".
    const attachWithoutStopping =
      Boolean(input.attachPid) && input.waitForStop === false;
    if (!attachWithoutStopping) {
      await this.setBreakpoints(input.breakpoints);
    }
    const paused =
      input.waitForStop === false
        ? null
        : this.waitUntilPaused(input.stopTimeoutMs ?? 30_000);
    try {
      await this.client.request("configurationDone", {}, CONFIGURATION_DONE_TIMEOUT_MS);
      await launchDone;
      // UI sessions: LLDB always stops at entry, then configurationDone
      // Continue()s. On Windows that resume often never reaches the
      // debuggee — Unreal stays thread-suspended with no Editor window.
      if (input.waitForStop === false && this.protocol !== "coreclr") {
        await this.resumeFromEntry(attachWithoutStopping);
        if (attachWithoutStopping) {
          input.onProgress?.("Resuming Unreal…");
          const running = await this.ensureRunning(20_000);
          if (!running) {
            try {
              await this.runLldb("process detach --keep-stopped false");
            } catch {
              /* best-effort unfreeze */
            }
            throw new Error(
              "Debugger attached but Unreal stayed suspended — detached to unfreeze the editor",
            );
          }
        }
      }
    } catch (err) {
      const launchErr = await Promise.race([
        launchDone.then(
          () => null,
          (failed: unknown) => failed,
        ),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_500)),
      ]);
      if (
        launchErr instanceof Error &&
        launchErr.message !== (err instanceof Error ? err.message : String(err))
      ) {
        throw new Error(
          `${err instanceof Error ? err.message : String(err)}\n${launchErr.message}`,
        );
      }
      throw err;
    }
    if (paused) await paused;
  }

  private startArguments(
    input: LaunchDebugSessionInput,
  ): Record<string, unknown> {
    if (input.protocol === "coreclr") return {
      name: "Larry Agent", program: input.program, cwd: input.cwd ?? dirname(input.program), args: input.args ?? [],
      stopAtEntry: false, justMyCode: false, console: "internalConsole",
    };
    if (input.attachPid) {
      // Standard DAP attach — custom attachCommands left Windows suspended
      // while LLDB reported success.
      return lldbAttachArguments({
        attachPid: input.attachPid,
        ...(input.pdbModuleAllowlist ? { pdbModuleAllowlist: input.pdbModuleAllowlist } : {}),
        ...(input.usePdbAllowlist === false ? { usePdbAllowlist: false } : {}),
      });
    }
    return {
      name: "Larry Agent",
      program: input.program,
      args: input.args ?? [],
      cwd: input.cwd ?? dirname(input.program),
      stopOnEntry: false,
      console: "internalConsole",
      disableSTDIO: false,
      timeout: LLDB_PROCESS_TIMEOUT_SEC,
      initCommands: lldbInitCommands(),
    };
  }

  /**
   * Kick the debuggee out of the post-launch / post-attach stop.
   * Windows often reports the loader break as `breakpoint` *with* ids;
   * attach must still continue or Unreal stays frozen after "attached".
   */
  private async resumeFromEntry(force = false): Promise<void> {
    if (!force && (this.lastStopped?.hitBreakpointIds?.length ?? 0) > 0) {
      return;
    }
    await this.resumeAllThreads();
  }

  private async resumeAllThreads(): Promise<void> {
    this.lastStopped = null;
    try {
      if (this.protocol !== "coreclr") await this.runLldb("process continue", { silent: true });
    } catch {
      /* already running, or evaluate unsupported */
    }
    try {
      const threadId = await this.firstThreadId();
      if (typeof threadId !== "number") return;
      await this.client.request(
        "continue",
        { threadId, singleThread: false },
        10_000,
      );
    } catch {
      /* already running, or adapter closed */
    }
  }

  private async isProcessStopped(): Promise<boolean | null> {
    try {
      const body = await this.client.request<{ result?: string }>(
        "evaluate",
        { expression: "process status", context: "repl" },
        5_000,
      );
      const text = String(body.result ?? "");
      if (/state\s*=\s*stopped/i.test(text) || /\bstopped\b/i.test(text)) {
        return true;
      }
      if (/state\s*=\s*running/i.test(text) || /\brunning\b/i.test(text)) {
        return false;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async firstThreadId(): Promise<number | undefined> {
    const body = await this.client.request<{ threads?: Array<{ id: number }> }>(
      "threads",
      {},
      10_000,
    );
    return body.threads?.[0]?.id;
  }

  private waitUntilPaused(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for breakpoint"));
      }, timeoutMs);
      const offStop = this.client.onEvent("stopped", () => {
        cleanup();
        resolve();
      });
      const fail = (): void => {
        cleanup();
        reject(new Error("Debuggee exited before hitting a breakpoint"));
      };
      const offTerm = this.client.onEvent("terminated", fail);
      const offExit = this.client.onEvent("exited", fail);
      const cleanup = (): void => {
        clearTimeout(timer);
        offStop();
        offTerm();
        offExit();
      };
    });
  }

  private requireThread(): number {
    const id = this.lastStopped?.threadId;
    if (typeof id !== "number") {
      throw new Error("No stopped thread — process is not paused");
    }
    return id;
  }
}

function spawnAdapter(
  adapterPath: string,
  args: string[] = [],
): ChildProcessWithoutNullStreams {
  const binDir = dirname(adapterPath);
  const pathEnv = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  return spawn(adapterPath, args, {
    cwd: binDir,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      PATH: pathEnv,
      LLDB_USE_NATIVE_PDB_READER: "1",
    },
  });
}
