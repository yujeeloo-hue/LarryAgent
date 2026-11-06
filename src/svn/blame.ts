/**
 * `svn blame --xml` for the Dev Mode Annotate feature.
 *
 * XML is used instead of the plain column format because the text output
 * pads the author column with run-length whitespace (fragile when authors
 * contain spaces); the XML shape is stable:
 *   <entry line-number="4"><commit revision="4">
 *     <author>harry</author><date>2020-01-01T…Z</date>
 *   </commit></entry>
 * Locally modified lines carry no <commit> child — mapped to rev "M".
 * Commit messages are not part of blame output; `svnBlame` fetches them
 * with one batched `svn log` over the revision span and fills `summary`.
 */
import { execSvn, execSvnWithAuth } from "./execSvn.js";
import type { BlameLine } from "../git/blame.js";

/** Decode the XML entities svn emits inside <author>/<msg>. */
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

/** Cap stored messages so a giant commit log can't bloat the tooltips. */
const LOG_MESSAGE_MAX = 1000;

/** Parse `svn log --xml` output into revision → message. */
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
  // Real svn (1.14, Windows) emits multi-line attributes:
  //   `<entry\n   line-number="1">` — so attribute order/whitespace must
  // stay flexible. Compact output from other builds matches the same regex.
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

/** Blame one file (WORKING) — throws SvnCommandError on failure. */
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
      // One log covering the whole revision span of this file's lines
      // (newest first). Unmatched revs simply keep no message.
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
      // hover falls back to rev/author/date only
    }
  }
  return entries;
}
