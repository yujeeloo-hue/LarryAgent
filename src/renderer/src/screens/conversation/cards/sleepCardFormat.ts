
import {
  detectSleepCommand,
  formatSleepDuration,
  type SleepCommandInfo,
} from "../../../../../tools/sleepDetect.js";

const FOLLOWUP_HINT_MAX = 48;

export function sleepInfoFromArgs(args: unknown): SleepCommandInfo | null {
  const command = (args as { command?: unknown } | null | undefined)?.command;
  if (typeof command !== "string") return null;
  const info = detectSleepCommand(command);
  return info.isSleep ? info : null;
}

export function sleepHint(info: SleepCommandInfo): string {
  const wait = formatSleepDuration(info.seconds);
  if (!info.hasFollowUp || !info.followUpText) return `sleep ${wait}`;
  const follow =
    info.followUpText.length > FOLLOWUP_HINT_MAX
      ? `${info.followUpText.slice(0, FOLLOWUP_HINT_MAX - 1)}…`
      : info.followUpText;
  return `sleep ${wait} · then: ${follow}`;
}

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

export function isCompactSleepFollowUp(text: string): boolean {
  const line = text.trim();
  if (!line || line.includes("\n")) return false;
  return line.length <= 48;
}
