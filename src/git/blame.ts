/**
 * `git blame --line-porcelain` for the Dev Mode Annotate feature.
 *
 * line-porcelain repeats the full header block (author/time/summary) for
 * EVERY line, which makes the parser trivial: a 40-hex header starts a
 * block, the `\t`-prefixed content line closes it.
 */
import { execGit } from "./execGit.js";

/** One annotated line — `rev` is the FULL hex (all-zero = uncommitted). */
export type BlameLine = {
  /** 1-based final-file line number. */
  line: number;
  /** Full commit hash; `0000…` for not-yet-committed lines. */
  rev: string;
  author: string;
  /** author-time in epoch seconds (null when absent). */
  time: number | null;
  /** Commit message — subject + body (null when absent/uncommitted). */
  summary: string | null;
};

export function parseGitBlamePorcelain(out: string): BlameLine[] {
  const entries: BlameLine[] = [];
  let cur: BlameLine | null = null;
  for (const raw of out.split("\n")) {
    if (raw.startsWith("\t")) {
      // Content line — the block is complete.
      if (cur) entries.push(cur);
      cur = null;
      continue;
    }
    const header = raw.match(/^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/);
    if (header) {
      cur = {
        line: Number(header[3]!),
        rev: header[1]!,
        author: "",
        time: null,
        summary: null,
      };
      continue;
    }
    if (!cur) continue;
    // NOTE: the trailing space keeps `author-mail` out of the match.
    if (raw.startsWith("author ")) cur.author = raw.slice(7).trim();
    else if (raw.startsWith("author-time ")) {
      const n = Number(raw.slice(12));
      cur.time = Number.isFinite(n) && n > 0 ? n : null;
    } else if (raw.startsWith("summary ")) {
      cur.summary = raw.slice(8).trim() || null;
    }
  }
  return entries;
}

// ------------------------------------------------------------- log messages

/** Parse `git log --format=%H%x1f%B%x1e` output into hash → message. */
export function parseGitCommitMessages(out: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const record of out.split("\x1e")) {
    const sep = record.indexOf("\x1f");
    if (sep < 0) continue;
    const hash = record.slice(0, sep).trim();
    const message = record.slice(sep + 1).trim();
    if (/^[0-9a-f]{40}$/.test(hash) && message) map.set(hash, message);
  }
  return map;
}

const GIT_LOG_CHUNK = 200;

/**
 * Full commit messages for a set of hashes, batched `git log --no-walk`
 * calls (one process per 200 hashes). Missing entries simply stay absent —
 * the hover falls back to the porcelain summary.
 */
export async function gitCommitMessages(
  cwd: string,
  hashes: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const uniq = [...new Set(hashes)].filter((h) => /^[0-9a-f]{40}$/.test(h));
  const chunks: string[][] = [];
  for (let i = 0; i < uniq.length; i += GIT_LOG_CHUNK) {
    chunks.push(uniq.slice(i, i + GIT_LOG_CHUNK));
  }
  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const res = await execGit(cwd, [
          "log",
          "--no-walk",
          "--format=%H%x1f%B%x1e",
          ...chunk,
        ]);
        for (const [hash, message] of parseGitCommitMessages(res.stdout)) {
          map.set(hash, message);
        }
      } catch {
        // partial history is fine — hover shows the subject only
      }
    }),
  );
  return map;
}

/** Blame one file (worktree content) — throws GitCommandError on failure. */
export async function gitBlame(
  cwd: string,
  relPath: string,
): Promise<BlameLine[]> {
  const res = await execGit(
    cwd,
    ["blame", "--line-porcelain", "--", relPath],
    { timeoutMs: 20_000 },
  );
  const entries = parseGitBlamePorcelain(res.stdout);
  const hashes = entries
    .filter((e) => !/^0+$/.test(e.rev))
    .map((e) => e.rev);
  if (hashes.length > 0) {
    const messages = await gitCommitMessages(cwd, hashes);
    for (const entry of entries) {
      const message = messages.get(entry.rev);
      if (message) entry.summary = message;
    }
  }
  return entries;
}
