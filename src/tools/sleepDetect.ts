
export type SleepCommandInfo = {
  isSleep: boolean;
  seconds: number;
  hasFollowUp: boolean;
  followUpCount: number;
  followUpText?: string;
};

const NONE: SleepCommandInfo = {
  isSleep: false,
  seconds: 0,
  hasFollowUp: false,
  followUpCount: 0,
};

const MAX_SLEEP_SECONDS = 3600;

const SLEEP_METACHARS = /&(?!&)/;

export function parseSleepDuration(arg: string): number | null {
  let rest = arg.trim();
  if (!rest) return null;
  let total = 0;
  let matchedAny = false;
  const unit: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  const re = /^(\d+(?:\.\d+)?)([smhd]?)/;
  while (rest) {
    const m = re.exec(rest);
    if (!m || m[0] === "") return null;
    const value = Number(m[1]);
    if (!Number.isFinite(value) || value < 0) return null;
    const multiplier = m[2] ? (unit[m[2]] ?? 1) : 1;
    total += value * multiplier;
    matchedAny = true;
    rest = rest.slice(m[0].length);
  }
  if (!matchedAny || !Number.isFinite(total) || total <= 0) return null;
  return total;
}

function parseSleepSegment(segment: string): number | null {
  const m = /^sleep\s+(.+)$/.exec(segment.trim());
  if (!m || m[1] === undefined) return null;
  const parts = m[1].trim().split(/\s+/);
  let total = 0;
  for (const p of parts) {
    const d = parseSleepDuration(p);
    if (d === null) return null;
    total += d;
  }
  return total > 0 ? total : null;
}

export function detectSleepCommand(rawCommand: string): SleepCommandInfo {
  const command = rawCommand.replace(/\\\r?\n\s*/g, " ").trim();
  if (!command) return NONE;
  if (SLEEP_METACHARS.test(command.replace(/&&/g, " "))) return NONE;

  const segments = command
    .split(/\s*(?:&&|;)\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return NONE;

  let seconds = 0;
  let idx = 0;
  while (idx < segments.length) {
    const d = parseSleepSegment(segments[idx] ?? "");
    if (d === null) break;
    seconds += d;
    idx += 1;
  }
  if (idx === 0) return NONE;
  if (seconds > MAX_SLEEP_SECONDS) return NONE;

  const followUps = segments.slice(idx);
  if (followUps.length === 0) {
    return { isSleep: true, seconds, hasFollowUp: false, followUpCount: 0 };
  }
  return {
    isSleep: true,
    seconds,
    hasFollowUp: true,
    followUpCount: followUps.length,
    followUpText: followUps.join(" && "),
  };
}

export function formatSleepDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds < 60) {
    const s = Math.round(seconds * 10) / 10;
    return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`;
  }
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${h}h`;
}
