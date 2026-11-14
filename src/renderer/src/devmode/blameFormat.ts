/**
 * Pure formatting for the Dev Mode Annotate gutter — testable without
 * Monaco. Gutter label sits LEFT of the line number in the line-numbers
 * column (single string, one color); the richer text goes into the
 * hover tooltip.
 */
export type BlameKind = "git" | "svn";

export type BlameEntry = {
  line: number;
  rev: string;
  author: string;
  time: number | null;
  summary: string | null;
};

/** Uncommitted marker: git zero-hash, svn local "M". */
export function isUncommitted(entry: BlameEntry): boolean {
  if (/^0+$/.test(entry.rev)) return true;
  return entry.rev === "M" || entry.rev === "" || entry.rev === "-";
}

/** Compact relative age: now / 5m / 3h / 2d / 18d→mo / 2y. */
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

/**
 * Monospace columns for one code point. Only East Asian wide / full-width
 * glyphs take two cells — accented Latin and NBSP are single-width, so the
 * gutter column is not padded out for European names.
 */
function charColumns(codePoint: number): number {
  if (codePoint < 0x1100) return 1;
  const wide =
    codePoint <= 0x115f || // Hangul Jamo
    (codePoint >= 0x2e80 && codePoint <= 0x303e) || // CJK radicals, punctuation
    (codePoint >= 0x3041 && codePoint <= 0x33ff) || // kana, CJK compatibility
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) || // Yi
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // full-width forms
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f9ff) || // emoji
    (codePoint >= 0x20000 && codePoint <= 0x3fffd);
  return wide ? 2 : 1;
}

/** Gutter-friendly author: git's "Not Committed Yet" → "you". */
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

/** Approximate monospace columns (CJK/full-width names occupy two). */
export function blameLabelColumns(label: string): number {
  let width = 0;
  for (const char of label) {
    width += charColumns(char.codePointAt(0)!);
  }
  return width;
}

/**
 * The text rendered before the line number — just `author + age`, compact:
 *   git: `youyee 3d`  (uncommitted: `you now`)
 *   svn: `youyee 3d`  (locally modified, no history: `local`)
 * Revision/hash & commit summary live in the hover tooltip instead.
 */
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

/** Palette slots for the gutter commit bands (colors live in devmode.css). */
export const BLAME_BAND_COUNT = 8;

/**
 * Palette slot per revision, handed out in first-appearance order so two
 * commit batches that touch neighbouring lines land on different colors.
 * Uncommitted revisions are left out — they get the dedicated "local" band.
 */
export function blameBandSlots(entries: BlameEntry[]): Map<string, number> {
  const slots = new Map<string, number>();
  for (const entry of entries) {
    if (isUncommitted(entry) || !entry.rev) continue;
    if (slots.has(entry.rev)) continue;
    slots.set(entry.rev, slots.size % BLAME_BAND_COUNT);
  }
  return slots;
}

/** Hover tooltips cap the commit body so a huge message can't blow up. */
const HOVER_BODY_MAX = 600;

/** Escape markdown-significant chars (hover value renders as markdown). */
function escapeMd(text: string): string {
  return text.replace(/([\\`*_\[\]])/g, "\\$1");
}

/**
 * Hover tooltip: head line (author · hash/rev · date) plus the commit
 * message — subject, then body paragraphs when present.
 */
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

/** Plain-text twin for the custom line-number tooltip (no markdown escapes). */
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
