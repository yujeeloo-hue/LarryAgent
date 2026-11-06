import { existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { basename, dirname } from "node:path";
import type { WebContents } from "electron";
import {
  awaitDevTaskRun,
  getDevTaskState,
  runDevTask,
  stopDevTask,
} from "../main/devTasks.js";
import { resolveUnrealLaunchContext } from "../unreal/launchContext.js";
import type { UnrealLaunchContext } from "../unreal/launchContext.js";
import { listGameEditorShlibs } from "../unreal/gameModules.js";
import { findSourceNewerThan } from "../unreal/buildStaleness.js";
import { ubtFailureHint } from "../unreal/ubtLog.js";
import { resolveElectronLaunchContext } from "../electron/launchContext.js";
import type { ElectronLaunchContext } from "../electron/launchContext.js";
import { electronSpawnPlan } from "../electron/recipes.js";
import { breakpointLane } from "../electron/breakpointLane.js";
import { resolveWebLaunchContext } from "../web/launchContext.js";
import type { WebLaunchContext } from "../web/launchContext.js";
import { chromeSpawnPlan, webServerSpawnPlan } from "../web/recipes.js";
import { webBreakpointLane } from "../web/breakpointLane.js";
import {
  parseAddressInUsePort,
  parseDevServerUrl,
  toChromePageUrl,
  waitForDevServerUrl,
} from "../web/devServerUrl.js";
import { isCdpRecipe, type DebugRecipe } from "./debugCopy.js";
import type { DebugAdapterProbe } from "./adapterProbe.js";
import {
  DebugSession,
  type DebugConsoleEntry,
  type LineBreakpoint,
  type SourceBreakpoint,
} from "./dapSession.js";
import { ElectronCdpSession } from "./electronCdpSession.js";
import {
  fetchCdpTargets,
  isBenignDebuggeeStderr,
  parseNodeInspectorWebSocketUrl,
  pageSessionLabel,
  rendererSessionLabel,
  shouldAttachPage,
  waitForNodeInspector,
  type CdpTargetInfo,
} from "./cdpDiscover.js";
import { shouldStealDebugFocus } from "./debugFocus.js";
import {
  pidsListeningOnPort,
  terminateLaunchedProcess,
} from "./killProcessTree.js";
import {
  httpUrlsForListenPorts,
  listenTcpPortsForProcessTree,
} from "./listenPorts.js";
import { allocateInspectPorts } from "./ports.js";
import {
  focusProcessMainWindow,
  waitForProcessMainWindow,
} from "./waitForMainWindow.js";
import type {
  DapStackFrame,
  DapStoppedEvent,
  DapThread,
  DapVariable,
} from "./dapTypes.js";

export type { DebugRecipe };

export type DebugRuntimeStatus =
  | "idle"
  | "building"
  | "starting"
  | "running"
  | "stopped"
  | "error";

export type DebugTargetKind = "lldb" | "node" | "chrome";

export type DebugTarget = {
  id: string;
  kind: DebugTargetKind;
  label: string;
  status: "starting" | "running" | "stopped" | "ended";
  stoppedReason?: string;
  threadCount?: number;
};

export type DebugSnapshot = {
  workspacePath: string;
  status: DebugRuntimeStatus;
  recipe?: DebugRecipe;
  adapterPath?: string;
  adapterVersion?: string;
  pdbModuleAllowlist?: string[];
  program?: string;
  stopped?: DapStoppedEvent;
  threads?: DapThread[];
  selectedThreadId?: number;
  /** Stack frame whose locals are in `locals` (defaults to the top frame). */
  selectedFrameId?: number;
  stack: DapStackFrame[];
  locals: DapVariable[];
  error?: string;
  progressText?: string;
  /** Bounded debug target / debugger output shown by the Debug Console. */
  console?: DebugConsoleEntry[];
  targets?: DebugTarget[];
  selectedTargetId?: string;
};

export type DebugStartRequest = {
  workspacePath: string;
  breakpoints: SourceBreakpoint[];
  /** Compile DebugGame Editor first when the build gate is closed (default). */
  autoBuild?: boolean;
};

export type DebugOutputEvent = {
  workspacePath: string;
  /** Coalesced rows — one IPC message per flush, not per output line. */
  entries: DebugConsoleEntry[];
};

export type DebugStartResult =
  | { ok: true; snapshot: DebugSnapshot }
  | { ok: false; message: string; cancelled?: true };

export type DebugEvaluateResult =
  | {
      ok: true;
      result: string;
      type?: string;
      variablesReference: number;
    }
  | { ok: false; message: string };

export type DebugVariablesResult =
  | { ok: true; variables: DapVariable[] }
  | { ok: false; message: string };

export type DebugCommand =
  | "pause"
  | "continue"
  | "next"
  | "stepIn"
  | "stepOut"
  | "stop";

export type ResolveDebugAdapter = (
  owner: WebContents,
) => Promise<DebugAdapterProbe | null>;

export type DebugStoppedHandler = (owner: WebContents) => void;

type ElectronTargetSlot = {
  id: string;
  kind: "node" | "chrome";
  label: string;
  status: "starting" | "running" | "stopped" | "ended";
  runtime: ElectronCdpSession;
  offStopped: () => void;
  offResumed: () => void;
  offEnded: () => void;
  offConsole: () => void;
  stopped?: DapStoppedEvent;
};

type Active = {
  owner: WebContents;
  recipe: DebugRecipe;
  session: DebugSession | null;
  snapshot: DebugSnapshot;
  debuggee?: ReturnType<typeof spawn>;
  chromeDebuggee?: ReturnType<typeof spawn>;
  offStopped: () => void;
  offTerminated: () => void;
  offExited: () => void;
  /** File breakpoints toggled while the adapter is still attaching. */
  pendingBreakpoints: Map<string, LineBreakpoint[]>;
  /** Console rows waiting for the next flush. */
  consoleQueue: DebugConsoleEntry[];
  consoleFlush: ReturnType<typeof setTimeout> | null;
  projectRoot?: string;
  inspectPort?: number;
  remoteDebugPort?: number;
  targets: Map<string, ElectronTargetSlot>;
  selectedTargetId: string | null;
  rendererPoll: ReturnType<typeof setInterval> | null;
  seenRendererIds: Set<string>;
  discoveredInspectUrl?: string;
  discoveredPageUrl?: string;
  /** Server port from an EADDRINUSE crash line — aborts the web wait. */
  portInUse?: number;
};

const MAX_CONSOLE_ENTRIES = 3_000;
/** Coalescing window for Debug Console rows. */
const CONSOLE_FLUSH_MS = 120;

function killPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 8_000,
    });
  } catch {
    /* already gone */
  }
}

function groupBreakpoints(
  breakpoints: SourceBreakpoint[],
): Array<[string, LineBreakpoint[]]> {
  const map = new Map<string, LineBreakpoint[]>();
  for (const bp of breakpoints) {
    const lines = map.get(bp.path) ?? [];
    lines.push(
      bp.condition
        ? { line: bp.line, condition: bp.condition }
        : { line: bp.line },
    );
    map.set(bp.path, lines);
  }
  return [...map];
}

/** Brief pause after the editor frame exists so the first Slate tick can finish. */
const ATTACH_SETTLE_MS = 2_000;

function findRunningImagePid(imageName: string): number | null {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync(
      "tasklist",
      ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"],
      { encoding: "utf8", windowsHide: true, timeout: 5_000 },
    ).trim();
    if (!out || /^INFO:/i.test(out)) return null;
    const first = out.split(/\r?\n/)[0] ?? "";
    const match = /^"[^"]+","(\d+)"/.exec(first);
    const pid = match?.[1] ? Number(match[1]) : NaN;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export class DebugSessionManager {
  private readonly sessions = new Map<number, Active>();
  /** webContents.id → Build runId awaited by a pending Debug start. */
  private readonly builds = new Map<number, string>();
  /** Debug starts in flight — a second click must not cancel the first build. */
  private readonly starting = new Set<number>();
  /** webContents.id → attach generation; Stop bumps this to drop in-flight attach. */
  private readonly attachEpoch = new Map<number, number>();
  private readonly attaching = new Set<number>();

  constructor(
    private readonly resolveDebugAdapter: ResolveDebugAdapter,
    private readonly onStopped?: DebugStoppedHandler,
  ) {}

  state(owner: WebContents): DebugSnapshot {
    return (
      this.sessions.get(owner.id)?.snapshot ?? {
        workspacePath: "",
        status: "idle",
        stack: [],
        locals: [],
      }
    );
  }

  async start(
    owner: WebContents,
    request: DebugStartRequest,
  ): Promise<DebugStartResult> {
    const workspacePath = request.workspacePath.trim();
    if (!workspacePath) return { ok: false, message: "workspacePath is required" };
    if (this.starting.has(owner.id) || this.attaching.has(owner.id)) {
      return { ok: false, message: "Debug is already starting" };
    }
    this.starting.add(owner.id);
    try {
      return await this.startInner(owner, workspacePath, request);
    } finally {
      this.starting.delete(owner.id);
      this.builds.delete(owner.id);
    }
  }

  private async startInner(
    owner: WebContents,
    workspacePath: string,
    request: DebugStartRequest,
  ): Promise<DebugStartResult> {
    await this.stop(owner);

    const ue = await resolveUnrealLaunchContext(workspacePath);
    if (ue.ok) {
      return this.startUnreal(owner, workspacePath, request, ue.context);
    }
    if (ue.code !== "not_unreal") {
      return { ok: false, message: ue.message };
    }
    const electron = await resolveElectronLaunchContext(workspacePath);
    if (electron.ok) {
      return this.startElectron(owner, workspacePath, request, electron.context);
    }
    if (electron.code !== "not_electron") {
      return { ok: false, message: electron.message };
    }
    const web = await resolveWebLaunchContext(workspacePath);
    if (web.ok) {
      return this.startWeb(owner, workspacePath, request, web.context);
    }
    if (web.code !== "not_web") {
      return { ok: false, message: web.message };
    }
    return {
      ok: false,
      message:
        "No Unreal (.uproject), Electron, or Node web app found in this workspace",
    };
  }

  private async startUnreal(
    owner: WebContents,
    workspacePath: string,
    request: DebugStartRequest,
    context: UnrealLaunchContext,
  ): Promise<DebugStartResult> {
    // Resolve project/engine before building: these fail in milliseconds,
    // and a full DebugGame Editor compile is measured in tens of minutes.
    // editorExe is checked after the build produces it.
    const base: DebugSnapshot = {
      workspacePath,
      recipe: "unreal",
      status: "building",
      program: context.editorExe,
      progressText: "DebugGame Editor · see the Build tab",
      stack: [],
      locals: [],
    };

    const selecting: DebugSnapshot = {
      ...base,
      status: "starting",
      progressText: "Checking lldb-dap…",
    };
    this.emit(owner, selecting);
    const adapter = await this.resolveDebugAdapter(owner);
    if (!adapter) {
      this.emit(owner, { ...selecting, status: "idle" });
      return {
        ok: false,
        cancelled: true,
        message: "lldb-dap selection cancelled",
      };
    }
    if (!adapter.ok) {
      this.emit(owner, {
        ...selecting,
        status: "error",
        error: adapter.message,
      });
      return { ok: false, message: adapter.message };
    }

    const built = await this.ensureBuild(owner, workspacePath, base, request);
    if (!built.ok) {
      this.emit(owner, {
        ...base,
        status: built.cancelled ? "idle" : "error",
        ...(built.cancelled ? {} : { error: built.message }),
      });
      return built;
    }

    if (!existsSync(context.editorExe)) {
      const message = `Unreal Editor executable not found: ${context.editorExe}`;
      this.emit(owner, { ...base, status: "error", error: message });
      return { ok: false, message };
    }

    const starting: DebugSnapshot = { ...base, status: "starting" };
    this.emit(owner, starting);

    let debuggee: ReturnType<typeof spawn> | undefined;
    const spawnEditor = async (): Promise<number> => {
      // -WaitForAttachNoBreak parks the editor in Launch.cpp's pre-init
      // IsDebuggerPresent loop (non-shipping builds): attach lands before
      // D3D / Slate / game modules exist, with no window or log probing.
      debuggee = spawn(
        context.editorExe,
        [context.uproject, "-skipcompile", "-WaitForAttachNoBreak"],
        {
          cwd: dirname(context.editorExe),
          stdio: "ignore",
          windowsHide: false,
        },
      );
      if (!debuggee.pid) {
        debuggee.kill();
        throw new Error("Failed to start Unreal Editor");
      }
      await new Promise((r) => setTimeout(r, 1_500));
      if (debuggee.exitCode != null) {
        throw new Error("Unreal Editor exited immediately");
      }
      return debuggee.pid;
    };
    try {
      const existingPid = findRunningImagePid(basename(context.editorExe));
      let pid: number;
      if (existingPid) {
        const existing = await waitForProcessMainWindow({
          pid: existingPid,
          timeoutMs: 15_000,
        });
        if (existing === "ready") {
          pid = existingPid;
        } else {
          // Splash / 0% initializing instance — Unreal's single-instance
          // lock would reuse it and freeze again. Kill, then spawn fresh.
          if (existing !== "exited") killPid(existingPid);
          pid = await spawnEditor();
        }
      } else {
        pid = await spawnEditor();
      }
      const shlibs = listGameEditorShlibs(context.projectRoot, {
        sourcePaths: request.breakpoints.map((breakpoint) => breakpoint.path),
      });
      const snapshot: DebugSnapshot = {
        ...starting,
        status: "running",
        adapterPath: adapter.path,
        ...(adapter.version
          ? { adapterVersion: adapter.version }
          : {}),
        pdbModuleAllowlist: shlibs,
        progressText:
          shlibs.length > 0
            ? `Editor running · attaching debugger (${shlibs.length} game modules)…`
            : "Editor running · attaching debugger (no game DLLs found)…",
        console: [
          {
            timestamp: Date.now(),
            direction: "receive",
            text: `Unreal process ${pid} ready; adapter ${
              adapter.path
            }${adapter.version ? ` (${adapter.version})` : ""}`,
          },
          {
            timestamp: Date.now(),
            direction: "receive" as const,
            text: `PDB module allowlist: ${shlibs.length} module(s)`,
          },
          ...shlibs.map((name) => ({
            timestamp: Date.now(),
            direction: "receive" as const,
            text: `Symbol status: ${name} — PDB allowed`,
          })),
        ],
      };
      const active: Active = {
        owner,
        recipe: "unreal",
        session: null,
        snapshot,
        ...(debuggee ? { debuggee } : {}),
        offStopped: () => undefined,
        offTerminated: () => undefined,
        offExited: () => undefined,
        pendingBreakpoints: new Map(),
        consoleQueue: [],
        consoleFlush: null,
        targets: new Map(),
        selectedTargetId: null,
        rendererPoll: null,
        seenRendererIds: new Set(),
      };
      this.sessions.set(owner.id, active);
      owner.once("destroyed", () => {
        if (this.sessions.get(owner.id) !== active) return;
        this.sessions.delete(owner.id);
        this.unsubscribe(active);
        void this.disposeActive(active, true);
      });
      if (debuggee) {
        debuggee.once("exit", () => {
          if (this.sessions.get(owner.id) !== active) return;
          void this.finish(active);
        });
      }
      this.emit(owner, snapshot);
      const epoch = this.attachEpoch.get(owner.id) ?? 0;
      this.attaching.add(owner.id);
      void this.attachLldb(owner, active, {
        adapterPath: adapter.path,
        program: context.editorExe,
        breakpoints: request.breakpoints,
        attachPid: pid,
        shlibs,
        epoch,
        waitingForAttach: Boolean(debuggee),
      }).finally(() => this.attaching.delete(owner.id));
      return { ok: true, snapshot };
    } catch (err) {
      debuggee?.kill();
      const message = err instanceof Error ? err.message : String(err);
      this.emit(owner, {
        ...starting,
        status: "error",
        error: message,
      });
      return { ok: false, message };
    }
  }

  /**
   * Close the build gate by compiling DebugGame Editor. A Build the user
   * already kicked off is adopted (its log keeps streaming to the Build tab)
   * instead of being duplicated. "Gate ok" alone is not enough: it only
   * means a Build finished successfully this session, so sources edited
   * since that build reopen the gate (mtime scan) before launching.
   */
  private async ensureBuild(
    owner: WebContents,
    workspacePath: string,
    base: DebugSnapshot,
    request: DebugStartRequest,
  ): Promise<{ ok: true } | { ok: false; message: string; cancelled?: true }> {
    const state = getDevTaskState(workspacePath);
    let gateClosed = !state.buildGate.ok;
    if (!gateClosed && state.last.build) {
      const staleness = await findSourceNewerThan(
        workspacePath,
        state.last.build.startedAt,
      );
      if (staleness.stale) gateClosed = true;
    }
    if (!gateClosed) return { ok: true };
    if (request.autoBuild === false) {
      return {
        ok: false,
        message: state.buildGate.ok
          ? "Sources changed since the last build — run Build (DebugGame Editor) first"
          : state.buildGate.message,
      };
    }

    let runId = state.active.find((run) => run.task === "build")?.runId;
    if (!runId) {
      const started = await runDevTask(owner, workspacePath, "build");
      if (!started.ok) return { ok: false, message: started.message };
      runId = started.runId;
    }
    this.builds.set(owner.id, runId);
    this.emit(owner, base);

    const snapshot = await awaitDevTaskRun(runId);
    this.builds.delete(owner.id);
    if (!snapshot) return { ok: false, message: "Build run is no longer tracked" };
    if (snapshot.status === "cancelled") {
      return { ok: false, message: "Build cancelled", cancelled: true };
    }
    if (snapshot.status !== "done" || snapshot.exitCode !== 0) {
      return {
        ok: false,
        message:
          ubtFailureHint(snapshot.buffer) ?? `Build ended as "${snapshot.status}"`,
      };
    }
    return { ok: true };
  }

  /**
   * Adopted (already running) editor: wait for the real editor frame, then
   * settle. Returns false when the attach should not proceed (snapshot
   * already updated).
   */
  private async waitForEditorReady(
    owner: WebContents,
    active: Active,
    pid: number,
    stale: () => boolean,
  ): Promise<boolean> {
    const abort = new AbortController();
    const watch = setInterval(() => {
      if (stale()) abort.abort();
    }, 250);
    let windowWait: Awaited<ReturnType<typeof waitForProcessMainWindow>> =
      "ready";
    try {
      active.snapshot = {
        ...active.snapshot,
        status: "running",
        progressText: "Waiting for Unreal Editor to finish initializing…",
      };
      this.emit(owner, active.snapshot);
      windowWait = await waitForProcessMainWindow({
        pid,
        timeoutMs: null,
        signal: abort.signal,
      });
    } finally {
      clearInterval(watch);
    }
    if (stale() || windowWait === "cancelled") return false;
    if (windowWait === "exited") {
      active.snapshot = {
        ...active.snapshot,
        status: "error",
        error: "Unreal Editor exited before initializing finished",
      };
      this.emit(owner, active.snapshot);
      return false;
    }
    if (windowWait !== "ready") {
      active.snapshot = {
        ...active.snapshot,
        status: "running",
        progressText: "Editor still initializing · debugger not attached",
      };
      this.emit(owner, active.snapshot);
      return false;
    }
    active.snapshot = {
      ...active.snapshot,
      status: "running",
      progressText: "Editor ready · attaching debugger…",
    };
    this.appendConsole(active, {
      timestamp: Date.now(),
      direction: "send",
      text: `Attaching lldb-dap to Unreal PID ${pid}`,
    });
    this.emit(owner, active.snapshot);
    const settleUntil = Date.now() + ATTACH_SETTLE_MS;
    while (Date.now() < settleUntil) {
      if (stale()) return false;
      await new Promise((r) => setTimeout(r, 400));
    }
    return true;
  }

  private async attachLldb(
    owner: WebContents,
    active: Active,
    input: {
      adapterPath: string;
      program: string;
      breakpoints: SourceBreakpoint[];
      attachPid: number;
      shlibs: string[];
      epoch: number;
      /** Editor was spawned with -WaitForAttachNoBreak and is parked pre-init. */
      waitingForAttach: boolean;
    },
  ): Promise<void> {
    const stale = (): boolean =>
      (this.attachEpoch.get(owner.id) ?? 0) !== input.epoch ||
      this.sessions.get(owner.id) !== active;
    try {
      if (input.waitingForAttach) {
        this.appendConsole(active, {
          timestamp: Date.now(),
          direction: "send",
          text: `Attaching lldb-dap to Unreal PID ${input.attachPid} (parked by -WaitForAttachNoBreak)`,
        });
      } else if (!(await this.waitForEditorReady(owner, active, input.attachPid, stale))) {
        return;
      }
      if (stale()) return;
      active.snapshot = {
        ...active.snapshot,
        status: "running",
        progressText: input.waitingForAttach
          ? "Editor waiting for debugger · attaching…"
          : "Editor ready · attaching debugger…",
      };
      this.emit(owner, active.snapshot);

      let lastProgress = 0;
      const session = await DebugSession.launch({
        adapterPath: input.adapterPath,
        program: input.program,
        // Plant breakpoints only after the process is confirmed running.
        breakpoints: [],
        waitForStop: false,
        attachPid: input.attachPid,
        ...(input.shlibs.length > 0 ? { shlibs: input.shlibs } : {}),
        pdbModuleAllowlist: input.shlibs,
        onProgress: (text) => {
          if ((this.attachEpoch.get(owner.id) ?? 0) !== input.epoch) return;
          if (this.sessions.get(owner.id) !== active) return;
          const now = Date.now();
          if (now - lastProgress < 400) return;
          lastProgress = now;
          active.snapshot = { ...active.snapshot, status: "running", progressText: text };
          this.emit(owner, active.snapshot);
        },
        onConsole: (entry) => this.appendConsole(active, entry),
      });
      if ((this.attachEpoch.get(owner.id) ?? 0) !== input.epoch) {
        await session.dispose();
        return;
      }
      if (this.sessions.get(owner.id) !== active) {
        await session.dispose();
        return;
      }
      active.session = session;

      const toApply = new Map<string, LineBreakpoint[]>();
      for (const bp of input.breakpoints) {
        const lines = toApply.get(bp.path) ?? [];
        lines.push(
          bp.condition
            ? { line: bp.line, condition: bp.condition }
            : { line: bp.line },
        );
        toApply.set(bp.path, lines);
      }
      for (const [path, breakpoints] of active.pendingBreakpoints) {
        toApply.set(path, breakpoints);
      }
      active.pendingBreakpoints.clear();

      if (toApply.size > 0) {
        active.snapshot = {
          ...active.snapshot,
          status: "running",
          progressText: "Debugger attached · applying breakpoints…",
        };
        this.emit(owner, active.snapshot);
        try {
          for (const [path, breakpoints] of toApply) {
            await session.replaceBreakpoints(path, breakpoints);
          }
        } catch {
          /* live toggles retry on next edit */
        }
        const stillRunning = await session.ensureRunning(15_000);
        if (!stillRunning) {
          await session.detachKeepAlive();
          active.session = null;
          active.snapshot = {
            ...active.snapshot,
            status: "running",
            progressText:
              "Editor running · debugger detached (breakpoints left Unreal suspended)",
          };
          this.emit(owner, active.snapshot);
          return;
        }
      }

      try {
        await session.resumeAll();
      } catch {
        /* already running */
      }
      active.snapshot = {
        ...active.snapshot,
        status: "running",
        adapterPath: input.adapterPath,
        pdbModuleAllowlist: input.shlibs,
        progressText:
          input.shlibs.length > 0
            ? `Debugger attached · ${input.shlibs.length} game modules`
            : "Debugger attached",
      };
      // Unreal trips internal stops while it finishes booting; those get
      // resumed. A breakpoint we planted is always surfaced, whenever it hits.
      // A parked editor boots entirely under the debugger (34s+ for NF
      // without one), so its grace window must cover the whole startup.
      const graceUntil =
        Date.now() + (input.waitingForAttach ? 300_000 : 45_000);
      active.offStopped = session.client.onEvent("stopped", (ev) => {
        const body = (ev.body ?? {}) as DapStoppedEvent;
        if (body.reason === "entry" || body.reason === "attach") {
          void session.resumeAll();
          return;
        }
        void (async () => {
          if (
            body.reason !== "pause" &&
            !session.isOwnBreakpointStop(body) &&
            Date.now() < graceUntil
          ) {
            await session.resumeAll();
            return;
          }
          // Focus Larry Agent before waiting on stack/variable DAP round trips.
          try {
            this.onStopped?.(owner);
          } catch {
            // Window activation is best-effort and must never block debugging.
          }
          await this.refreshStopped(active, body);
        })();
      });
      const ended = (): void => {
        void this.finish(active);
      };
      active.offTerminated = session.client.onEvent("terminated", ended);
      active.offExited = session.client.onEvent("exited", ended);
      this.emit(owner, active.snapshot);
      // Attach is complete and LLDB has resumed the process. Return focus to
      // the target application so starting Debug does not leave Larry Agent
      // covering the editor. Best-effort only: focus policy must never turn a
      // successful debug attach into a failure. A parked editor has no window
      // to focus yet.
      if (input.waitingForAttach) return;
      void focusProcessMainWindow(input.attachPid).then((focused) => {
        this.appendConsole(active, {
          timestamp: Date.now(),
          direction: focused ? "receive" : "error",
          text: focused
            ? `Activated target window for PID ${input.attachPid}`
            : `Debugger attached, but target window could not be activated (PID ${input.attachPid})`,
        });
      });
    } catch (err) {
      if ((this.attachEpoch.get(owner.id) ?? 0) !== input.epoch) return;
      if (this.sessions.get(owner.id) !== active) return;
      const message = err instanceof Error ? err.message : String(err);
      this.appendConsole(active, {
        timestamp: Date.now(),
        direction: "error",
        text: message,
      });
      active.snapshot = {
        ...active.snapshot,
        status: "running",
        progressText: `Editor running · debugger not attached — ${message}`,
      };
      this.emit(owner, active.snapshot);
    }
  }

  private async startElectron(
    owner: WebContents,
    workspacePath: string,
    request: DebugStartRequest,
    context: ElectronLaunchContext,
  ): Promise<DebugStartResult> {
    const { inspectPort, remoteDebugPort } = await allocateInspectPorts();
    const plan = electronSpawnPlan(context, { inspectPort, remoteDebugPort });
    const starting: DebugSnapshot = {
      workspacePath,
      recipe: "electron",
      status: "starting",
      program: plan.executable,
      progressText: "Launching Electron…",
      stack: [],
      locals: [],
      targets: [],
    };
    this.emit(owner, starting);

    let debuggee: ReturnType<typeof spawn> | undefined;
    try {
      debuggee = spawn(plan.executable, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
        shell: plan.shell,
        detached: process.platform !== "win32",
      });
      if (!debuggee.pid) {
        debuggee.kill();
        throw new Error("Failed to start Electron");
      }
      const snapshot: DebugSnapshot = {
        ...starting,
        status: "running",
        progressText: `Electron starting · inspector ${inspectPort}`,
        console: [
          {
            timestamp: Date.now(),
            direction: "receive",
            text: `Spawned ${plan.executable} (pid ${debuggee.pid})`,
          },
          {
            timestamp: Date.now(),
            direction: "receive",
            text: "Isolated debug profile — a second window can open beside this one",
          },
        ],
      };
      const active: Active = {
        owner,
        recipe: "electron",
        session: null,
        snapshot,
        debuggee,
        offStopped: () => undefined,
        offTerminated: () => undefined,
        offExited: () => undefined,
        pendingBreakpoints: new Map(
          groupBreakpoints(request.breakpoints).map(([path, lines]) => [path, lines]),
        ),
        consoleQueue: [],
        consoleFlush: null,
        projectRoot: context.projectRoot,
        inspectPort,
        remoteDebugPort,
        targets: new Map(),
        selectedTargetId: null,
        rendererPoll: null,
        seenRendererIds: new Set(),
      };
      this.sessions.set(owner.id, active);
      owner.once("destroyed", () => {
        if (this.sessions.get(owner.id) !== active) return;
        this.sessions.delete(owner.id);
        this.unsubscribe(active);
        void this.disposeActive(active, true);
      });
      debuggee.once("error", (err) => {
        if (this.sessions.get(owner.id) !== active) return;
        const message = err instanceof Error ? err.message : String(err);
        this.appendConsole(active, {
          timestamp: Date.now(),
          direction: "error",
          text: message,
        });
        active.snapshot = {
          ...active.snapshot,
          status: "error",
          error: message,
          progressText: `Failed to start Electron — ${message}`,
        };
        this.emit(owner, active.snapshot);
      });
      debuggee.once("exit", () => {
        if (this.sessions.get(owner.id) !== active) return;
        void this.finish(active, {
          keepError: active.snapshot.status === "error",
        });
      });
      const pipe = (
        stream: NodeJS.ReadableStream | null,
        streamKind: "stdout" | "stderr",
      ): void => {
        stream?.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8").trimEnd();
          if (!text) return;
          const inspect = parseNodeInspectorWebSocketUrl(text);
          if (inspect) active.discoveredInspectUrl = inspect;
          const direction =
            streamKind === "stderr" && !isBenignDebuggeeStderr(text)
              ? "error"
              : "receive";
          this.appendConsole(active, { timestamp: Date.now(), direction, text });
        });
      };
      pipe(debuggee.stdout, "stdout");
      pipe(debuggee.stderr, "stderr");
      this.emit(owner, snapshot);

      const epoch = this.attachEpoch.get(owner.id) ?? 0;
      this.attaching.add(owner.id);
      void this.attachElectron(owner, active, {
        inspectPort,
        remoteDebugPort,
        projectRoot: context.projectRoot,
        epoch,
      }).finally(() => this.attaching.delete(owner.id));
      return { ok: true, snapshot };
    } catch (err) {
      debuggee?.kill();
      const message = err instanceof Error ? err.message : String(err);
      this.emit(owner, { ...starting, status: "error", error: message });
      return { ok: false, message };
    }
  }

  private async startWeb(
    owner: WebContents,
    workspacePath: string,
    request: DebugStartRequest,
    context: WebLaunchContext,
  ): Promise<DebugStartResult> {
    const { inspectPort, remoteDebugPort } = await allocateInspectPorts();
    const plan = webServerSpawnPlan(context, { inspectPort, remoteDebugPort });
    const starting: DebugSnapshot = {
      workspacePath,
      recipe: "web",
      status: "starting",
      program: plan.executable,
      progressText: "Launching web app…",
      stack: [],
      locals: [],
      targets: [],
    };
    this.emit(owner, starting);

    let debuggee: ReturnType<typeof spawn> | undefined;
    try {
      debuggee = spawn(plan.executable, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
        shell: plan.shell,
        detached: process.platform !== "win32",
      });
      if (!debuggee.pid) {
        debuggee.kill();
        throw new Error("Failed to start the web server");
      }
      const snapshot: DebugSnapshot = {
        ...starting,
        status: "running",
        progressText: `Server starting · inspector ${inspectPort}`,
        console: [
          {
            timestamp: Date.now(),
            direction: "receive",
            text: `Spawned ${plan.executable} ${plan.args.join(" ")} (pid ${debuggee.pid})`.trim(),
          },
          {
            timestamp: Date.now(),
            direction: "receive",
            text: context.chromeBin
              ? "Isolated Chrome profile — a second browser can open beside this one"
              : "Chrome/Edge not found — Node inspector will still attach",
          },
        ],
      };
      const active: Active = {
        owner,
        recipe: "web",
        session: null,
        snapshot,
        debuggee,
        offStopped: () => undefined,
        offTerminated: () => undefined,
        offExited: () => undefined,
        pendingBreakpoints: new Map(
          groupBreakpoints(request.breakpoints).map(([path, lines]) => [path, lines]),
        ),
        consoleQueue: [],
        consoleFlush: null,
        projectRoot: context.projectRoot,
        inspectPort,
        remoteDebugPort,
        targets: new Map(),
        selectedTargetId: null,
        rendererPoll: null,
        seenRendererIds: new Set(),
      };
      this.sessions.set(owner.id, active);
      owner.once("destroyed", () => {
        if (this.sessions.get(owner.id) !== active) return;
        this.sessions.delete(owner.id);
        this.unsubscribe(active);
        void this.disposeActive(active, true);
      });
      debuggee.once("exit", () => {
        if (this.sessions.get(owner.id) !== active) return;
        void this.finish(active);
      });
      const pipe = (
        stream: NodeJS.ReadableStream | null,
        streamKind: "stdout" | "stderr",
      ): void => {
        let buf = "";
        const consume = (text: string, toConsole: boolean): void => {
          if (!text.trim()) return;
          const inspect = parseNodeInspectorWebSocketUrl(text);
          if (inspect) active.discoveredInspectUrl = inspect;
          const pageUrl = parseDevServerUrl(text);
          if (pageUrl) active.discoveredPageUrl = pageUrl;
          const inUsePort = parseAddressInUsePort(text);
          if (inUsePort) active.portInUse ??= inUsePort;
          if (!toConsole) return;
          const direction =
            streamKind === "stderr" && !isBenignDebuggeeStderr(text)
              ? "error"
              : "receive";
          this.appendConsole(active, { timestamp: Date.now(), direction, text });
        };
        stream?.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          if (buf.length > 65_536) buf = buf.slice(-32_768);
          let nl = buf.search(/\r?\n/);
          while (nl >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl).replace(/^\r?\n/, "");
            consume(line, true);
            nl = buf.search(/\r?\n/);
          }
          if (buf.trim().length >= 12) consume(buf, false);
        });
      };
      pipe(debuggee.stdout, "stdout");
      pipe(debuggee.stderr, "stderr");
      this.emit(owner, snapshot);

      const epoch = this.attachEpoch.get(owner.id) ?? 0;
      this.attaching.add(owner.id);
      void this.attachWeb(owner, active, {
        inspectPort,
        remoteDebugPort,
        projectRoot: context.projectRoot,
        pageUrl: context.pageUrl,
        chromeBin: context.chromeBin,
        epoch,
      }).finally(() => this.attaching.delete(owner.id));
      return { ok: true, snapshot };
    } catch (err) {
      debuggee?.kill();
      const message = err instanceof Error ? err.message : String(err);
      this.emit(owner, { ...starting, status: "error", error: message });
      return { ok: false, message };
    }
  }

  private async attachElectron(
    owner: WebContents,
    active: Active,
    input: {
      inspectPort: number;
      remoteDebugPort: number;
      projectRoot: string;
      epoch: number;
    },
  ): Promise<void> {
    const stale = (): boolean =>
      (this.attachEpoch.get(owner.id) ?? 0) !== input.epoch ||
      this.sessions.get(owner.id) !== active;
    try {
      active.snapshot = {
        ...active.snapshot,
        status: "running",
        progressText: "Waiting for Electron inspector…",
      };
      this.emit(owner, active.snapshot);
      const webSocketUrl = await waitForNodeInspector({
        port: input.inspectPort,
        timeoutMs: 60_000,
        discoveredUrl: () => active.discoveredInspectUrl,
        isCancelled: stale,
      });
      if (stale()) return;
      await this.addElectronTarget(active, {
        id: "main",
        kind: "node",
        label: "Main",
        webSocketUrl,
        projectRoot: input.projectRoot,
      });
      if (stale()) return;
      active.selectedTargetId = "main";
      this.syncElectronSnapshot(active, {
        status: "running",
        progressText: "Main process attached · waiting for renderer…",
      });
      const attachPages = async (): Promise<void> => {
        if (stale()) return;
        let list: CdpTargetInfo[] = [];
        try {
          list = await fetchCdpTargets(input.remoteDebugPort);
        } catch {
          return;
        }
        let attached = false;
        for (const target of list) {
          if (!shouldAttachPage(target) || active.seenRendererIds.has(target.id)) continue;
          if (!target.webSocketDebuggerUrl) continue;
          active.seenRendererIds.add(target.id);
          const id = `renderer:${target.id}`;
          await this.addElectronTarget(active, {
            id,
            kind: "chrome",
            label: rendererSessionLabel(target),
            webSocketUrl: target.webSocketDebuggerUrl,
            projectRoot: input.projectRoot,
          });
          attached = true;
        }
        if (attached && !stale()) this.syncElectronSnapshot(active);
      };
      await attachPages();
      if (stale()) return;
      active.rendererPoll = setInterval(() => {
        void attachPages();
      }, 1_000);
      this.syncElectronSnapshot(active, {
        status: "running",
        progressText:
          active.targets.size > 1
            ? `Debugger attached · ${active.targets.size} sessions`
            : "Debugger attached · main process",
      });
    } catch (err) {
      if (stale()) return;
      const message = err instanceof Error ? err.message : String(err);
      this.appendConsole(active, {
        timestamp: Date.now(),
        direction: "error",
        text: message,
      });
      active.snapshot = {
        ...active.snapshot,
        status: "running",
        progressText: `Electron running · debugger not attached — ${message}`,
      };
      this.emit(owner, active.snapshot);
    }
  }

  private spawnChromeDebuggee(
    active: Active,
    chromeBin: string,
    url: string,
    remoteDebugPort: number,
    projectRoot: string,
  ): void {
    const plan = chromeSpawnPlan(chromeBin, url, remoteDebugPort, projectRoot);
    const chrome = spawn(plan.executable, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
      shell: plan.shell,
      detached: process.platform !== "win32",
    });
    if (!chrome.pid) {
      chrome.kill();
      throw new Error("Failed to start Chrome");
    }
    active.chromeDebuggee = chrome;
    chrome.once("exit", () => {
      if (this.sessions.get(active.owner.id) !== active) return;
      this.appendConsole(active, {
        timestamp: Date.now(),
        direction: "receive",
        text: "Chrome closed — Node server is still attached",
      });
    });
    this.appendConsole(active, {
      timestamp: Date.now(),
      direction: "receive",
      text: `Spawned Chrome (pid ${chrome.pid}) · ${url}`,
    });
  }

  private async attachWeb(
    owner: WebContents,
    active: Active,
    input: {
      inspectPort: number;
      remoteDebugPort: number;
      projectRoot: string;
      pageUrl: string | null;
      chromeBin: string | null;
      epoch: number;
    },
  ): Promise<void> {
    const stale = (): boolean =>
      (this.attachEpoch.get(owner.id) ?? 0) !== input.epoch ||
      this.sessions.get(owner.id) !== active;
    try {
      active.snapshot = {
        ...active.snapshot,
        status: "running",
        progressText: "Waiting for Node inspector…",
      };
      this.emit(owner, active.snapshot);
      const webSocketUrl = await waitForNodeInspector({
        port: input.inspectPort,
        timeoutMs: 60_000,
        discoveredUrl: () => active.discoveredInspectUrl,
        isCancelled: stale,
      });
      if (stale()) return;
      await this.addElectronTarget(active, {
        id: "server",
        kind: "node",
        label: "Server",
        webSocketUrl,
        projectRoot: input.projectRoot,
      });
      if (stale()) return;
      active.selectedTargetId = "server";
      this.syncElectronSnapshot(active, {
        status: "running",
        progressText: "Server attached · waiting for the page…",
      });

      let pageUrl = input.pageUrl;
      if (input.chromeBin) {
        this.appendConsole(active, {
          timestamp: Date.now(),
          direction: "receive",
          text: "Waiting for the web server to listen so Chrome can open…",
        });
        try {
          pageUrl = await waitForDevServerUrl({
            timeoutMs: 45_000,
            ...(input.pageUrl ? { configuredUrl: input.pageUrl } : {}),
            discoveredUrl: () =>
              active.discoveredPageUrl ?? input.pageUrl ?? undefined,
            failFast: () => {
              const port = active.portInUse;
              if (!port) return undefined;
              const holder = pidsListeningOnPort(port)
                .filter((pid) => pid !== active.debuggee?.pid)
                .join(", ");
              return `Port ${port} is already in use${
                holder ? ` (pid ${holder})` : ""
              } — stop that process or set web.url in .larry/debug.json`;
            },
            probeUrls: () => {
              const pid = active.debuggee?.pid;
              if (!pid) return [];
              return httpUrlsForListenPorts(
                listenTcpPortsForProcessTree(pid, {
                  excludePorts: [
                    input.inspectPort,
                    input.inspectPort + 1,
                    input.inspectPort + 2,
                    input.remoteDebugPort,
                  ],
                }),
              );
            },
            isCancelled: stale,
          });
        } catch (err) {
          if (stale()) return;
          this.appendConsole(active, {
            timestamp: Date.now(),
            direction: "error",
            text:
              err instanceof Error
                ? err.message
                : "Could not detect a local HTTP URL for Chrome",
          });
        }
        if (stale()) return;
        if (pageUrl) {
          const chromeUrl = toChromePageUrl(pageUrl);
          try {
            this.spawnChromeDebuggee(
              active,
              input.chromeBin,
              chromeUrl,
              input.remoteDebugPort,
              input.projectRoot,
            );
          } catch (err) {
            this.appendConsole(active, {
              timestamp: Date.now(),
              direction: "error",
              text: `Chrome did not start — ${
                err instanceof Error ? err.message : String(err)
              }`,
            });
          }
        }
      } else {
        this.appendConsole(active, {
          timestamp: Date.now(),
          direction: "error",
          text: "Chrome/Edge not found — set web.chromeExecutable in .larry/debug.json",
        });
      }

      const attachPages = async (): Promise<void> => {
        if (stale()) return;
        let list: CdpTargetInfo[] = [];
        try {
          list = await fetchCdpTargets(input.remoteDebugPort);
        } catch {
          return;
        }
        let attached = false;
        for (const target of list) {
          if (!shouldAttachPage(target) || active.seenRendererIds.has(target.id)) continue;
          if (!target.webSocketDebuggerUrl) continue;
          active.seenRendererIds.add(target.id);
          const id = `page:${target.id}`;
          await this.addElectronTarget(active, {
            id,
            kind: "chrome",
            label: pageSessionLabel(target),
            webSocketUrl: target.webSocketDebuggerUrl,
            projectRoot: input.projectRoot,
          });
          attached = true;
        }
        if (attached && !stale()) {
          this.syncElectronSnapshot(active, {
            progressText: `Debugger attached · ${active.targets.size} sessions`,
          });
        }
      };
      await attachPages();
      if (stale()) return;
      active.rendererPoll = setInterval(() => {
        void attachPages();
      }, 1_000);
      this.syncElectronSnapshot(active, {
        status: "running",
        progressText:
          active.targets.size > 1
            ? `Debugger attached · ${active.targets.size} sessions`
            : active.chromeDebuggee
              ? "Chrome launched · waiting for the page…"
              : "Debugger attached · server",
      });
    } catch (err) {
      if (stale()) return;
      const message = err instanceof Error ? err.message : String(err);
      this.appendConsole(active, {
        timestamp: Date.now(),
        direction: "error",
        text: message,
      });
      active.snapshot = {
        ...active.snapshot,
        status: "running",
        progressText: `Server running · debugger not attached — ${message}`,
      };
      this.emit(owner, active.snapshot);
    }
  }

  private async addElectronTarget(
    active: Active,
    input: {
      id: string;
      kind: "node" | "chrome";
      label: string;
      webSocketUrl: string;
      projectRoot: string;
    },
  ): Promise<void> {
    const runtime = new ElectronCdpSession({
      id: input.id,
      kind: input.kind,
      label: input.label,
      webSocketUrl: input.webSocketUrl,
      projectRoot: input.projectRoot,
    });
    const slot: ElectronTargetSlot = {
      id: input.id,
      kind: input.kind,
      label: input.label,
      status: "starting",
      runtime,
      offStopped: () => undefined,
      offResumed: () => undefined,
      offEnded: () => undefined,
      offConsole: () => undefined,
    };
    slot.offStopped = runtime.onStopped((ev) => {
      slot.status = "stopped";
      slot.stopped = ev;
      const focused = active.targets.get(active.selectedTargetId ?? "");
      if (shouldStealDebugFocus(focused?.status) || active.selectedTargetId === slot.id) {
        active.selectedTargetId = slot.id;
        try {
          this.onStopped?.(active.owner);
        } catch {
          /* focus is best-effort */
        }
        void this.refreshElectronStopped(active, slot, ev);
      } else {
        this.syncElectronSnapshot(active);
      }
    });
    slot.offResumed = runtime.onResumed(() => {
      slot.status = "running";
      delete slot.stopped;
      if (active.selectedTargetId === slot.id && active.snapshot.status === "stopped") {
        const {
          stopped: _s,
          threads: _t,
          selectedThreadId: _id,
          ...rest
        } = active.snapshot;
        active.snapshot = { ...rest, status: "running", stack: [], locals: [] };
      }
      this.syncElectronSnapshot(active);
    });
    slot.offEnded = runtime.onEnded(() => {
      slot.status = "ended";
      if (slot.kind === "node") {
        void this.finish(active);
        return;
      }
      if (active.selectedTargetId === slot.id) {
        const node = [...active.targets.values()].find(
          (item) => item.kind === "node" && item.status !== "ended",
        );
        active.selectedTargetId = node?.id ?? null;
      }
      this.syncElectronSnapshot(active);
    });
    slot.offConsole = runtime.onConsole((entry) => {
      this.appendConsole(active, {
        timestamp: Date.now(),
        direction: entry.direction,
        text: `${slot.label} │ ${entry.text}`,
      });
    });
    active.targets.set(input.id, slot);
    await runtime.start();
    if (this.sessions.get(active.owner.id) !== active) {
      await runtime.dispose();
      return;
    }
    slot.status = "running";
    await this.applyPendingElectronBreakpoints(active, slot);
  }

  private async applyPendingElectronBreakpoints(
    active: Active,
    slot: ElectronTargetSlot,
  ): Promise<void> {
    const root = active.projectRoot ?? "";
    for (const [path, breakpoints] of active.pendingBreakpoints) {
      const lane =
        active.recipe === "web"
          ? webBreakpointLane(path, root)
          : breakpointLane(path, root);
      if (lane === "main" && slot.kind !== "node") continue;
      if (lane === "renderer" && slot.kind !== "chrome") continue;
      try {
        await slot.runtime.replaceBreakpoints(path, breakpoints);
      } catch {
        /* live toggles retry */
      }
    }
  }

  private electronTargets(active: Active): DebugTarget[] {
    return [...active.targets.values()].map((slot) => ({
      id: slot.id,
      kind: slot.kind,
      label: slot.label,
      status: slot.status,
      ...(slot.stopped?.reason ? { stoppedReason: slot.stopped.reason } : {}),
    }));
  }

  private syncElectronSnapshot(
    active: Active,
    patch?: Partial<DebugSnapshot>,
  ): void {
    const focused = active.targets.get(active.selectedTargetId ?? "");
    active.snapshot = {
      ...active.snapshot,
      ...patch,
      recipe: active.recipe,
      targets: this.electronTargets(active),
      ...(active.selectedTargetId
        ? { selectedTargetId: active.selectedTargetId }
        : {}),
      status:
        focused?.status === "stopped"
          ? "stopped"
          : patch?.status ??
            (active.snapshot.status === "error" ? "error" : "running"),
    };
    this.emit(active.owner, active.snapshot);
  }

  private async refreshElectronStopped(
    active: Active,
    slot: ElectronTargetSlot,
    stopped: DapStoppedEvent,
  ): Promise<void> {
    if (this.sessions.get(active.owner.id) !== active) return;
    try {
      const threads = await slot.runtime.threads();
      const stack = await slot.runtime.stack(stopped.threadId);
      active.snapshot = {
        ...active.snapshot,
        recipe: active.recipe,
        status: "stopped",
        stopped,
        threads,
        selectedThreadId: 1,
        ...(stack[0] ? { selectedFrameId: stack[0].id } : {}),
        stack,
        locals: [],
        selectedTargetId: slot.id,
        targets: this.electronTargets(active),
      };
      this.emit(active.owner, active.snapshot);
      const locals = stack[0] ? await slot.runtime.locals(stack[0].id) : [];
      if (
        this.sessions.get(active.owner.id) !== active ||
        active.selectedTargetId !== slot.id ||
        active.snapshot.status !== "stopped"
      ) {
        return;
      }
      active.snapshot = { ...active.snapshot, locals };
    } catch (err) {
      active.snapshot = {
        ...active.snapshot,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        stack: [],
        locals: [],
        targets: this.electronTargets(active),
      };
    }
    this.emit(active.owner, active.snapshot);
  }

  private focusedElectron(active: Active): ElectronTargetSlot | null {
    if (!isCdpRecipe(active.recipe)) return null;
    const id = active.selectedTargetId;
    return id ? active.targets.get(id) ?? null : null;
  }

  async selectTarget(
    owner: WebContents,
    targetId: string,
  ): Promise<{ ok: boolean; message?: string }> {
    const active = this.sessions.get(owner.id);
    if (!active || !isCdpRecipe(active.recipe)) {
      return { ok: false, message: "No debug session" };
    }
    const slot = active.targets.get(targetId);
    if (!slot || slot.status === "ended") {
      return { ok: false, message: "Session is no longer available" };
    }
    active.selectedTargetId = targetId;
    if (slot.status === "stopped" && slot.stopped) {
      await this.refreshElectronStopped(active, slot, slot.stopped);
      return { ok: true };
    }
    const {
      stopped: _s,
      threads: _t,
      selectedThreadId: _id,
      ...rest
    } = active.snapshot;
    active.snapshot = {
      ...rest,
      status: slot.status === "starting" ? "starting" : "running",
      selectedTargetId: targetId,
      targets: this.electronTargets(active),
      stack: [],
      locals: [],
    };
    this.emit(owner, active.snapshot);
    return { ok: true };
  }

  async replaceBreakpoints(
    owner: WebContents,
    path: string,
    breakpoints: LineBreakpoint[],
  ): Promise<{ ok: boolean; message?: string }> {
    const active = this.sessions.get(owner.id);
    if (!active) return { ok: true };
    active.pendingBreakpoints.set(path, breakpoints);
    if (isCdpRecipe(active.recipe)) {
      const root = active.projectRoot ?? "";
      const lane =
        active.recipe === "web"
          ? webBreakpointLane(path, root)
          : breakpointLane(path, root);
      try {
        await Promise.all(
          [...active.targets.values()]
            .filter((slot) => slot.status !== "ended")
            .filter((slot) => {
              if (lane === "main") return slot.kind === "node";
              if (lane === "renderer") return slot.kind === "chrome";
              return true;
            })
            .map((slot) => slot.runtime.replaceBreakpoints(path, breakpoints)),
        );
        return { ok: true };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }
    if (!active.session) return { ok: true };
    try {
      await active.session.replaceBreakpoints(path, breakpoints);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async evaluate(
    owner: WebContents,
    expression: string,
    frameId: number,
  ): Promise<DebugEvaluateResult> {
    const active = this.sessions.get(owner.id);
    const runtime =
      active != null && isCdpRecipe(active.recipe)
        ? this.focusedElectron(active)?.runtime
        : active?.session;
    if (!active || !runtime || active.snapshot.status !== "stopped") {
      return { ok: false, message: "Process is not paused" };
    }
    if (!active.snapshot.stack.some((frame) => frame.id === frameId)) {
      return { ok: false, message: "Stack frame is no longer available" };
    }
    try {
      const body = await runtime.evaluateHover(expression, frameId);
      return {
        ok: true,
        result: body.result,
        ...(body.type ? { type: body.type } : {}),
        variablesReference: body.variablesReference ?? 0,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async variables(
    owner: WebContents,
    variablesReference: number,
  ): Promise<DebugVariablesResult> {
    const active = this.sessions.get(owner.id);
    const runtime =
      active != null && isCdpRecipe(active.recipe)
        ? this.focusedElectron(active)?.runtime
        : active?.session;
    if (!active || !runtime || active.snapshot.status !== "stopped") {
      return { ok: false, message: "Process is not paused" };
    }
    try {
      return {
        ok: true,
        variables: await runtime.variables(variablesReference),
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Open one stack frame: locals follow the frame the user picked, so a click
   * on a caller is answered even when its source file is not on this machine.
   */
  async selectFrame(
    owner: WebContents,
    frameId: number,
  ): Promise<{ ok: boolean; message?: string; frame?: DapStackFrame }> {
    const active = this.sessions.get(owner.id);
    const runtime =
      active != null && isCdpRecipe(active.recipe)
        ? this.focusedElectron(active)?.runtime
        : active?.session;
    if (!active || !runtime || active.snapshot.status !== "stopped") {
      return { ok: false, message: "Process is not paused" };
    }
    let frame = active.snapshot.stack.find((entry) => entry.id === frameId);
    if (!frame) {
      return { ok: false, message: "Stack frame is no longer available" };
    }
    try {
      let stack = active.snapshot.stack;
      // Hydrating an Engine PDB is a bonus, never a precondition: the frame
      // still opens (selection + locals) when LLDB refuses to find symbols.
      let loadedSymbols = false;
      if (!isCdpRecipe(active.recipe) && active.session) {
        try {
          loadedSymbols = await active.session.loadSymbolsForFrame(frame);
        } catch (err) {
          this.appendConsole(active, {
            timestamp: Date.now(),
            direction: "error",
            text: `Could not load symbols for ${frame.name}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
        if (loadedSymbols) {
          const threadId = active.snapshot.selectedThreadId;
          if (typeof threadId === "number") {
            const refreshed = await active.session.stack(threadId);
            const refreshedFrame =
              refreshed.find((entry) => entry.id === frameId) ??
              refreshed.find(
                (entry) =>
                  entry.name === frame!.name &&
                  entry.moduleId === frame!.moduleId,
              );
            if (refreshedFrame) {
              frame = refreshedFrame;
              stack = refreshed;
            }
          }
        }
      }
      const locals = await runtime.locals(frame.id);
      if (
        this.sessions.get(owner.id) !== active ||
        active.snapshot.status !== "stopped"
      ) {
        return { ok: false, message: "Process resumed while loading the frame" };
      }
      active.snapshot = {
        ...active.snapshot,
        selectedFrameId: frame.id,
        stack,
        locals,
      };
      this.emit(owner, active.snapshot);
      return { ok: true, frame };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async selectThread(
    owner: WebContents,
    threadId: number,
  ): Promise<{ ok: boolean; message?: string }> {
    const active = this.sessions.get(owner.id);
    const runtime =
      active != null && isCdpRecipe(active.recipe)
        ? this.focusedElectron(active)?.runtime
        : active?.session;
    if (!active || !runtime || active.snapshot.status !== "stopped") {
      return { ok: false, message: "Process is not paused" };
    }
    if (!active.snapshot.threads?.some((thread) => thread.id === threadId)) {
      return { ok: false, message: "Thread is no longer available" };
    }
    try {
      const stack = await runtime.stack(threadId);
      const locals = stack[0] ? await runtime.locals(stack[0].id) : [];
      if (
        this.sessions.get(owner.id) !== active ||
        active.snapshot.status !== "stopped"
      ) {
        return { ok: false, message: "Process resumed while loading the thread" };
      }
      active.snapshot = {
        ...active.snapshot,
        selectedThreadId: threadId,
        ...(stack[0] ? { selectedFrameId: stack[0].id } : {}),
        stack,
        locals,
      };
      this.emit(owner, active.snapshot);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async command(
    owner: WebContents,
    command: DebugCommand,
  ): Promise<{ ok: boolean; message?: string }> {
    if (command === "stop") return this.stop(owner);
    const active = this.sessions.get(owner.id);
    const runtime =
      active != null && isCdpRecipe(active.recipe)
        ? this.focusedElectron(active)?.runtime
        : active?.session;
    if (!active || !runtime) {
      return { ok: false, message: "Debugger is not attached" };
    }
    try {
      if (command === "pause") {
        if (active.snapshot.status !== "running") {
          return { ok: false, message: "Debug target is not running" };
        }
        await runtime.pauseMainThread();
        return { ok: true };
      }
      const {
        stopped: _stopped,
        threads: _threads,
        selectedThreadId: _selectedThreadId,
        ...running
      } = active.snapshot;
      active.snapshot = {
        ...running,
        status: "running",
        stack: [],
        locals: [],
      };
      this.emit(owner, active.snapshot);
      if (command === "continue") await runtime.continue();
      else if (command === "next") await runtime.next();
      else if (command === "stepIn") await runtime.stepIn();
      else await runtime.stepOut();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async stop(owner: WebContents): Promise<{ ok: boolean }> {
    this.attachEpoch.set(owner.id, (this.attachEpoch.get(owner.id) ?? 0) + 1);
    // Stop during the auto-build phase cancels the compile; ensureBuild then
    // reports "Build cancelled" and start() unwinds to idle.
    const buildRunId = this.builds.get(owner.id);
    if (buildRunId) {
      this.builds.delete(owner.id);
      stopDevTask(buildRunId);
    }
    const active = this.sessions.get(owner.id);
    if (!active) return { ok: true };
    this.sessions.delete(owner.id);
    this.unsubscribe(active);
    await this.disposeActive(active, true);
    this.emit(owner, {
      workspacePath: active.snapshot.workspacePath,
      status: "idle",
      stack: [],
      locals: [],
    });
    return { ok: true };
  }

  async dispose(): Promise<void> {
    const active = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      active.map(async (item) => {
        this.unsubscribe(item);
        await this.disposeActive(item, true);
      }),
    );
  }

  private appendConsole(active: Active, entry: DebugConsoleEntry): void {
    const consoleEntries = active.snapshot.console ?? [];
    consoleEntries.push(entry);
    if (consoleEntries.length > MAX_CONSOLE_ENTRIES) {
      consoleEntries.splice(0, consoleEntries.length - MAX_CONSOLE_ENTRIES);
    }
    active.snapshot.console = consoleEntries;
    active.consoleQueue.push(entry);
    if (active.consoleQueue.length > MAX_CONSOLE_ENTRIES) {
      active.consoleQueue.splice(
        0,
        active.consoleQueue.length - MAX_CONSOLE_ENTRIES,
      );
    }
    if (active.consoleFlush) return;
    active.consoleFlush = setTimeout(() => {
      active.consoleFlush = null;
      this.flushConsole(active);
    }, CONSOLE_FLUSH_MS);
  }

  private flushConsole(active: Active): void {
    if (active.consoleFlush) {
      clearTimeout(active.consoleFlush);
      active.consoleFlush = null;
    }
    const entries = active.consoleQueue;
    if (entries.length === 0) return;
    active.consoleQueue = [];
    if (active.owner.isDestroyed()) return;
    const payload: DebugOutputEvent = {
      workspacePath: active.snapshot.workspacePath,
      entries,
    };
    active.owner.send("debug:output", payload);
  }

  private async refreshStopped(
    active: Active,
    stopped: DapStoppedEvent,
  ): Promise<void> {
    if (this.sessions.get(active.owner.id) !== active || !active.session) return;
    try {
      const threads = await active.session.threads();
      const selectedThreadId =
        threads.find((thread) => thread.id === stopped.threadId)?.id ??
        threads[0]?.id;
      const stack =
        typeof selectedThreadId === "number"
          ? await active.session.stack(selectedThreadId)
          : [];
      const { progressText: _progressText, ...rest } = active.snapshot;
      active.snapshot = {
        ...rest,
        status: "stopped",
        stopped,
        threads,
        ...(typeof selectedThreadId === "number" ? { selectedThreadId } : {}),
        ...(stack[0] ? { selectedFrameId: stack[0].id } : {}),
        stack,
        locals: [],
      };
      // Source navigation must not wait for a potentially expensive variables
      // request. The renderer can reveal the top frame from this first emit.
      this.emit(active.owner, active.snapshot);
      const locals = stack[0] ? await active.session.locals(stack[0].id) : [];
      if (
        this.sessions.get(active.owner.id) !== active ||
        active.snapshot.status !== "stopped" ||
        // The user may have opened another frame while these locals loaded.
        active.snapshot.selectedFrameId !== stack[0]?.id
      ) {
        return;
      }
      active.snapshot = { ...active.snapshot, locals };
    } catch (err) {
      active.snapshot = {
        ...active.snapshot,
        status: "error",
        stopped,
        stack: [],
        locals: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
    this.emit(active.owner, active.snapshot);
  }

  private async finish(
    active: Active,
    opts?: { keepError?: boolean },
  ): Promise<void> {
    if (this.sessions.get(active.owner.id) !== active) return;
    this.sessions.delete(active.owner.id);
    this.unsubscribe(active);
    const error = opts?.keepError ? active.snapshot.error : undefined;
    const console = opts?.keepError ? active.snapshot.console : undefined;
    await this.disposeActive(active);
    this.emit(active.owner, {
      workspacePath: active.snapshot.workspacePath,
      status: error ? "error" : "idle",
      stack: [],
      locals: [],
      ...(error ? { error } : {}),
      ...(console ? { console } : {}),
    });
  }

  /**
   * Close the adapter. Explicit Stop/window teardown also terminates the
   * process that this debug session launched; an already-running Unreal
   * Editor that was attached is left alone.
   */
  private async disposeActive(
    active: Active,
    terminateLaunchedUnreal = false,
  ): Promise<void> {
    this.flushConsole(active);
    const extraPids =
      terminateLaunchedUnreal && isCdpRecipe(active.recipe)
        ? [
            ...pidsListeningOnPort(active.inspectPort),
            ...pidsListeningOnPort(active.remoteDebugPort),
            ...(active.chromeDebuggee?.pid ? [active.chromeDebuggee.pid] : []),
          ]
        : [];
    const debuggee = terminateLaunchedUnreal ? active.debuggee : undefined;
    await terminateLaunchedProcess(debuggee, extraPids);
    if (terminateLaunchedUnreal) {
      await terminateLaunchedProcess(active.chromeDebuggee);
    }
    for (const slot of active.targets.values()) {
      try {
        await slot.runtime.dispose();
      } catch {
        /* already gone */
      }
    }
    active.targets.clear();
    await active.session?.dispose();
  }

  private unsubscribe(active: Active): void {
    active.offStopped();
    active.offTerminated();
    active.offExited();
    if (active.rendererPoll) {
      clearInterval(active.rendererPoll);
      active.rendererPoll = null;
    }
    for (const slot of active.targets.values()) {
      slot.offStopped();
      slot.offResumed();
      slot.offEnded();
      slot.offConsole();
    }
  }

  private emit(owner: WebContents, snapshot: DebugSnapshot): void {
    if (!owner.isDestroyed()) owner.send("debug:state", snapshot);
  }
}
