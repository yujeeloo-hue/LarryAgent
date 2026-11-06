/**
 * Sleep countdown card DOM: the live RAF countdown zone appended to a
 * running run_shell card (detected `sleep N && check…` command) and the
 * compact finished zone. Stays a compact card for the whole lifetime —
 * never the expandable generic Shell Arguments card.
 *
 * Zero main-process events — the wait duration comes from the command
 * itself and the countdown is driven by a local rAF loop that stops as
 * soon as the zone is detached from the document.
 */

import { TriangleAlert } from "lucide";
import { createCheckBadge } from "../../../ui/checkBadge.js";
import { createLucideIcon } from "../../../ui/originalIcons.js";
import {
  formatSleepDuration,
  type SleepCommandInfo,
} from "../../../../../tools/sleepDetect.js";
import type { SleepLiveState } from "./toolInvocationTypes.js";
import { isCompactSleepFollowUp } from "./sleepCardFormat.js";

export {
  parseSleepResultOutput,
  sleepFinishedHint,
  sleepHint,
  sleepInfoFromArgs,
} from "./sleepCardFormat.js";

/** Live countdown zone; the rAF loop self-terminates on detach. */
export function createSleepZone(state: SleepLiveState): HTMLElement {
  const zone = document.createElement("div");
  zone.className = "content-card-tool-sleep-zone";

  const track = document.createElement("div");
  track.className = "content-card-tool-sleep-bar";
  const fill = document.createElement("div");
  fill.className = "content-card-tool-sleep-bar-fill";
  track.append(fill);

  const line = document.createElement("div");
  line.className = "content-card-tool-sleep-line";
  const readout = document.createElement("span");
  readout.className = "content-card-tool-sleep-readout";
  const rest = document.createElement("span");
  rest.className = "content-card-tool-sleep-rest";
  rest.textContent = `of ${formatSleepDuration(state.seconds)}${
    state.hasFollowUp ? " · then follow-up" : ""
  }`;
  line.append(readout, rest);
  zone.append(track, line);

  const totalMs = state.seconds * 1000;
  const tick = (): void => {
    // Card replaced (finished) or torn down (refresh) — stop the loop.
    if (!zone.isConnected) return;
    const remainMs = state.startedAt + totalMs - Date.now();
    if (remainMs <= 0) {
      fill.style.width = "100%";
      fill.classList.add("is-ok");
      readout.textContent = "0.0s left";
      readout.classList.add("is-ok");
      rest.textContent = state.hasFollowUp ? "running follow-up…" : "finishing…";
      return;
    }
    fill.style.width = `${((remainMs / totalMs) * 100).toFixed(2)}%`;
    readout.textContent = `${(remainMs / 1000).toFixed(1)}s left`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return zone;
}

/** Pop the plan-step check in when the wait finishes. */
function playSleepCheckEnter(badge: HTMLElement): void {
  if (typeof badge.animate !== "function") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  badge.animate(
    [
      { opacity: 0, transform: "scale(0.35)" },
      { opacity: 1, transform: "scale(1.14)", offset: 0.58 },
      { opacity: 1, transform: "scale(1)" },
    ],
    {
      duration: 440,
      delay: 40,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      fill: "backwards",
    },
  );
}

/** Compact finished zone: wait summary + follow-up output / stop / failure. */
export function createSleepFinishedSection(input: {
  info: SleepCommandInfo;
  ok: boolean;
  cancelled: boolean;
  stdoutText: string;
  stderrText?: string;
}): HTMLElement {
  const zone = document.createElement("div");
  zone.className = "content-card-tool-sleep-zone is-finished";

  if (!input.ok) {
    const err = document.createElement("div");
    err.className = "content-card-tool-sleep-err";
    err.append(createLucideIcon(TriangleAlert, { size: 14 }));
    const title = document.createElement("span");
    title.className = "content-card-tool-sleep-err-title";
    title.textContent = input.cancelled
      ? "Stopped by user"
      : "Command failed after the wait";
    err.append(title);
    zone.append(err);

    const hint = document.createElement("p");
    hint.className = "content-card-tool-sleep-err-hint";
    hint.textContent = input.cancelled
      ? "The wait was interrupted, so the follow-up never ran."
      : "The wait finished but a follow-up command returned an error.";
    zone.append(hint);
  }

  const stats = document.createElement("div");
  stats.className = "content-card-tool-sleep-stats";
  if (input.ok) {
    const badge = createCheckBadge({ size: 14 }, createLucideIcon);
    badge.classList.add("content-card-tool-sleep-check");
    stats.append(badge);
    playSleepCheckEnter(badge);
  }
  const copy = document.createElement("span");
  copy.className = "content-card-tool-sleep-stats-copy";
  const b = document.createElement("b");
  b.textContent = formatSleepDuration(input.info.seconds);
  copy.appendChild(document.createTextNode("waited "));
  copy.append(b);
  if (input.info.hasFollowUp) {
    const n = input.info.followUpCount;
    copy.appendChild(
      document.createTextNode(
        ` before ${n} follow-up command${n > 1 ? "s" : ""}`,
      ),
    );
  }
  stats.append(copy);
  zone.append(stats);

  const output = (
    input.ok
      ? input.stdoutText
      : (input.stderrText || input.stdoutText)
  ).trim();
  // Short health-check echoes (`ready` / `ok`) are represented by the
  // check on the stats line — don't repeat them as a dump.
  if (output && !(input.ok && isCompactSleepFollowUp(output))) {
    const pre = document.createElement("pre");
    pre.className = "content-card-tool-sleep-stdout";
    pre.textContent = output;
    zone.append(pre);
  }
  return zone;
}
