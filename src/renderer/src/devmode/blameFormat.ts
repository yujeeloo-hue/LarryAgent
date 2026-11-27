export type BlameKind = "git" | "svn";

export type BlameEntry = {
  line: number;
  rev: string;
  author: string;
  time: number | null;
  summary: string | null;
};

export function isUncommitted(entry: BlameEntry): boolean {
  if (/^0+$/.test(entry.rev)) return true;
  return entry.rev === "M" || entry.rev === "" || entry.rev === "-";
}

export function blameAgeLabel(time: number | null, now = Date.now()): string {
  if (time === null || !Number.isFinite(time) || time <= 0) return "";
  const age = Math.max(0, now - time * 1000);
  if (age < 60_000) return "now";
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h`;
  if (age < 30 * 86_400_000) return `${Math.floor(age / 86_400_000)}d`;
  if (age < 365 * 86_400_000) {
    return `${Math.floor(age / (30 * 86_400_000))}mo`;
  }
  return `${Math.floor(age / (365 * 86_400_000))}y`;
}

function charColumns(codePoint: number): number {
  if (codePoint < 0x1100) return 1;
  const wide =
    codePoint <= 0x115f ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd);
  return wide ? 2 : 1;
}

export function shortAuthor(author: string): string {
  const name = author.trim();
  if (!name) return "—";
  if (/^not committed yet$/i.test(name)) return "you";
  let width = 0;
  let result = "";
  for (const char of name) {
    const next = width + charColumns(char.codePointAt(0)!);
    if (next > 13) return `${result}…`;
    result += char;
    width = next;
  }
  return result;
}

export function blameLabelColumns(label: string): number {
  let width = 0;
  for (const char of label) {
    width += charColumns(char.codePointAt(0)!);
  }
  return width;
}

export function blameGutterLabel(
  entry: BlameEntry,
  kind: BlameKind,
  now = Date.now(),
): string {
  const author = shortAuthor(entry.author);
  if (isUncommitted(entry)) {
    return kind === "git" ? `${author} now` : "local";
  }
  const age = blameAgeLabel(entry.time, now);
  return age ? `${author} ${age}` : author;
}

export const BLAME_BAND_COUNT = 8;

export function blameBandSlots(entries: BlameEntry[]): Map<string, number> {
  const slots = new Map<string, number>();
  for (const entry of entries) {
    if (isUncommitted(entry) || !entry.rev) continue;
    if (slots.has(entry.rev)) continue;
    slots.set(entry.rev, slots.size % BLAME_BAND_COUNT);
  }
  return slots;
}

const HOVER_BODY_MAX = 600;

function escapeMd(text: string): string {
  return text.replace(/([\\`*_\[\]])/g, "\\$1");
}

export function blameHoverText(
  entry: BlameEntry,
  kind: BlameKind,
  now = Date.now(),
): string {
  const author = entry.author.trim() || "unknown";
  if (isUncommitted(entry)) {
    const who = shortAuthor(author);
    return kind === "git"
      ? `${who} — not committed yet`
      : `${who} — locally modified (not committed)`;
  }
  const date = entry.time
    ? new Date(entry.time * 1000).toISOString().slice(0, 10)
    : "";
  const raw = entry.summary?.trim() ?? "";
  const lines = raw.length > 0 ? raw.split(/\r?\n/) : [];
  const subject = escapeMd((lines[0] ?? "").trim());
  let body = lines
    .slice(1)
    .join("\n")
    .trim();
  if (body.length > HOVER_BODY_MAX) {
    body = `${body.slice(0, HOVER_BODY_MAX)}…`;
  }
  body = escapeMd(body);

  let head: string;
  if (kind === "git") {
    head = `${escapeMd(author)} · ${entry.rev.slice(0, 7)}${date ? ` · ${date}` : ""}`;
  } else {
    const rev = /^\d+$/.test(entry.rev) ? `r${entry.rev}` : entry.rev;
    head = date
      ? `${rev} · ${escapeMd(author)} · ${date}`
      : `${rev} · ${escapeMd(author)}`;
  }

  const parts = [head];
  if (subject) parts.push(subject);
  if (body) parts.push(body);
  return parts.join("\n\n");
}

export function blameHoverPlainText(
  entry: BlameEntry,
  kind: BlameKind,
  now = Date.now(),
): string {
  return blameHoverText(entry, kind, now).replace(
    /\\([\\`*_\[\]])/g,
    "$1",
  );
}
