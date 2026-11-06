/**
 * Build progress card DOM — the live UE build status card in the
 * conversation (mounted by ConversationController for /build runs and
 * rehydrated from getDevTaskState while a build is still active).
 *
 * Zero persistence: the card is ephemeral DOM in the conversation build
 * host, not a session message. Terminal cards stay until the next build
 * or a conversation switch replaces them.
 *
 * Data comes from the devtask:progress / devtask:exit IPC pair; phase and
 * [done/total] counts are parsed main-side (src/unreal/buildProgress.ts).
 * A 1s local interval keeps `elapsed` ticking through silent phases
 * (makefile / UHT can stream nothing for minutes); it self-terminates
 * when the card detaches or reaches a terminal state.
 */

import {
  Boxes,
  Check,
  FileWarning,
  Hammer,
  Link2,
  Loader,
  X,
  Zap,
} from "lucide";
import { createLucideIcon } from "../../../ui/originalIcons.js";

export type BuildStatusCardState = {
  runId: string;
  workspacePath: string;
  status: "running" | "done" | "failed" | "timeout" | "cancelled" | "spawn-error";
  startedAt: number;
  durationMs: number | null;
  progress: DevTaskProgressSnapshot | null;
  failureHint: string | null;
  /** Last output lines, shown in the failed card's expandable tail. */
  bufferTail: string | null;
};

export type BuildStatusCardApi = {
  root: HTMLElement;
  /** Apply a live progress frame (running builds only). */
  updateProgress(progress: DevTaskProgressSnapshot, elapsedMs: number): void;
  /** Terminal snapshot — stops the elapsed ticker, shows outcome. */
  finish(state: BuildStatusCardState): void;
};

/** Lines of output kept in the failed card's collapsible tail. */
const FAILURE_TAIL_LINES = 24;

const PHASE_META: Record<
  DevTaskProgressSnapshot["phase"],
  {
    label: string;
    icon: typeof Boxes;
    determinate: boolean;
    /** Chip icon spins while this phase is active (loader icons only). */
    spin?: boolean;
  }
> = {
  analyzing: {
    label: "Analyzing",
    icon: Loader,
    determinate: false,
    spin: true,
  },
  generating: { label: "Generating code", icon: Zap, determinate: false },
  compiling: { label: "Compiling C++", icon: Boxes, determinate: true },
  linking: { label: "Linking", icon: Link2, determinate: true },
};

/** Phase chip meta shared with the Dev Mode panel progress strip. */
export const BUILD_PHASE_META = PHASE_META;

/** Shared duration formatter ("4m 12s" / "38s" / "1h 05m"). */
export function formatBuildDuration(ms: number): string {
  return fmtDur(ms);
}

function fmtDur(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  }
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

function workspaceLabel(workspacePath: string): string {
  const norm = workspacePath.replace(/[\\/]+$/, "");
  const base = norm.split(/[\\/]/).pop() ?? norm;
  return base || workspacePath;
}

export function createBuildStatusCard(state: BuildStatusCardState): BuildStatusCardApi {
  const card = document.createElement("article");
  card.className = "content-card content-card-tool-invocation content-card-build is-running";
  card.dataset.runId = state.runId;

  // --- header (content-card-tool family chrome) ---
  const header = document.createElement("div");
  header.className = "content-card-tool-header";
  const title = document.createElement("div");
  title.className = "content-card-tool-title";
  const icon = document.createElement("span");
  icon.className = "content-card-tool-icon";
  icon.append(createLucideIcon(Hammer, { size: 14 }));
  const name = document.createElement("span");
  name.className = "content-card-tool-name";
  name.textContent = "Build";
  const status = document.createElement("span");
  status.className = "content-card-tool-status";
  status.textContent = "Running";
  title.append(icon, name, status);
  const summary = document.createElement("div");
  summary.className = "content-card-tool-summary";
  summary.textContent = workspaceLabel(state.workspacePath);
  header.append(title, summary);

  // --- progress zone ---
  const zone = document.createElement("div");
  zone.className = "content-card-build-zone";

  const phaseRow = document.createElement("div");
  phaseRow.className = "content-card-build-phase";
  const phaseChip = document.createElement("span");
  phaseChip.className = "content-card-build-chip";
  const phaseCounts = document.createElement("span");
  phaseCounts.className = "content-card-build-counts";
  const phasePct = document.createElement("span");
  phasePct.className = "content-card-build-pct";
  phaseRow.append(phaseChip, phaseCounts, phasePct);

  const bar = document.createElement("div");
  bar.className = "content-card-build-bar";
  const barFill = document.createElement("div");
  barFill.className = "content-card-build-bar-fill";
  bar.append(barFill);

  const stats = document.createElement("div");
  stats.className = "content-card-build-stats";
  const rateSpan = document.createElement("span");
  const etaSpan = document.createElement("span");
  etaSpan.className = "content-card-build-eta";
  const elapsedLabel = document.createElement("span");
  elapsedLabel.appendChild(document.createTextNode("elapsed "));
  const elapsedValue = document.createElement("b");
  elapsedLabel.append(elapsedValue);
  elapsedValue.textContent = "0s";
  stats.append(rateSpan, etaSpan, elapsedLabel);

  const current = document.createElement("div");
  current.className = "content-card-build-current";
  const tick = document.createElement("span");
  tick.className = "content-card-build-tick";
  const file = document.createElement("span");
  file.className = "content-card-build-file";
  current.append(tick, file);

  zone.append(phaseRow, bar, stats, current);
  card.append(header, zone);

  const applyPhase = (
    progress: DevTaskProgressSnapshot,
    elapsedMs: number,
  ): void => {
    const meta = PHASE_META[progress.phase] ?? PHASE_META.analyzing!;
    phaseChip.replaceChildren(createLucideIcon(meta.icon, { size: 12 }));
    const label = document.createElement("span");
    label.textContent = meta.label;
    phaseChip.append(label);

    if (progress.doneActions != null && progress.totalActions != null) {
      phaseCounts.replaceChildren();
      const done = document.createElement("b");
      done.textContent = String(progress.doneActions);
      const rest = document.createElement("span");
      rest.className = "content-card-build-counts-dim";
      rest.textContent = ` / ${progress.totalActions} actions`;
      phaseCounts.append(done, rest);
      const pct = Math.floor((progress.doneActions / progress.totalActions) * 100);
      phasePct.textContent = `${pct}%`;
    } else {
      phaseCounts.textContent =
        progress.phase === "generating" ? "UnrealHeaderTool" : "makefile / targets";
      phasePct.textContent = "";
    }

    barFill.classList.toggle("indeterminate", !meta.determinate);
    barFill.classList.toggle("linking", progress.phase === "linking");
    if (meta.determinate && progress.doneActions != null && progress.totalActions != null) {
      barFill.style.width = `${(
        (progress.doneActions / Math.max(1, progress.totalActions)) *
        100
      ).toFixed(1)}%`;
    } else {
      barFill.style.width = "100%";
    }

    rateSpan.replaceChildren();
    if (progress.actionsPerSecond != null && progress.phase === "compiling") {
      rateSpan.appendChild(document.createTextNode("rate "));
      const b = document.createElement("b");
      b.textContent = progress.actionsPerSecond.toFixed(1);
      rateSpan.append(b, "/s");
    }
    etaSpan.replaceChildren();
    if (progress.etaMs != null && progress.phase !== "linking") {
      etaSpan.appendChild(document.createTextNode("ETA ≈ "));
      const b = document.createElement("b");
      b.textContent = fmtDur(progress.etaMs);
      etaSpan.append(b);
    }
    elapsedValue.textContent = fmtDur(elapsedMs);

    const desc = progress.currentAction;
    current.hidden = !desc;
    file.textContent = desc ?? "";
  };

  // Initial paint + silent-phase elapsed ticker (makefile/UHT can stream
  // nothing for minutes — elapsed must still move).
  if (state.progress) applyPhase(state.progress, Date.now() - state.startedAt);
  else {
    phaseChip.replaceChildren(createLucideIcon(Loader, { size: 12 }));
    phaseCounts.textContent = "starting…";
    barFill.classList.add("indeterminate");
  }
  const timer = window.setInterval(() => {
    if (!card.isConnected || card.dataset.terminal === "1") {
      window.clearInterval(timer);
      return;
    }
    elapsedValue.textContent = fmtDur(Date.now() - state.startedAt);
  }, 1000);

  const api: BuildStatusCardApi = {
    root: card,
    updateProgress(progress, elapsedMs): void {
      if (card.dataset.terminal === "1") return;
      applyPhase(progress, elapsedMs);
    },
    finish(final): void {
      window.clearInterval(timer);
      card.dataset.terminal = "1";
      card.classList.remove("is-running");
      const dur = final.durationMs ?? Date.now() - final.startedAt;
      if (final.status === "done") {
        card.classList.add("is-success");
        status.textContent = `Done · ${fmtDur(dur)}`;
        if (final.progress) {
          applyPhase(final.progress, dur);
          phasePct.textContent = "100%";
        }
        barFill.classList.remove("indeterminate", "linking");
        barFill.style.width = "100%";
        current.hidden = true;
        rateSpan.replaceChildren();
        etaSpan.replaceChildren();
        elapsedValue.textContent = fmtDur(dur);
      } else if (final.status === "cancelled") {
        status.textContent = `Cancelled · ${fmtDur(dur)}`;
        zone.remove();
      } else {
        card.classList.add("is-error");
        status.textContent =
          final.status === "timeout"
            ? `Timed out · ${fmtDur(dur)}`
            : final.status === "spawn-error"
              ? "Failed to start"
              : `Failed · ${fmtDur(dur)}`;

        const err = document.createElement("div");
        err.className = "content-card-build-error";
        err.append(createLucideIcon(FileWarning, { size: 13 }));
        const errText = document.createElement("span");
        errText.textContent = final.failureHint ?? "Build failed.";
        err.append(errText);
        zone.append(err);

        if (final.progress) {
          applyPhase(final.progress, dur);
          barFill.classList.remove("indeterminate", "linking");
          if (final.progress.doneActions != null && final.progress.totalActions != null) {
            barFill.style.width = `${(
              (final.progress.doneActions / Math.max(1, final.progress.totalActions)) *
              100
            ).toFixed(1)}%`;
          }
        } else {
          bar.remove();
        }
        rateSpan.replaceChildren();
        etaSpan.replaceChildren();
        elapsedValue.textContent = fmtDur(dur);
        current.hidden = true;

        if (final.bufferTail && final.bufferTail.trim().length > 0) {
          const details = document.createElement("details");
          details.className = "content-card-build-tail";
          const summaryEl = document.createElement("summary");
          summaryEl.className = "content-card-tool-result-summary";
          const left = document.createElement("span");
          left.className = "content-card-tool-details-summary-left";
          left.textContent = "Output tail";
          const chev = document.createElement("span");
          chev.className = "content-card-tool-result-chevron";
          chev.textContent = "›";
          summaryEl.append(left, chev);
          const pre = document.createElement("pre");
          pre.className = "content-card-build-tail-body";
          pre.textContent = final.bufferTail;
          details.append(summaryEl, pre);
          card.append(details);
        }
      }
      // Success/failed keep the zone; cancelled drops it entirely.
    },
  };
  return api;
}

/** Extract the last N non-empty lines for the failed tail. */
export function buildBufferTail(buffer: string, lines = FAILURE_TAIL_LINES): string {
  const rows = buffer
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/\t/g, "    "))
    .filter((l) => l.trim().length > 0);
  return rows.slice(-lines).join("\n");
}
