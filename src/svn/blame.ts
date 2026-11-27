import { execSvn, execSvnWithAuth } from "./execSvn.js";
import type { BlameLine } from "../git/blame.js";

export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, digits: string) =>
      String.fromCodePoint(Number(digits)),
    )
    .replace(/&amp;/g, "&");
}

const LOG_MESSAGE_MAX = 1000;

export function parseSvnLogMessages(out: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /<logentry[^>]*revision="(\d+)"[^>]*>[\s\S]*?<msg[^>]*>([\s\S]*?)<\/msg>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    const message = decodeXmlEntities(m[2] ?? "").trim();
    if (!message) continue;
    map.set(
      m[1]!,
      message.length > LOG_MESSAGE_MAX
        ? `${message.slice(0, LOG_MESSAGE_MAX)}…`
        : message,
    );
  }
  return map;
}

export function parseSvnBlameXml(out: string): BlameLine[] {
  const entries: BlameLine[] = [];
  const entryRe = /<entry[^>]*line-number="(\d+)"[^>]*>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(out)) !== null) {
    const body = m[2] ?? "";
    const commit = body.match(/<commit[^>]*revision="([^"]*)"/);
    const author = body.match(/<author>([^<]*)<\/author>/);
    const date = body.match(/<date>([^<]*)<\/date>/);
    const time = date ? Date.parse(date[1]!.trim()) : NaN;
    entries.push({
      line: Number(m[1]!),
      rev: commit?.[1]?.trim() || "M",
      author: decodeXmlEntities(author?.[1] ?? "").trim(),
      time: Number.isFinite(time) ? Math.floor(time / 1000) : null,
      summary: null,
    });
  }
  return entries;
}

export async function svnBlame(
  cwd: string,
  relPath: string,
): Promise<BlameLine[]> {
  const res = await execSvnWithAuth(cwd, ["blame", "--xml", "--", relPath], {
    operation: "Annotate",
  });
  const entries = parseSvnBlameXml(res.stdout);
  const revs = entries
    .filter((e) => /^\d+$/.test(e.rev))
    .map((e) => Number(e.rev));
  if (revs.length > 0) {
    const min = revs.reduce((a, b) => Math.min(a, b));
    const max = revs.reduce((a, b) => Math.max(a, b));
    try {
      const log = await execSvnWithAuth(cwd, [
        "log",
        "--xml",
        "-r",
        `${max}:${min}`,
        "--limit",
        "1000",
        "--",
        relPath,
      ], { operation: "Annotate" });
      const messages = parseSvnLogMessages(log.stdout);
      for (const entry of entries) {
        const message = /^\d+$/.test(entry.rev)
          ? messages.get(entry.rev)
          : undefined;
        if (message) entry.summary = message;
      }
    } catch {
    }
  }
  return entries;
}
