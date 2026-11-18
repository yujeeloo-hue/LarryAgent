
export type UbtBuildPhase =
  | "analyzing"
  | "generating"
  | "compiling"
  | "linking";

export type UbtBuildProgress = {
  phase: UbtBuildPhase;
  totalActions: number | null;
  doneActions: number | null;
  currentAction: string | null;
  linkingSeen: boolean;
};

export type UbtProgressParser = {
  feed(chunk: string): UbtBuildProgress;
  snapshot(): UbtBuildProgress;
  reset(): void;
};

const BUILDING_TOTAL_RE = /Building (\d+) action\(s\) started/;
const ACTION_RE =
  /^\[(\d+)\/(\d+)\]\s*(?:\[[^\]]*\]\s*)?(?:\(Wall:[^)]*\)\s*)?(.*)$/;
const PROGRESS_MARKUP_RE = /^@progress\s+'([^']*)'\s+(\d+)%/;
const PROGRESS_PUSH_RE = /^@progress\s+push\b/i;
const GENERATING_RE =
  /\b(Parsing headers|Generating code|Running UnrealHeaderTool)\b/i;
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


export type UbtRateSample = { done: number; atMs: number };

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

export function estimateEtaMs(remaining: number, ratePerSecond: number): number | null {
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) return null;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  return (remaining / ratePerSecond) * 1000;
}

export function isTailLinking(done: number, total: number): boolean {
  if (total <= 0 || done <= 0) return false;
  const remaining = total - done;
  if (remaining <= 0) return false;
  const ratio = done / total;
  return ratio >= 0.95 && remaining <= Math.max(2, Math.ceil(total * 0.002));
}
