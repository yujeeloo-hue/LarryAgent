import { execGit } from "./execGit.js";

export type BlameLine = {
  line: number;
  rev: string;
  author: string;
  time: number | null;
  summary: string | null;
};

export function parseGitBlamePorcelain(out: string): BlameLine[] {
  const entries: BlameLine[] = [];
  let cur: BlameLine | null = null;
  for (const raw of out.split("\n")) {
    if (raw.startsWith("\t")) {
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
      }
    }),
  );
  return map;
}

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
