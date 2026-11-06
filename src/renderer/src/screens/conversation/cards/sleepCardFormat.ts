/**
 * Pure helpers for the sleep countdown card — no DOM, so node:test can
 * import them without pulling renderer CSS.
 */

import {
  detectSleepCommand,
  formatSleepDuration,
  type SleepCommandInfo,
} from "../../../../../tools/sleepDetect.js";

const FOLLOWUP_HINT_MAX = 48;

/**
 * Detect a wait-then-check command from run_shell arguments. Returns the
 * detection info (seconds / follow-up) or null for everything else.
 */
export function sleepInfoFromArgs(args: unknown): SleepCommandInfo | null {
  const command = (args as { command?: unknown } | null | undefined)?.command;
  if (typeof command !== "string") return null;
  const info = detectSleepCommand(command);
  return info.isSleep ? info : null;
}

/** One-line hint for the summary row: `sleep 8s · then: …`. */
export function sleepHint(info: SleepCommandInfo): string {
  const wait = formatSleepDuration(info.seconds);
  if (!info.hasFollowUp || !info.followUpText) return `sleep ${wait}`;
  const follow =
    info.followUpText.length > FOLLOWUP_HINT_MAX
      ? `${info.followUpText.slice(0, FOLLOWUP_HINT_MAX - 1)}…`
      : info.followUpText;
  return `sleep ${wait} · then: ${follow}`;
}

/** Finished summary hint: `waited 8s · then: …` / failure / stopped. */
export function sleepFinishedHint(
  info: SleepCommandInfo,
  ok: boolean,
  cancelled: boolean,
): string {
  const wait = formatSleepDuration(info.seconds);
  if (cancelled) return `stopped during ${wait} wait · follow-up not run`;
  if (!ok) return `waited ${wait} · follow-up failed`;
  if (info.hasFollowUp) return `waited ${wait} · then: check`;
  return `waited ${wait}`;
}

/**
 * Pull stdout/stderr out of the run_shell result body (`$ cmd` / cwd /
 * exit wrapper). The finished card must not dump that raw envelope.
 */
export function parseSleepResultOutput(resultText: string): {
  stdout: string;
  stderr: string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let section: "head" | "stdout" | "stderr" = "head";
  for (const line of resultText.split("\n")) {
    if (line === "--- stdout ---") {
      section = "stdout";
      continue;
    }
    if (line === "--- stderr ---") {
      section = "stderr";
      continue;
    }
    if (section === "stdout") stdout.push(line);
    else if (section === "stderr") stderr.push(line);
  }
  return {
    stdout: stdout.join("\n").trim(),
    stderr: stderr.join("\n").trim(),
  };
}

/** Short single-line follow-up (health-check echo) — not a dumped log. */
export function isCompactSleepFollowUp(text: string): boolean {
  const line = text.trim();
  if (!line || line.includes("\n")) return false;
  return line.length <= 48;
}
