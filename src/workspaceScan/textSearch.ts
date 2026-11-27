import { spawn } from "node:child_process";
import { join } from "node:path";
import { execGit } from "../git/execGit.js";
import { ripgrepExcludeGlobs, type ScanRules } from "./policy.js";
import { resolveRipgrep } from "./ripgrep.js";
import { detectUnrealRoot } from "./scanFiles.js";

export type TextSearchRoot = {
  root: string;
  relPrefix?: string;
  unreal?: boolean;
  paths?: readonly string[];
  skipTopDirs?: ReadonlySet<string>;
};

export type TextSearchHit = {
  path: string;
  rel: string;
  line: number;
  column: number;
  preview: string;
};

export type TextSearchOutcome = {
  truncated: boolean;
  cancelled: boolean;
  error?: string;
};

export type TextSearchRequest = {
  roots: readonly TextSearchRoot[];
  query: string;
  maxResults?: number;
  maxPerFile?: number;
  signal?: AbortSignal;
  program?: string;
  onHits: (hits: TextSearchHit[]) => void;
};

const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_MAX_PER_FILE = 5;
const MAX_PREVIEW_CHARS = 240;
const FLUSH_EVERY = 40;

async function isGitWorkTree(root: string): Promise<boolean> {
  try {
    const { stdout } = await execGit(root, ["rev-parse", "--is-inside-work-tree"], {
      timeoutMs: 5_000,
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

function caseInsensitive(name: string): string {
  let out = "";
  for (const ch of name) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    out += lower === upper ? ch : `[${lower}${upper}]`;
  }
  return out;
}

export function ripgrepTextArgs(input: {
  query: string;
  rules: ScanRules;
  maxPerFile: number;
  skipTopDirs?: ReadonlySet<string>;
  paths: readonly string[];
}): string[] {
  const args = [
    "--json",
    "--fixed-strings",
    "--smart-case",
    "--hidden",
    "--no-messages",
    "--max-filesize",
    "1M",
    "--max-columns",
    "400",
    "--max-columns-preview",
    "--max-count",
    String(input.maxPerFile),
  ];
  if (input.rules.mode === "walk") args.push("--no-ignore-vcs", "--glob", "!**/.*/**");
  for (const glob of ripgrepExcludeGlobs(input.rules)) args.push("--glob", glob);
  for (const dir of input.skipTopDirs ?? []) args.push("--glob", `!/${caseInsensitive(dir)}/**`);
  args.push("--", input.query, ...input.paths);
  return args;
}

function charColumn(line: string, byteOffset: number): number {
  return Buffer.from(line, "utf8").subarray(0, byteOffset).toString("utf8").length + 1;
}

function clipPreview(line: string, column: number): string {
  const text = line.replace(/\r?\n$/, "");
  if (text.length <= MAX_PREVIEW_CHARS) return text.trim();
  const start = Math.max(0, column - 1 - Math.floor(MAX_PREVIEW_CHARS / 3));
  const slice = text.slice(start, start + MAX_PREVIEW_CHARS);
  return `${start > 0 ? "…" : ""}${slice.trim()}${start + MAX_PREVIEW_CHARS < text.length ? "…" : ""}`;
}

export function parseRipgrepMatch(
  line: string,
  root: TextSearchRoot,
): TextSearchHit | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  const record = event as {
    type?: string;
    data?: {
      path?: { text?: string };
      lines?: { text?: string };
      line_number?: number;
      submatches?: Array<{ start?: number }>;
    };
  };
  if (record.type !== "match" || !record.data) return null;
  const rawPath = record.data.path?.text;
  const text = record.data.lines?.text;
  const lineNumber = record.data.line_number;
  if (typeof rawPath !== "string" || typeof text !== "string" || typeof lineNumber !== "number") {
    return null;
  }
  const relInRoot = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const column = charColumn(text, record.data.submatches?.[0]?.start ?? 0);
  return {
    path: join(root.root, ...relInRoot.split("/")),
    rel: root.relPrefix ? `${root.relPrefix}/${relInRoot}` : relInRoot,
    line: lineNumber,
    column,
    preview: clipPreview(text, column),
  };
}

function runOne(input: {
  program: string;
  root: TextSearchRoot;
  args: string[];
  budget: () => number;
  signal: AbortSignal | undefined;
  emit: (hits: TextSearchHit[]) => void;
}): Promise<{ hitCap: boolean; error?: string }> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let hitCap = false;
    let matched = 0;
    let pending: TextSearchHit[] = [];
    let buffered = "";
    let stderr = "";
    const child = spawn(input.program, input.args, {
      cwd: input.root.root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const flush = (): void => {
      if (pending.length === 0) return;
      input.emit(pending);
      pending = [];
    };
    const finish = (result: { hitCap: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", onAbort);
      flush();
      resolvePromise(result);
    };
    const onAbort = (): void => {
      child.kill();
      finish({ hitCap });
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const hit = parseRipgrepMatch(line, input.root);
        if (hit) {
          if (input.budget() - pending.length <= 0) {
            hitCap = true;
            child.kill();
            finish({ hitCap });
            return;
          }
          pending.push(hit);
          matched++;
          if (pending.length >= FLUSH_EVERY) flush();
        }
        newline = buffered.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 2_000) stderr += chunk;
    });
    child.on("error", (err) => finish({ hitCap, error: err.message }));
    child.on("close", (code) => {
      if (code !== null && code > 1 && !hitCap && matched === 0) {
        finish({ hitCap, error: stderr.trim() || `ripgrep exited with code ${code}` });
        return;
      }
      finish({ hitCap });
    });
  });
}

export async function searchWorkspaceText(request: TextSearchRequest): Promise<TextSearchOutcome> {
  const query = request.query;
  if (!query.trim()) return { truncated: false, cancelled: false };
  const program = request.program ?? (await resolveRipgrep());
  const maxResults = request.maxResults ?? DEFAULT_MAX_RESULTS;
  let emitted = 0;
  for (const root of request.roots) {
    if (request.signal?.aborted) return { truncated: false, cancelled: true };
    const rules: ScanRules = {
      mode: (await isGitWorkTree(root.root)) ? "git" : "walk",
      unreal: root.unreal ?? detectUnrealRoot(root.root),
    };
    const paths = root.paths && root.paths.length > 0 ? [...root.paths] : ["."];
    const args = ripgrepTextArgs({
      query,
      rules,
      maxPerFile: request.maxPerFile ?? DEFAULT_MAX_PER_FILE,
      ...(root.skipTopDirs ? { skipTopDirs: root.skipTopDirs } : {}),
      paths,
    });
    const result = await runOne({
      program,
      root,
      args,
      budget: () => maxResults - emitted,
      signal: request.signal,
      emit: (hits) => {
        emitted += hits.length;
        request.onHits(hits);
      },
    });
    if (request.signal?.aborted) return { truncated: false, cancelled: true };
    if (result.error) return { truncated: result.hitCap, cancelled: false, error: result.error };
    if (result.hitCap || emitted >= maxResults) return { truncated: true, cancelled: false };
  }
  return { truncated: false, cancelled: false };
}
