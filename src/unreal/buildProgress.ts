/**
 * Incremental UBT (UnrealBuildTool) stdout progress parser — data source for
 * the build progress tool card (conversation) and the Dev Mode Build panel
 * header row.
 *
 * Every line format below was verified against the local engine source
 * (NBEngineUE5.7.4, E:/Project.NF/UnrealEngine):
 *
 *  - `------ Building N action(s) started ------`
 *      ImmediateActionQueue.cs — announces the total action count.
 *  - `[done/total][Target Platform Config] (Wall: ..s CPU: ..s) description`
 *      ActionLogger.LogAction — one line per completed action. Canceled
 *      actions increment the counter but skip the line, so `done` can jump:
 *      the parser keeps the max. Target details / compilation-times segments
 *      are optional and stripped from the display description.
 *  - `@progress 'Compiling C++ source code...' N%` / `@progress push|pop`
 *      ProgressWriter + ExternalExecution — only emitted when UBT runs with
 *      `-Progress`. Parsed opportunistically (phase signal), never required.
 *  - UHT status lines (`Parsing headers…`, `Generating code… N%`) arrive via
 *      Log.SetStatusText with NO trailing newline while redirected
 *      (AllowStatusUpdates = !IsOutputRedirected → false), so chunk
 *      reassembly splits on \r\n, \n and lone \r, tolerating partial lines.
 */

export type UbtBuildPhase =
  /** UBT startup — makefile / target rules / dependency graph. */
  | "analyzing"
  /** UnrealHeaderTool — .generated.cpp/.h code generation. */
  | "generating"
  /** ParallelExecutor action queue — precise [done/total] counts. */
  | "compiling"
  /** Tail link actions — single actions can run for minutes. Sticky. */
  | "linking";

/** Parser state (no wall-clock fields — pure function of the stream). */
export type UbtBuildProgress = {
  phase: UbtBuildPhase;
  totalActions: number | null;
  doneActions: number | null;
  /** Last completed action description, target/timing segments stripped. */
  currentAction: string | null;
  /** true once a Link action description was seen — phase stays linking. */
  linkingSeen: boolean;
};

export type UbtProgressParser = {
  /** Feed a raw stdout chunk; returns the state after consuming it. */
  feed(chunk: string): UbtBuildProgress;
  /** Last state without consuming input. */
  snapshot(): UbtBuildProgress;
  /** Drop all state (run restart). */
  reset(): void;
};

/** `------ Building 5293 action(s) started ------` */
const BUILDING_TOTAL_RE = /Building (\d+) action\(s\) started/;
/** `[3121/5293][NFEditor Win64 DebugGame] (Wall: 1.5s CPU: 3.0s) desc…` */
const ACTION_RE =
  /^\[(\d+)\/(\d+)\]\s*(?:\[[^\]]*\]\s*)?(?:\(Wall:[^)]*\)\s*)?(.*)$/;
/** `-Progress` markup (optional; only when UBT is invoked with -Progress). */
const PROGRESS_MARKUP_RE = /^@progress\s+'([^']*)'\s+(\d+)%/;
const PROGRESS_PUSH_RE = /^@progress\s+push\b/i;
/** UHT status text — redirected console still flushes these as lines. */
const GENERATING_RE =
  /\b(Parsing headers|Generating code|Running UnrealHeaderTool)\b/i;
/** Link action CommandDescription is "Link" (VCToolChain link actions). */
const LINK_DESC_RE = /^(Link|Lib|CMake|ICExplicit|Execute)\b/i;

function initialState(): UbtBuildProgress {
  return {
    phase: "analyzing",
    totalActions: null,
    doneActions: null,
    currentAction: null,
    linkingSeen: false,
  };
}

/**
 * Create a parser. Deterministic in tests by design — the parser itself never
 * reads the clock; wall-clock sampling for rate/ETA lives in the main-process
 * caller (see {@link rollingActionsPerSecond}).
 */
export function createUbtProgressParser(): UbtProgressParser {
  let state = initialState();
  let pending = "";

  const consumeLine = (raw: string): void => {
    const line = raw.trim();
    if (!line) return;

    const markup = PROGRESS_MARKUP_RE.exec(line);
    if (markup) {
      const message = markup[1] ?? "";
      if (/compil/i.test(message) && state.phase !== "linking") {
        state.phase = "compiling";
      } else if (/generat/i.test(message) && state.phase === "analyzing") {
        state.phase = "generating";
      }
      return;
    }
    if (PROGRESS_PUSH_RE.test(line)) {
      // `@progress push` marks the UHT stage in ExternalExecution.
      if (state.phase === "analyzing") state.phase = "generating";
      return;
    }

    const total = BUILDING_TOTAL_RE.exec(line);
    if (total) {
      const n = Number(total[1]);
      if (Number.isFinite(n) && n > 0) {
        state.totalActions = Math.max(state.totalActions ?? 0, n);
        if (state.phase !== "linking") state.phase = "compiling";
      }
      return;
    }

    const action = ACTION_RE.exec(line);
    if (action) {
      const done = Number(action[1]);
      const totalActions = Number(action[2]);
      if (Number.isFinite(done) && Number.isFinite(totalActions)) {
        // Canceled actions skip line numbers — keep the max seen.
        state.doneActions = Math.max(state.doneActions ?? 0, done);
        if (totalActions > 0) {
          state.totalActions = Math.max(state.totalActions ?? 0, totalActions);
        }
        const description = (action[3] ?? "").trim();
        state.currentAction = description || state.currentAction;
        if (LINK_DESC_RE.test(description)) state.linkingSeen = true;
        if (state.linkingSeen) {
          state.phase = "linking";
        } else if (state.phase !== "compiling") {
          state.phase = "compiling";
        }
      }
      return;
    }

    if (GENERATING_RE.test(line) && state.phase === "analyzing") {
      state.phase = "generating";
    }
  };

  return {
    feed(chunk: string): UbtBuildProgress {
      if (!chunk) return state;
      pending += chunk;
      // Status lines carry no trailing \n when redirected; \r acts as a break.
      const lines = pending.split(/\r\n|\r|\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
      return state;
    },
    snapshot(): UbtBuildProgress {
      return state;
    },
    reset(): void {
      state = initialState();
      pending = "";
    },
  };
}

/* ------------------------------------------------------------------ */
/* Rate / ETA — pure helpers, clock injected by the caller.            */
/* ------------------------------------------------------------------ */

export type UbtRateSample = { done: number; atMs: number };

/**
 * Actions per second over a trailing window (default 30s). Uses the window's
 * first/last samples so PCH-then-tail bursts average out; null until the
 * window spans at least `minSpanMs` (default 2s) with forward progress.
 */
export function rollingActionsPerSecond(
  samples: readonly UbtRateSample[],
  windowMs: number,
  nowMs: number,
  minSpanMs: number = 2000,
): number | null {
  const recent = samples.filter((s) => nowMs - s.atMs <= windowMs);
  if (recent.length < 2) return null;
  const first = recent[0]!;
  const last = recent[recent.length - 1]!;
  const spanMs = last.atMs - first.atMs;
  const delta = last.done - first.done;
  if (spanMs < minSpanMs || delta <= 0) return null;
  return (delta * 1000) / spanMs;
}

/** ETA in ms from remaining actions and a rate; null when not estimable. */
export function estimateEtaMs(remaining: number, ratePerSecond: number): number | null {
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) return null;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  return (remaining / ratePerSecond) * 1000;
}

/** `Link`-style tail detection without a description: near-done threshold. */
export function isTailLinking(done: number, total: number): boolean {
  if (total <= 0 || done <= 0) return false;
  const remaining = total - done;
  if (remaining <= 0) return false;
  const ratio = done / total;
  return ratio >= 0.95 && remaining <= Math.max(2, Math.ceil(total * 0.002));
}
